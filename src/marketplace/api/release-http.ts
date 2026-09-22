import type { DeviceAuth } from "./auth"
import { authenticatePublisher } from "./auth-http"
import { checkPageSource } from "../compiler/page"
import { checkSource, type PackageSource } from "../compiler/source"
import { parseSandboxCapabilities } from "../manifest"
import {
  PACKAGE_REPOSITORY,
  type ReleasePublisher,
  type ReleaseResult,
  type ReleaseRun,
  type ReleaseSubmission
} from "./publishing"
import type { ReleaseKind } from "./release-content"

export type ReleaseWebSession = (
  request: Request
) => Promise<{ readonly id: string; readonly handle: string } | null>

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Content-Type": "application/json; charset=utf-8"
} as const

const json = (value: unknown, status = 200): Response =>
  Response.json(value, { status, headers })

const decodedSegment = (value: string | undefined): string | null => {
  try {
    return decodeURIComponent(value ?? "")
  } catch {
    return null
  }
}

const MAX_RELEASE_REQUEST_BYTES = 3_000_000

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null

const strings = (value: unknown): ReadonlyArray<string> | null =>
  Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : null

const stringRecord = (
  value: unknown
): Readonly<Record<string, string>> | null => {
  const item = record(value)
  if (item === null) return null
  const parsed: Record<string, string> = {}
  for (const [key, entry] of Object.entries(item)) {
    if (typeof entry !== "string") return null
    parsed[key] = entry
  }
  return parsed
}

/**
 * The runtime half of a submission, checked by runtime. A sandbox fork names its parent
 * and its capabilities and its source passes the sandbox contract; a page package names
 * no capabilities and its source passes the page contract, and it names a parent only
 * when it is a fork of one. A body that mixes the two is refused. A body without a
 * runtime is from a client that only knew sandbox forks.
 */
const kindOf = (input: Record<string, unknown>, revision: Record<string, unknown>, source: PackageSource): ReleaseKind | null => {
  const runtime = input.runtime ?? "sandbox-v1"
  const parent = record(input.parent)
  try {
    const named =
      parent === null || typeof parent.slug !== "string" || typeof parent.version !== "string" || typeof parent.commit !== "string"
        ? null
        : { slug: parent.slug, version: parent.version, commit: parent.commit }
    if (runtime === "script-v1") {
      if (revision.capabilities !== undefined) return null
      if (input.parent !== undefined && named === null) return null
      checkPageSource(source)
      return named === null ? { runtime } : { runtime, parent: named }
    }
    if (runtime !== "sandbox-v1") return null
    if (named === null) return null
    checkSource(source)
    return { runtime, capabilities: parseSandboxCapabilities(revision.capabilities), parent: named }
  } catch {
    return null
  }
}

const inputOf = (
  value: unknown,
  user: { readonly userId: string; readonly handle: string }
): ReleaseSubmission | null => {
  const input = record(value)
  const revision = record(input?.revision)
  const compiled = record(revision?.compiled)
  const source = record(revision?.source)
  const permissions = record(revision?.permissions)
  const previews = record(input?.previews)
  const before = record(previews?.before)
  const after = record(previews?.after)
  const compatibility = record(input?.compatibility)
  const scope = record(input?.scope)
  const sourceFiles = stringRecord(source?.files)
  const sources = stringRecord(compiled?.sources)
  const artifacts = record(compiled?.artifacts)
  const added = strings(permissions?.added)
  const removed = strings(permissions?.removed)
  const paths = strings(scope?.paths)
  const slug = input?.slug
  if (
    typeof slug !== "string" ||
    !new RegExp(`^${user.handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/[a-z0-9][a-z0-9-]{0,62}$`, "i").test(slug) ||
    typeof input?.version !== "string" ||
    typeof input.name !== "string" ||
    typeof input.summary !== "string" ||
    typeof input.license !== "string" ||
    scope === null ||
    (scope.kind !== "page" && scope.kind !== "site") ||
    typeof scope.origin !== "string" ||
    paths === null ||
    compatibility === null ||
    typeof compatibility.kit !== "string" ||
    typeof compatibility.chrome !== "string" ||
    revision === null ||
    source === null ||
    compiled === null ||
    permissions === null ||
    previews === null ||
    before === null ||
    typeof before.data !== "string" ||
    typeof before.digest !== "string" ||
    after === null ||
    typeof after.data !== "string" ||
    typeof after.digest !== "string" ||
    typeof source.entry !== "string" ||
    typeof source.style !== "string" ||
    sourceFiles === null ||
    sources === null ||
    artifacts === null ||
    typeof artifacts.script !== "string" ||
    typeof artifacts.css !== "string" ||
    added === null ||
    removed === null ||
    typeof input.approvePermissionWidening !== "boolean"
  ) {
    return null
  }
  const kind = kindOf(input, revision, { entry: source.entry, style: source.style, files: sourceFiles })
  if (kind === null) return null
  return {
    ...kind,
    ownerId: user.userId,
    slug,
    version: input.version,
    name: input.name,
    summary: input.summary,
    license: input.license,
    scope: { kind: scope.kind, origin: scope.origin, paths },
    compatibility: {
      kit: compatibility.kit,
      chrome: compatibility.chrome
    },
    source: {
      entry: source.entry,
      style: source.style,
      files: sourceFiles
    },
    sources,
    artifacts: { script: artifacts.script, css: artifacts.css },
    previews: {
      before: { data: before.data, digest: before.digest },
      after: { data: after.data, digest: after.digest }
    },
    approvedPermissions: input.approvePermissionWidening
      ? added
      : []
  }
}

