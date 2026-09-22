import {
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  Layer,
  ManagedRuntime,
  Match,
  Ref,
  Result,
  Schema,
  type Scope
} from "effect"
import {
  AllowedOrigin,
  type AllowedOrigin as AllowedOriginValue,
  ChromeExtensionOrigin,
  type ChromeExtensionOrigin as ExtensionOriginValue
} from "./environment"
import {
  type BridgeId,
  decodeBearerToken,
  decodeBridgeId,
  decodeInitializeParams,
  decodeJsonRpcRequest,
  decodeResumeSecret,
  decodeSocketInbound,
  encodeHealthResponse,
  encodeInitializeResult,
  encodeJsonRpcError,
  encodeJsonRpcSuccess,
  encodeSocketOutbound,
  type JsonRpcId,
  McpAccept,
  McpContentType,
  type Reconnection,
  type Registration,
  RelayMethodNotFoundError,
  RelayPanelClosedError,
  RelayProtocolError,
  type RelayRequestError,
  RelayRemoteError,
  RelayStartupError,
  RelayThreadNotFoundError,
  RelayTimeoutError,
  RelayUnauthorizedError,
  type ResumeSecret,
  SupportedProtocolVersion,
  type SocketOutbound,
  type SocketResponse
} from "./protocol"

const DEFAULT_REQUEST_TIMEOUT = Duration.seconds(30)
const DEFAULT_IDLE_TIMEOUT = Duration.minutes(5)
const DEFAULT_CLEANUP_INTERVAL = Duration.seconds(30)
const SERVER_IDLE_TIMEOUT_SECONDS = 120

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store"
}

const sendSocket = (
  socket: Bun.ServerWebSocket<SocketData>,
  message: SocketOutbound
): Effect.Effect<number, RelayProtocolError> =>
  Effect.try({
    try: () => socket.send(encodeSocketOutbound(message)),
    catch: () => new RelayProtocolError({ detail: "Could not send the WebSocket message" })
  })

interface SocketData {
  /**
   * The origin the MCP URL for this socket's bridge is minted from: the relay's public
   * name, not the origin the socket connected from. A cloud agent has to reach it, and
   * the extension's own `chrome-extension://` origin is not somewhere anything can call.
   */
  mintFrom: string
  bridgeId?: BridgeId
}

interface PendingRequest {
  readonly deferred: Deferred.Deferred<unknown, RelayRequestError>
}

interface RegisteredBridge {
  readonly bridgeId: BridgeId
  readonly token: ResumeSecret
}

interface Thread {
  readonly token: ResumeSecret
  readonly socket: Bun.ServerWebSocket<SocketData> | undefined
  readonly lastActivity: number
  readonly pending: ReadonlyMap<string, PendingRequest>
}

interface RegistryState {
  readonly sequence: number
  readonly threads: ReadonlyMap<BridgeId, Thread>
}

type ToolMethod = "tools/list" | "tools/call"

export interface RelayOptions {
  readonly port?: number
  readonly hostname?: string
  readonly requestTimeout?: Duration.Input
  readonly idleTimeout?: Duration.Input
  readonly cleanupInterval?: Duration.Input
  /** Exact browser origins allowed to POST `/mcp`. A call with no Origin is always allowed. */
  readonly allowedOrigins?: readonly AllowedOriginValue[]
  /** Exact extension origins allowed to open `/ws`. Empty accepts any well-formed one. */
  readonly extensionOrigins?: readonly ExtensionOriginValue[]
  /**
   * The public origin a cloud agent reaches this relay at. Required behind a TLS
   * terminator such as Railway, where the relay's own bound address is plain HTTP on a
   * private port. Unset, the relay hands out its own bound address, which is right for
   * local development and for tests.
   */
  readonly publicOrigin?: AllowedOriginValue | undefined
}

export interface RelayServer {
  /** Where the relay listens. */
  readonly url: string
  /** Where a cloud agent reaches it, which differs behind a TLS terminator. */
  readonly publicUrl: string
}

