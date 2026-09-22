import { Effect, Option, Schema } from "effect"
import type { NetworkHeader, NetworkMethod, SandboxCapabilities } from "../manifest"

/**
 * The capability firewall for marketplace package code.
 *
 * Package code runs in a sandboxed frame and can only send these data messages. This
 * module stays in Morph's trusted bundle and owns every privileged operation: it checks
 * each request against what the package's manifest declared, then calls a port.
 */
export interface CapabilityManifest {
  readonly slug: string
  readonly permissions: {
    readonly takeover?: SandboxCapabilities["takeover"]
    readonly page: {
      readonly read: ReadonlyArray<string>
      readonly navigate: ReadonlyArray<string>
      readonly traverse?: boolean
    }
    readonly network: ReadonlyArray<{
      readonly origin: string
      readonly paths: ReadonlyArray<string>
      readonly methods: ReadonlyArray<NetworkMethod>
      readonly credentials: "omit" | "include"
      readonly headers: ReadonlyArray<NetworkHeader>
    }>
    readonly storage: boolean
    readonly context?: SandboxCapabilities["context"]
    readonly assets?: ReadonlyArray<string>
    readonly secureForms: ReadonlyArray<string>
  }
}

const Accept = Schema.Literals(["application/json", "text/html"])
const NavigateTarget = Schema.Literals(["_self", "_blank"])

const CapabilityRequest = Schema.Union([
  Schema.Struct({ id: Schema.String, capability: Schema.Literals(["page.read"]), selector: Schema.String }),
  Schema.Struct({
    id: Schema.String,
    capability: Schema.Literals(["network.fetch"]),
    url: Schema.String,
    method: Schema.Literals(["GET", "POST"]),
    accept: Schema.optional(Accept),
    requestedWith: Schema.optional(Schema.Literal("XMLHttpRequest")),
    body: Schema.optional(Schema.String),
    contentType: Schema.optional(Schema.Literal("application/json")),
    verifiedFetch: Schema.optional(Schema.Boolean)
  }),
  Schema.Struct({
    id: Schema.String,
    capability: Schema.Literals(["page.navigate"]),
    url: Schema.String,
    target: Schema.optional(NavigateTarget)
  }),
  Schema.Struct({
    id: Schema.String,
    capability: Schema.Literals(["page.traverse"]),
    delta: Schema.Number
  }),
  Schema.Struct({ id: Schema.String, capability: Schema.Literals(["page.context"]) }),
  Schema.Struct({ id: Schema.String, capability: Schema.Literals(["page.restore"]) }),
  Schema.Struct({ id: Schema.String, capability: Schema.Literals(["assets.load"]), url: Schema.String }),
  Schema.Struct({ id: Schema.String, capability: Schema.Literals(["storage.get"]), key: Schema.String }),
  Schema.Struct({ id: Schema.String, capability: Schema.Literals(["storage.set"]), key: Schema.String, value: Schema.Unknown }),
  Schema.Struct({ id: Schema.String, capability: Schema.Literals(["secure.submit"]), form: Schema.String })
])

export type CapabilityRequest = typeof CapabilityRequest["Type"]

export type CapabilityResponse =
  | { readonly id: string; readonly ok: true; readonly value: unknown }
  | { readonly id: string; readonly ok: false; readonly error: string }

export class CapabilityPortFailure extends Schema.TaggedError<CapabilityPortFailure>()("CapabilityPortFailure", {
  message: Schema.String
}) {}

export interface FetchRequest {
  readonly url: string
  readonly method: NetworkMethod
  readonly accept: typeof Accept["Type"] | undefined
  readonly requestedWith: "XMLHttpRequest" | undefined
  readonly credentials: "omit" | "include"
  readonly body: string | undefined
  readonly contentType: "application/json" | undefined
  readonly verifiedFetch: boolean | undefined
}

