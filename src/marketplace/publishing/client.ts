import type { CompiledPackage } from "../compiler/compile"
import type { PackageSource } from "../compiler/source"
import type { ForkDraft, ForkRevision } from "../forks/model"
import {
  parseDeviceChallenge,
  parsePublisherToken,
  parseReleaseStatus
} from "./decode"

export interface DeviceChallenge {
  readonly deviceCode: string
  readonly userCode: string
  readonly verificationUri: string
  readonly expiresAt: string
  readonly intervalSeconds: number
}

export interface PublisherToken {
  readonly accessToken: string
  readonly expiresAt: string
  readonly scopes: ReadonlyArray<"publish">
}

export interface PublishPreview {
  readonly data: string
  readonly digest: string
}

export interface PublishMetadata {
  readonly name: string
  readonly slug: string
  readonly summary: string
  readonly version: string
  readonly before: PublishPreview
  readonly after: PublishPreview
  readonly approvePermissionWidening: boolean
}

/** The body `POST /v1/releases` reads: the metadata, with the two images under `previews`. */
interface ReleaseBody extends Omit<PublishMetadata, "before" | "after"> {
  readonly runtime: "sandbox-v1" | "script-v1"
  readonly license: string
  readonly compatibility: ForkDraft["parent"]["compatibility"]
  readonly scope: ForkDraft["scope"]
  readonly previews: { readonly before: PublishPreview; readonly after: PublishPreview }
}

interface DraftSubmission extends ReleaseBody {
  readonly draftId: string
  readonly parent: ForkDraft["parent"]
  readonly revision: ForkRevision
}

/** A sandbox fork as it publishes: its parent, and the capabilities it is held to. */
export interface PublishSubmission extends DraftSubmission {
  readonly runtime: "sandbox-v1"
  readonly parentCapabilities: ForkDraft["parentCapabilities"]
}

/**
 * A page fork as it publishes: its parent, and no capabilities on either side, because a
 * page package runs with the page's own power rather than inside a sandbox.
 */
export interface PageForkSubmission extends DraftSubmission {
  readonly runtime: "script-v1"
}

/**
 * A page redesign as it publishes: a root `script-v1` package, built by the extension from
 * the thread's applied code and the site's design, with the digests the server holds it to.
 */
export interface PageRelease {
  readonly scope: { readonly kind: "page"; readonly origin: string; readonly paths: ReadonlyArray<string> }
  readonly source: PackageSource
  readonly compiled: Pick<CompiledPackage, "sources" | "artifacts">
}

export interface PageReleaseMetadata extends PublishMetadata {
  readonly license: string
}

/** What a page package needs of the extension: the kit the skin script calls, and a Chrome with user scripts. */
export const PAGE_COMPATIBILITY = { kit: "^1.0.0", chrome: ">=120" } as const

export interface PageSubmission extends ReleaseBody {
  readonly runtime: "script-v1"
  readonly revision: {
    readonly source: PackageSource
    readonly compiled: Pick<CompiledPackage, "sources" | "artifacts">
    readonly permissions: { readonly added: ReadonlyArray<never>; readonly removed: ReadonlyArray<never> }
  }
}

export interface ReleaseStatus {
  readonly id: string
  readonly state:
    | "accepted"
    | "compiled"
    | "committed"
    | "verified"
    | "cataloged"
    | "completed"
  readonly slug: string
  readonly version: string
  readonly commit: string | null
  readonly receipt: string | null
  readonly retryable: boolean
  readonly error: string | null
}

export interface PublisherTokenMemory {
  readonly read: () => Promise<PublisherToken | undefined>
  readonly write: (token: PublisherToken | undefined) => Promise<void>
}

export interface PublisherClient {
  readonly token: () => Promise<PublisherToken | undefined>
  readonly signIn: () => Promise<PublisherToken>
  readonly publish: (
    draft: ForkDraft,
    metadata: PublishMetadata
  ) => Promise<ReleaseStatus>
  /** A page redesign as a new root package. */
  readonly publishPage: (release: PageRelease, metadata: PageReleaseMetadata) => Promise<ReleaseStatus>
  readonly status: (id: string) => Promise<ReleaseStatus>
  readonly revoke: () => Promise<void>
}

export interface PublisherPorts {
  readonly fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  readonly tokens: PublisherTokenMemory
  readonly open: (url: string) => Promise<void>
  readonly sleep: (milliseconds: number) => Promise<void>
  readonly now: () => Date
}

export class PublisherFailure extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

const responseJson = async (response: Response): Promise<Record<string, unknown>> => {
  const body = await response.json().catch(() => null)
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new PublisherFailure("invalid_response", "The marketplace returned an invalid response.")
  }
  return body as Record<string, unknown>
}

const requestError = (body: Record<string, unknown>, status: number): PublisherFailure =>
  new PublisherFailure(
    typeof body.error === "string" ? body.error : "request_failed",
    typeof body.message === "string"
      ? body.message
      : `The marketplace request failed (${status}).`
  )

const challengeOf = (body: Record<string, unknown>): DeviceChallenge => {
  const challenge = parseDeviceChallenge(body)
  if (challenge === undefined) {
    throw new PublisherFailure("invalid_response", "The marketplace returned an invalid sign-in challenge.")
  }
  return challenge
}

const tokenOf = (body: Record<string, unknown>): PublisherToken | undefined => {
  return parsePublisherToken(body)
}