interface RelayRegistryShape {
  readonly authorize: (
    bridgeId: BridgeId,
    token: ResumeSecret
  ) => Effect.Effect<void, RelayThreadNotFoundError | RelayUnauthorizedError>
  readonly register: (
    registration: Registration,
    socket: Bun.ServerWebSocket<SocketData>
  ) => Effect.Effect<RegisteredBridge, RelayProtocolError>
  readonly reconnect: (
    reconnection: Reconnection,
    socket: Bun.ServerWebSocket<SocketData>
  ) => Effect.Effect<RegisteredBridge, RelayProtocolError>
  readonly respond: (
    response: SocketResponse,
    socket: Bun.ServerWebSocket<SocketData>
  ) => Effect.Effect<void>
  readonly disconnect: (socket: Bun.ServerWebSocket<SocketData>) => Effect.Effect<void>
  readonly request: (
    bridgeId: BridgeId,
    token: ResumeSecret,
    method: ToolMethod,
    params: unknown
  ) => Effect.Effect<unknown, RelayRequestError>
}

const replaceThread = (
  threads: ReadonlyMap<BridgeId, Thread>,
  bridgeId: BridgeId,
  thread: Thread
): ReadonlyMap<BridgeId, Thread> => new Map(threads).set(bridgeId, thread)

const socketOwnsBridge = (
  threads: ReadonlyMap<BridgeId, Thread>,
  socket: Bun.ServerWebSocket<SocketData>
): boolean => [...threads.values()].some((thread) => thread.socket === socket)

const removePending = (
  state: Ref.Ref<RegistryState>,
  bridgeId: BridgeId,
  requestId: string
) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    yield* Ref.update(state, (current) => {
      const thread = current.threads.get(bridgeId)
      if (thread === undefined || !thread.pending.has(requestId)) return current
      const pending = new Map(thread.pending)
      pending.delete(requestId)
      return {
        ...current,
        threads: replaceThread(current.threads, bridgeId, {
          ...thread,
          lastActivity: now,
          pending
        })
      }
    })
  })