export interface PageContext {
  readonly signedIn: boolean
  readonly login: string | undefined
  readonly faceUrl: string | undefined
  /** The page's own `data-color-mode`, for the package to resolve where it says `auto`. */
  readonly colorMode: "light" | "dark" | "auto"
  readonly path: string
}

export interface CapabilityPorts {
  readonly read: (selector: string) => Effect.Effect<unknown, CapabilityPortFailure>
  readonly fetch: (request: FetchRequest) => Effect.Effect<unknown, CapabilityPortFailure>
  readonly navigate: (url: string, target: "_self" | "_blank") => Effect.Effect<void, CapabilityPortFailure>
  readonly traverse: (delta: number) => Effect.Effect<void, CapabilityPortFailure>
  readonly context: () => Effect.Effect<PageContext, CapabilityPortFailure>
  readonly restore: () => Effect.Effect<void, CapabilityPortFailure>
  readonly loadAsset: (url: string) => Effect.Effect<string, CapabilityPortFailure>
  readonly storage: {
    readonly get: (key: string) => Effect.Effect<unknown, CapabilityPortFailure>
    readonly set: (key: string, value: unknown) => Effect.Effect<unknown, CapabilityPortFailure>
  }
  readonly secureSubmit: (form: string, fields: Readonly<Record<string, string>>) => Effect.Effect<void, CapabilityPortFailure>
}

const denied = (id: string, error: string): CapabilityResponse => ({ id, ok: false, error })
const allowed = (id: string, value: unknown = null): CapabilityResponse => ({ id, ok: true, value })

const keyOf = (slug: string, key: string): string => `morph-package:${slug}:${key}`

/**
 * How far one traversal may reach, in entries.
 *
 * Sixteen, against the eight a back menu offers: a reader picks a page they can see in
 * that menu, and twice the longest menu leaves room for a package that lists more
 * without leaving room for one that walks a tab out of the run it is in.
 */
const FURTHEST_STEP = 16

class CapabilityFailure extends Schema.TaggedError<CapabilityFailure>()("CapabilityFailure", {
  id: Schema.String,
  message: Schema.String
}) {}

const IdentifiedRequest = Schema.Struct({ id: Schema.String })
const decodeRequest = Schema.decodeUnknownEffect(CapabilityRequest, { onExcessProperty: "error" })

const idOf = (input: unknown): string =>
  Option.match(Schema.decodeUnknownOption(IdentifiedRequest)(input), {
    onNone: () => "",
    onSome: ({ id }) => id
  })

const urlOf = Effect.fn("sandbox.urlOf")(function* (id: string, url: string, message: string) {
  const parsed = yield* Effect.try({
    try: () => new URL(url),
    catch: () => new CapabilityFailure({ id, message })
  })
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return yield* new CapabilityFailure({ id, message })
  }
  return parsed
})

const pathMatches = (granted: string, actual: string): boolean => {
  if (granted === actual) return true
  if (!granted.includes("*")) return false
  const escaped = granted.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]+")
  return new RegExp(`^${escaped}$`).test(actual)
}

const withRequestId = <A>(id: string, effect: Effect.Effect<A, CapabilityPortFailure>): Effect.Effect<A, CapabilityFailure> =>
  effect.pipe(Effect.mapError(({ message }) => new CapabilityFailure({ id, message })))