const statusOf = (body: Record<string, unknown>): ReleaseStatus => {
  const status = parseReleaseStatus(body)
  if (status === undefined) {
    throw new PublisherFailure("invalid_response", "The marketplace returned an invalid release status.")
  }
  return status
}

export const memoryPublisherTokens = (): PublisherTokenMemory => {
  let current: PublisherToken | undefined
  return {
    read: async () => current,
    write: async (token) => {
      current = token
    }
  }
}

export const chromePublisherTokens = (): PublisherTokenMemory => ({
  read: async () => {
    const stored = await chrome.storage.local.get("marketplacePublisherToken")
    const token = stored.marketplacePublisherToken
    if (typeof token !== "object" || token === null) return undefined
    return tokenOf(token as Record<string, unknown>)
  },
  write: async (token) => {
    if (token === undefined) await chrome.storage.local.remove("marketplacePublisherToken")
    else await chrome.storage.local.set({ marketplacePublisherToken: token })
  }
})

export const createPublisherClient = (
  baseUrl: string,
  ports: PublisherPorts
): PublisherClient => {
  /**
   * Taken out of the ports object, never called as `ports.fetch(...)`. A service worker's
   * `fetch` refuses a call whose `this` is the ports object: it threw "Illegal invocation"
   * and took every release with it, after the reader had already confirmed one.
   */
  const { fetch: send } = ports
  const request = async (
    path: string,
    init: RequestInit = {},
    token?: PublisherToken
  ): Promise<Record<string, unknown>> => {
    const response = await send(`${baseUrl}${path}`, {
      ...init,
      headers: {
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(token === undefined ? {} : { Authorization: `Bearer ${token.accessToken}` }),
        ...init.headers
      }
    })
    const body = await responseJson(response)
    if (!response.ok) throw requestError(body, response.status)
    return body
  }

  const validToken = async (): Promise<PublisherToken | undefined> => {
    const token = await ports.tokens.read()
    if (token === undefined) return undefined
    if (new Date(token.expiresAt).getTime() <= ports.now().getTime()) {
      await ports.tokens.write(undefined)
      return undefined
    }
    return token
  }

  const signIn = async (): Promise<PublisherToken> => {
    const active = await validToken()
    if (active !== undefined) return active
    const challenge = challengeOf(
      await request("/v1/auth/device", {
        method: "POST",
        body: JSON.stringify({ scopes: ["publish"] })
      })
    )
    await ports.open(challenge.verificationUri)
    while (ports.now().getTime() < new Date(challenge.expiresAt).getTime()) {
      const response = await send(`${baseUrl}/v1/auth/device/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceCode: challenge.deviceCode })
      })
      const body = await responseJson(response)
      if (response.ok) {
        const token = tokenOf(body)
        if (token === undefined) {
          throw new PublisherFailure("invalid_response", "The marketplace returned an invalid access token.")
        }
        await ports.tokens.write(token)
        return token
      }
      if (body.error !== "authorization_pending" && body.error !== "slow_down") {
        throw requestError(body, response.status)
      }
      await ports.sleep(
        (challenge.intervalSeconds + (body.error === "slow_down" ? 5 : 0)) * 1_000
      )
    }
    throw new PublisherFailure("expired_device_code", "The GitHub sign-in code expired.")
  }

  const authenticated = async (): Promise<PublisherToken> =>
    (await validToken()) ?? signIn()

  /** One release request, signed in. A token the server no longer takes is forgotten. */
  const submit = async (body: PublishSubmission | PageForkSubmission | PageSubmission): Promise<ReleaseStatus> => {
    const token = await authenticated()
    try {
      return statusOf(await request("/v1/releases", { method: "POST", body: JSON.stringify(body) }, token))
    } catch (error) {
      if (error instanceof PublisherFailure && error.code === "invalid_token") {
        await ports.tokens.write(undefined)
      }
      throw error
    }
  }

  const bodyOf = ({ before, after, ...metadata }: PublishMetadata): Omit<ReleaseBody, "runtime" | "license" | "compatibility" | "scope"> => ({
    ...metadata,
    previews: { before, after }
  })

  return {
    token: validToken,
    signIn,
    publish: async (draft, metadata) => {
      const revision = draft.revisions.find((item) => item.id === draft.currentRevision)
      if (revision === undefined) throw new PublisherFailure("invalid_draft", "The local Morph revision is missing.")
      const common: DraftSubmission = {
        ...bodyOf(metadata),
        runtime: draft.runtime,
        draftId: draft.id,
        parent: draft.parent,
        license: draft.parent.license,
        compatibility: draft.parent.compatibility,
        scope: draft.scope,
        revision
      }
      return submit(
        draft.runtime === "script-v1"
          ? { ...common, runtime: "script-v1" }
          : { ...common, runtime: "sandbox-v1", parentCapabilities: draft.parentCapabilities }
      )
    },
    publishPage: async (release, { license, ...metadata }) =>
      submit({
        ...bodyOf({ ...metadata, approvePermissionWidening: false }),
        runtime: "script-v1",
        license,
        compatibility: PAGE_COMPATIBILITY,
        scope: release.scope,
        revision: { source: release.source, compiled: release.compiled, permissions: { added: [], removed: [] } }
      }),
    status: async (id) =>
      statusOf(await request(`/v1/releases/${encodeURIComponent(id)}`, {}, await authenticated())),
    revoke: async () => {
      const token = await validToken()
      if (token !== undefined) {
        await request("/v1/auth/token/revoke", { method: "POST" }, token).catch(() => {})
      }
      await ports.tokens.write(undefined)
    }
  }
}