const makeRelayRegistry = (options: RelayOptions) =>
  Effect.gen(function* () {
    const requestTimeout = options.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT
    const idleTimeoutMs = Duration.toMillis(options.idleTimeout ?? DEFAULT_IDLE_TIMEOUT)
    const cleanupInterval = options.cleanupInterval ?? DEFAULT_CLEANUP_INTERVAL
    const state = yield* Ref.make<RegistryState>({ sequence: 0, threads: new Map() })

    const authorize: RelayRegistryShape["authorize"] = Effect.fn("RelayRegistry.authorize")(
      function* (bridgeId, token) {
        const thread = (yield* Ref.get(state)).threads.get(bridgeId)
        if (thread === undefined) return yield* new RelayThreadNotFoundError()
        if (thread.token !== token) return yield* new RelayUnauthorizedError()
      }
    )

    const register: RelayRegistryShape["register"] = Effect.fn("RelayRegistry.register")(
      function* (_registration, socket) {
        const now = yield* Clock.currentTimeMillis
        const bridgeId = yield* decodeBridgeId(crypto.randomUUID())
        const token = yield* decodeResumeSecret(crypto.randomUUID())
        const registrationResult = yield* Ref.modify<
          RegistryState,
          Result.Result<void, RelayProtocolError>
        >(state, (current) => {
          if (socketOwnsBridge(current.threads, socket)) {
            return [
              Result.fail(new RelayProtocolError({ detail: "Socket already owns a bridge" })),
              current
            ] as const
          }
          if (current.threads.has(bridgeId)) {
            return [
              Result.fail(new RelayProtocolError({ detail: "Could not mint a unique bridge id" })),
              current
            ] as const
          }
          const thread: Thread = {
            token,
            socket,
            lastActivity: now,
            pending: new Map()
          }
          return [
            Result.succeed(undefined),
            {
              ...current,
              threads: replaceThread(current.threads, bridgeId, thread)
            }
          ] as const
        })
        yield* Effect.fromResult(registrationResult)
        return { bridgeId, token }
      }
    )

    const reconnect: RelayRegistryShape["reconnect"] = Effect.fn("RelayRegistry.reconnect")(
      function* (reconnection, socket) {
        const now = yield* Clock.currentTimeMillis
        const reconnectResult = yield* Ref.modify<
          RegistryState,
          Result.Result<
            {
              readonly pending: readonly PendingRequest[]
              readonly previousSocket: Bun.ServerWebSocket<SocketData> | undefined
            },
            RelayProtocolError
          >
        >(state, (current) => {
          if (socketOwnsBridge(current.threads, socket)) {
            return [
              Result.fail(new RelayProtocolError({ detail: "Socket already owns a bridge" })),
              current
            ] as const
          }
          const existing = current.threads.get(reconnection.bridgeId)
          if (existing === undefined) {
            return [
              Result.fail(new RelayProtocolError({ detail: "Bridge does not exist" })),
              current
            ] as const
          }
          if (existing.token !== reconnection.token) {
            return [
              Result.fail(new RelayProtocolError({ detail: "Bridge token does not match" })),
              current
            ] as const
          }
          return [
            Result.succeed({
              pending: [...existing.pending.values()],
              previousSocket: existing.socket
            }),
            {
              ...current,
              threads: replaceThread(current.threads, reconnection.bridgeId, {
                ...existing,
                socket,
                lastActivity: now,
                pending: new Map()
              })
            }
          ] as const
        })
        const replaced = yield* Effect.fromResult(reconnectResult)
        yield* Effect.forEach(
          replaced.pending,
          (request) => Deferred.fail(request.deferred, new RelayPanelClosedError()),
          { discard: true }
        )
        if (replaced.previousSocket !== undefined && replaced.previousSocket !== socket) {
          replaced.previousSocket.close(1000, "Bridge registered on another socket")
        }
        return { bridgeId: reconnection.bridgeId, token: reconnection.token }
      }
    )

    const respond: RelayRegistryShape["respond"] = Effect.fn("RelayRegistry.respond")(
      function* (response, socket) {
        const bridgeId = socket.data.bridgeId
        if (bridgeId === undefined) return
        const now = yield* Clock.currentTimeMillis
        const pending = yield* Ref.modify(state, (current) => {
          const thread = current.threads.get(bridgeId)
          if (thread?.socket !== socket) return [undefined, current] as const
          const found = thread.pending.get(response.id)
          if (found === undefined) return [undefined, current] as const
          const nextPending = new Map(thread.pending)
          nextPending.delete(response.id)
          return [
            found,
            {
              ...current,
              threads: replaceThread(current.threads, bridgeId, {
                ...thread,
                lastActivity: now,
                pending: nextPending
              })
            }
          ] as const
        })
        if (pending === undefined) return
        yield* "error" in response
          ? Deferred.fail(pending.deferred, new RelayRemoteError({ detail: response.error.message }))
          : Deferred.succeed(pending.deferred, response.result)
      }
    )

    const disconnect: RelayRegistryShape["disconnect"] = Effect.fn("RelayRegistry.disconnect")(
      function* (socket) {
        const now = yield* Clock.currentTimeMillis
        const pending = yield* Ref.modify(state, (current) => {
          const bridgeId =
            socket.data.bridgeId ??
            [...current.threads].find(([, thread]) => thread.socket === socket)?.[0]
          if (bridgeId === undefined) return [[], current] as const
          const thread = current.threads.get(bridgeId)
          if (thread?.socket !== socket) return [[], current] as const
          return [
            [...thread.pending.values()],
            {
              ...current,
              threads: replaceThread(current.threads, bridgeId, {
                ...thread,
                socket: undefined,
                lastActivity: now,
                pending: new Map()
              })
            }
          ] as const
        })
        yield* Effect.forEach(
          pending,
          (request) => Deferred.fail(request.deferred, new RelayPanelClosedError()),
          { discard: true }
        )
      }
    )

    const request: RelayRegistryShape["request"] = Effect.fn("RelayRegistry.request")(
      function* (bridgeId, token, method, params) {
        const now = yield* Clock.currentTimeMillis
        const deferred = yield* Deferred.make<unknown, RelayRequestError>()
        const preparedResult = yield* Ref.modify<
          RegistryState,
          Result.Result<
            { readonly id: string; readonly socket: Bun.ServerWebSocket<SocketData> },
            RelayThreadNotFoundError | RelayUnauthorizedError | RelayPanelClosedError
          >
        >(state, (current) => {
          const thread = current.threads.get(bridgeId)
          if (thread === undefined) {
            return [Result.fail(new RelayThreadNotFoundError()), current] as const
          }
          if (thread.token !== token) {
            return [Result.fail(new RelayUnauthorizedError()), current] as const
          }
          if (thread.socket === undefined || thread.socket.readyState !== WebSocket.OPEN) {
            return [Result.fail(new RelayPanelClosedError()), current] as const
          }
          const id = String(current.sequence + 1)
          return [
            Result.succeed({ id, socket: thread.socket }),
            {
              sequence: current.sequence + 1,
              threads: replaceThread(current.threads, bridgeId, {
                ...thread,
                lastActivity: now,
                pending: new Map(thread.pending).set(id, { deferred })
              })
            }
          ] as const
        })
        const { id, socket } = yield* Effect.fromResult(preparedResult)
        return yield* Effect.try({
          try: () => socket.send(encodeSocketOutbound({ type: "request", id, method, params })),
          catch: () => new RelayPanelClosedError()
        }).pipe(
          Effect.andThen(Deferred.await(deferred)),
          Effect.timeout(requestTimeout),
          Effect.catchTag("TimeoutError", () => new RelayTimeoutError()),
          Effect.ensuring(removePending(state, bridgeId, id))
        )
      }
    )

    const cleanup = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      yield* Ref.update(state, (current) => {
        const cutoff = now - idleTimeoutMs
        return {
          ...current,
          threads: new Map(
            [...current.threads].filter(
              ([, thread]) =>
                thread.socket !== undefined || thread.pending.size > 0 || thread.lastActivity > cutoff
            )
          )
        }
      })
    })
    yield* Effect.forever(Effect.sleep(cleanupInterval).pipe(Effect.andThen(cleanup))).pipe(
      Effect.forkScoped
    )

    return RelayRegistry.of({ authorize, register, reconnect, respond, disconnect, request })
  })