export const capabilityFirewall = (manifest: CapabilityManifest, ports: CapabilityPorts) => {
  const run = Effect.fn("sandbox.capabilityFirewall")(
    function* (
      input: unknown,
      secureFields: Readonly<Record<string, string>> = {}
    ): Effect.fn.Return<CapabilityResponse, CapabilityFailure> {
      const id = idOf(input)
      const request = yield* decodeRequest(input).pipe(
        Effect.mapError(() => new CapabilityFailure({ id, message: "capability request is invalid" }))
      )
      switch (request.capability) {
        case "page.read":
          return manifest.permissions.page.read.includes(request.selector)
            ? allowed(request.id, yield* withRequestId(request.id, ports.read(request.selector)))
            : denied(request.id, "page selector is not declared")
        case "network.fetch": {
          const url = yield* urlOf(request.id, request.url, "network URL is invalid")
          const grant = manifest.permissions.network.find((candidate) => candidate.origin === url.origin)
          if (grant === undefined) return denied(request.id, "network origin is not declared")
          if (!grant.paths.some((path) => pathMatches(path, url.pathname))) return denied(request.id, "network path is not declared")
          if (!grant.methods.includes(request.method)) return denied(request.id, "network method is not allowed")
          if (request.accept !== undefined && !grant.headers.includes("Accept")) {
            return denied(request.id, "network header is not declared")
          }
          if (request.requestedWith !== undefined && !grant.headers.includes("X-Requested-With")) {
            return denied(request.id, "network header is not declared")
          }
          if (request.contentType !== undefined && !grant.headers.includes("Content-Type")) {
            return denied(request.id, "network header is not declared")
          }
          if (request.verifiedFetch && !grant.headers.includes("GitHub-Verified-Fetch")) {
            return denied(request.id, "network header is not declared")
          }
          if (request.method === "GET" && request.body !== undefined) {
            return denied(request.id, "network method is not allowed")
          }
          const fetched = ports.fetch({
            url: request.url,
            method: request.method,
            accept: request.accept,
            requestedWith: request.requestedWith,
            credentials: grant.credentials,
            body: request.body,
            contentType: request.contentType,
            verifiedFetch: request.verifiedFetch
          })
          return allowed(request.id, yield* withRequestId(request.id, fetched))
        }
        case "page.navigate": {
          const url = yield* urlOf(request.id, request.url, "navigation URL is invalid")
          if (!manifest.permissions.page.navigate.includes(url.origin)) return denied(request.id, "navigation origin is not declared")
          yield* withRequestId(request.id, ports.navigate(request.url, request.target ?? "_self"))
          return allowed(request.id)
        }
        case "page.traverse": {
          if (manifest.permissions.page.traverse !== true) return denied(request.id, "page traversal is not declared")
          if (!Number.isSafeInteger(request.delta) || request.delta === 0) {
            return denied(request.id, "traversal step is invalid")
          }
          if (Math.abs(request.delta) > FURTHEST_STEP) return denied(request.id, "traversal step is invalid")
          yield* withRequestId(request.id, ports.traverse(request.delta))
          return allowed(request.id)
        }
        case "page.context":
          if (manifest.permissions.context === undefined) return denied(request.id, "page context is not declared")
          return allowed(request.id, yield* withRequestId(request.id, ports.context()))
        case "page.restore":
          if (manifest.permissions.takeover === undefined) return denied(request.id, "page takeover is not declared")
          yield* withRequestId(request.id, ports.restore())
          return allowed(request.id)
        case "assets.load": {
          const url = yield* urlOf(request.id, request.url, "asset URL is invalid")
          if (url.protocol !== "https:") return denied(request.id, "asset URL is invalid")
          if (!(manifest.permissions.assets ?? []).includes(url.origin)) {
            return denied(request.id, "asset origin is not declared")
          }
          return allowed(request.id, yield* withRequestId(request.id, ports.loadAsset(request.url)))
        }
        case "storage.get":
          if (!manifest.permissions.storage) return denied(request.id, "storage is not declared")
          return allowed(request.id, yield* withRequestId(request.id, ports.storage.get(keyOf(manifest.slug, request.key))))
        case "storage.set":
          if (!manifest.permissions.storage) return denied(request.id, "storage is not declared")
          yield* withRequestId(request.id, ports.storage.set(keyOf(manifest.slug, request.key), request.value))
          return allowed(request.id)
        case "secure.submit":
          if (!manifest.permissions.secureForms.includes(request.form)) return denied(request.id, "secure form is not declared")
          yield* withRequestId(request.id, ports.secureSubmit(request.form, secureFields))
          return allowed(request.id)
      }
    },
    Effect.catch((cause) => Effect.succeed(denied(cause.id, cause.message)))
  )
  return run
}