const statusOf = (run: ReleaseRun) => ({
  id: run.contentKey,
  state: run.stage,
  slug: run.content.slug,
  version: run.content.version,
  commit: run.commit,
  receipt: run.receipt,
  retryable: run.error?.retryable ?? false,
  error: run.error?.code ?? null,
  sourceUrl:
    run.commit === null || run.path === null
      ? null
      : `https://github.com/${PACKAGE_REPOSITORY}/tree/${run.commit}/${run.path}`
})

const resultOf = (result: ReleaseResult): Response => {
  if (result.status === "completed") return json(statusOf(result.run), 201)
  if (result.run === null) {
    return json({ error: result.code, message: result.message }, 400)
  }
  return json({
    ...statusOf(result.run),
    retryable: result.retryable,
    error: result.code
  })
}

export const releaseApi =
  (
    auth: DeviceAuth,
    publisher: ReleasePublisher,
    webSession: ReleaseWebSession
  ) =>
  async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url)
    if (request.method === "OPTIONS" && url.pathname.startsWith("/v1/releases")) {
      return new Response(null, { status: 204, headers })
    }
    const createsRelease =
      request.method === "POST" && url.pathname === "/v1/releases"
    const statusMatch =
      request.method === "GET"
        ? /^\/v1\/releases\/([^/]+)$/.exec(url.pathname)
        : null
    const publicMatch =
      request.method === "GET"
        ? /^\/v1\/releases\/([^/]+)\/public$/.exec(url.pathname)
        : null
    const retryMatch =
      request.method === "POST"
        ? /^\/v1\/releases\/([^/]+)\/retry$/.exec(url.pathname)
        : null
    if (
      !createsRelease &&
      statusMatch === null &&
      publicMatch === null &&
      retryMatch === null
    ) {
      return null
    }

    if (publicMatch !== null || retryMatch !== null) {
      const session = await webSession(request)
      if (session === null) return json({ error: "invalid_session" }, 401)
      const match = publicMatch ?? retryMatch
      const contentKey = decodedSegment(match?.[1])
      if (contentKey === null) return json({ error: "not_found" }, 404)
      const current = await publisher.status(contentKey)
      if (current === null || current.ownerId !== session.id) {
        return json({ error: "not_found" }, 404)
      }
      return publicMatch !== null
        ? json(statusOf(current))
        : resultOf(await publisher.resume(contentKey))
    }

    const user = await authenticatePublisher(auth, request)
    if (user instanceof Response) return user
    if (createsRelease) {
      const contentLength = Number(request.headers.get("content-length"))
      if (Number.isFinite(contentLength) && contentLength > MAX_RELEASE_REQUEST_BYTES) {
        return json({ error: "release_too_large" }, 413)
      }
      const text = await request.text()
      if (new TextEncoder().encode(text).byteLength > MAX_RELEASE_REQUEST_BYTES) {
        return json({ error: "release_too_large" }, 413)
      }
      const input = inputOf((() => {
        try {
          return JSON.parse(text) as unknown
        } catch {
          return null
        }
      })(), user)
      if (input === null) return json({ error: "invalid_release" }, 400)
      return resultOf(await publisher.publish(input))
    }
    if (statusMatch !== null) {
      const contentKey = decodedSegment(statusMatch[1])
      if (contentKey === null) return json({ error: "not_found" }, 404)
      const run = await publisher.status(contentKey)
      return run === null
        ? json({ error: "not_found" }, 404)
        : json(statusOf(run))
    }
    return null
  }