export class RelayRegistry extends Context.Service<RelayRegistry, RelayRegistryShape>()(
  "morph/relay/RelayRegistry"
) {
  static readonly layer = (options: RelayOptions = {}): Layer.Layer<RelayRegistry> =>
    Layer.effect(RelayRegistry)(makeRelayRegistry(options))
}

const requestErrorCode = (error: RelayRequestError): number =>
  Match.value(error).pipe(
    Match.tag("RelayUnauthorizedError", () => -32001),
    Match.tag("RelayPanelClosedError", () => -32002),
    Match.tag("RelayTimeoutError", () => -32003),
    Match.tag("RelayThreadNotFoundError", () => -32004),
    Match.tag("RelayRemoteError", () => -32000),
    Match.tag("RelayMethodNotFoundError", () => -32601),
    Match.tag("RelayProtocolError", () => -32700),
    Match.exhaustive
  )

const jsonResponse = (body: unknown): Response => Response.json(body, { headers: JSON_HEADERS })

const rpcSuccess = (id: JsonRpcId | undefined, result: unknown): Response =>
  jsonResponse(encodeJsonRpcSuccess({ jsonrpc: "2.0", id: id ?? null, result }))

const rpcError = (id: JsonRpcId | undefined, error: RelayRequestError): Response =>
  jsonResponse(
    encodeJsonRpcError({
      jsonrpc: "2.0",
      id: id ?? null,
      error: { code: requestErrorCode(error), message: error.message }
    })
  )

const decodeRequestBody = Effect.fn("RelayHttp.decodeRequestBody")(function* (request: Request) {
  const value = yield* Effect.tryPromise({
    try: () => request.json(),
    catch: () => new RelayProtocolError({ detail: "Invalid JSON-RPC request" })
  })
  return yield* decodeJsonRpcRequest(value)
})

const mcpMediaTypeError = (request: Request): Response | undefined => {
  if (!Schema.is(McpContentType)(request.headers.get("content-type"))) {
    return new Response("Content-Type must be application/json", { status: 415 })
  }
  if (!Schema.is(McpAccept)(request.headers.get("accept"))) {
    return new Response("Accept must include application/json and text/event-stream", { status: 406 })
  }
}

const configured = (
  origin: string,
  allowedOrigins: readonly AllowedOriginValue[]
): boolean => Schema.is(AllowedOrigin)(origin) && allowedOrigins.includes(origin)

/**
 * Who may POST an MCP call.
 *
 * Cursor's backend calls this endpoint server to server, and a server sends no `Origin`.
 * A browser always sends one, so a present `Origin` is only ever a browser, and only the
 * exact origins the operator configured are let through. The bearer token still decides
 * whether the call reaches a bridge; this only keeps arbitrary pages from trying.
 */
const mcpOriginAllowed = (
  origin: string | null,
  allowedOrigins: readonly AllowedOriginValue[]
): boolean => origin === null || configured(origin, allowedOrigins)

/**
 * Who may open the relay socket.
 *
 * Morph's extension, and nothing else. A configured extension allowlist names the exact
 * ids; with none configured, any well-formed extension id may register its own bridge.
 */
const socketOriginAllowed = (
  origin: string | null,
  allowedOrigins: readonly AllowedOriginValue[],
  extensionOrigins: readonly ExtensionOriginValue[]
): boolean => {
  if (origin === null) return false
  if (configured(origin, allowedOrigins)) return true
  if (!Schema.is(ChromeExtensionOrigin)(origin)) return false
  return extensionOrigins.length === 0 || extensionOrigins.includes(origin)
}

const forbiddenOriginResponse = (): Response => new Response("Origin not allowed", { status: 403 })

/**
 * The address the relay answers on, as the relay itself knows it. Never a request header:
 * `Host` and the `X-Forwarded-*` family are attacker-chosen, and this string is handed to
 * a cloud agent as the URL it will call back through.
 */
const boundOrigin = (server: {
  readonly hostname?: string | undefined
  readonly port?: number | undefined
}): string => {
  const hostname = server.hostname ?? "127.0.0.1"
  return `http://${hostname === "0.0.0.0" ? "127.0.0.1" : hostname}:${server.port ?? 0}`
}

const handleMcp = Effect.fn("RelayHttp.handleMcp")(function* (
  request: Request,
  encodedBridgeId: string
) {
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { Allow: "POST" } })
  }
  const mediaTypeError = mcpMediaTypeError(request)
  if (mediaTypeError !== undefined) return mediaTypeError

  const rpc = yield* decodeRequestBody(request)
  const registry = yield* RelayRegistry

  return yield* Effect.gen(function* () {
    const bridgeId = yield* Effect.try({
      try: () => decodeURIComponent(encodedBridgeId),
      catch: () => new RelayProtocolError({ detail: "Invalid bridge id" })
    }).pipe(Effect.flatMap(decodeBridgeId))
    const token = yield* decodeBearerToken(request.headers.get("authorization"))
    yield* registry.authorize(bridgeId, token)
    if (rpc.method === "initialize") {
      const params = yield* decodeInitializeParams(rpc.params)
      return rpcSuccess(
        rpc.id,
        encodeInitializeResult({
          protocolVersion: Schema.is(SupportedProtocolVersion)(params.protocolVersion)
            ? params.protocolVersion
            : "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "morph-relay", version: "1.0.0" }
        })
      )
    }
    if (rpc.method === "ping") return rpcSuccess(rpc.id, {})
    if (rpc.method === "notifications/initialized" && rpc.id === undefined) {
      return new Response(null, { status: 202 })
    }
    if (rpc.method !== "tools/list" && rpc.method !== "tools/call") {
      return yield* new RelayMethodNotFoundError()
    }
    return rpcSuccess(rpc.id, yield* registry.request(bridgeId, token, rpc.method, rpc.params ?? {}))
  }).pipe(Effect.catch((error) => Effect.succeed(rpcError(rpc.id, error))))
})

const handleRequest = Effect.fn("RelayHttp.handleRequest")(function* (request: Request) {
  const url = new URL(request.url)
  if (url.pathname === "/health" && request.method === "GET") {
    return jsonResponse(encodeHealthResponse({ status: "ok" }))
  }
  const match = /^\/mcp\/([^/]+)$/.exec(url.pathname)
  if (match?.[1] !== undefined) return yield* handleMcp(request, match[1])
  return new Response("Not found", { status: 404 })
})

const safeHandleRequest = (request: Request) =>
  handleRequest(request).pipe(
    Effect.catch((error) => Effect.succeed(rpcError(undefined, error))),
    Effect.catchCause(() =>
      Effect.succeed(
        rpcError(undefined, new RelayProtocolError({ detail: "Internal relay error" }))
      )
    )
  )

export const serveRelay = (
  options: RelayOptions = {}
): Effect.Effect<RelayServer, RelayStartupError, Scope.Scope> =>
  Effect.gen(function* () {
    const runtime = yield* Effect.acquireRelease(
      Effect.sync(() => ManagedRuntime.make(RelayRegistry.layer(options))),
      (runtime) => runtime.disposeEffect
    )
    const server = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          Bun.serve<SocketData>({
            port: options.port ?? 3000,
            hostname: options.hostname,
            idleTimeout: SERVER_IDLE_TIMEOUT_SECONDS,
            fetch(request, server) {
              const url = new URL(request.url)
              const origin = request.headers.get("origin")
              if (url.pathname === "/ws") {
                if (
                  !socketOriginAllowed(
                    origin,
                    options.allowedOrigins ?? [],
                    options.extensionOrigins ?? []
                  )
                ) {
                  return forbiddenOriginResponse()
                }
                const upgraded = server.upgrade(request, {
                  data: { mintFrom: options.publicOrigin ?? boundOrigin(server) }
                })
                return upgraded ? undefined : new Response("WebSocket upgrade required", { status: 426 })
              }
              if (!mcpOriginAllowed(origin, options.allowedOrigins ?? [])) {
                return forbiddenOriginResponse()
              }
              return runtime.runPromise(safeHandleRequest(request))
            },
            websocket: {
              message(socket, rawMessage) {
                const text =
                  typeof rawMessage === "string" ? rawMessage : new TextDecoder().decode(rawMessage)
                runtime.runFork(
                  decodeSocketInbound(text).pipe(
                    Effect.flatMap((message) =>
                      // A keepalive, never a registration: the bridge this socket owns
                      // stays exactly as it was.
                      message.type === "ping"
                        ? Effect.asVoid(sendSocket(socket, { type: "pong" }))
                        : RelayRegistry.use((registry) =>
                            message.type === "response"
                              ? registry.respond(message, socket)
                              : Effect.gen(function* () {
                                  if (socket.data.bridgeId !== undefined) {
                                    return yield* new RelayProtocolError({
                                      detail: "Socket already owns a bridge"
                                    })
                                  }
                                  const registered = yield* (
                                    message.type === "register"
                                      ? registry.register(message, socket)
                                      : registry.reconnect(message, socket)
                                  )
                                  yield* Effect.sync(() => {
                                    socket.data.bridgeId = registered.bridgeId
                                  })
                                  yield* sendSocket(socket, {
                                    type: "registered",
                                    bridgeId: registered.bridgeId,
                                    token: registered.token,
                                    mcpUrl: `${socket.data.mintFrom}/mcp/${encodeURIComponent(registered.bridgeId)}`
                                  })
                                })
                          )
                    ),
                    Effect.catch((error) =>
                      sendSocket(socket, {
                        type: "error",
                        error: error.message
                      }).pipe(Effect.ignore)
                    )
                  )
                )
              },
              close(socket) {
                runtime.runFork(RelayRegistry.use((registry) => registry.disconnect(socket)))
              }
            }
          }),
        catch: () => new RelayStartupError({ detail: "Could not start the relay server" })
      }),
      (server) => Effect.sync(() => server.stop(true))
    )
    // The address to connect to, which is not always the address to call back through.
    const bound = boundOrigin(server)
    return { url: bound, publicUrl: options.publicOrigin ?? bound }
  })

export const relayServerLayer = (options: RelayOptions = {}): Layer.Layer<never, RelayStartupError> =>
  Layer.effectDiscard(serveRelay(options))
