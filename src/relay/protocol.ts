import { Effect, Schema } from "effect"

export const JsonRpcId = Schema.Union([Schema.String, Schema.Number, Schema.Null])
export type JsonRpcId = typeof JsonRpcId.Type

export const JsonRpcRequest = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.optionalKey(JsonRpcId),
  method: Schema.String,
  params: Schema.optionalKey(Schema.Unknown)
})
export type JsonRpcRequest = typeof JsonRpcRequest.Type

const JsonRpcSuccess = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: JsonRpcId,
  result: Schema.Unknown
})

const JsonRpcError = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: JsonRpcId,
  error: Schema.Struct({
    code: Schema.Number,
    message: Schema.String
  })
})

export const encodeJsonRpcSuccess = Schema.encodeSync(JsonRpcSuccess)
export const encodeJsonRpcError = Schema.encodeSync(JsonRpcError)

export const HealthResponse = Schema.Struct({
  status: Schema.Literal("ok")
})
export const encodeHealthResponse = Schema.encodeSync(HealthResponse)

export const SupportedProtocolVersion = Schema.Literals([
  "2025-06-18",
  "2025-03-26",
  "2024-11-05"
])

export const InitializeParams = Schema.Struct({
  protocolVersion: Schema.String,
  capabilities: Schema.Unknown,
  clientInfo: Schema.Struct({
    name: Schema.String,
    version: Schema.String
  })
})

export const InitializeResult = Schema.Struct({
  protocolVersion: Schema.String,
  capabilities: Schema.Struct({
    tools: Schema.Struct({
      listChanged: Schema.Boolean
    })
  }),
  serverInfo: Schema.Struct({
    name: Schema.String,
    version: Schema.String
  })
})
export const encodeInitializeResult = Schema.encodeSync(InitializeResult)

export const McpContentType = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^application\/json(?:\s*;.*)?$/i))
)

export const McpAccept = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/(?:^|,)\s*application\/json(?:\s*;[^,]*)?(?:,|$)/i),
    Schema.isPattern(/(?:^|,)\s*text\/event-stream(?:\s*;[^,]*)?(?:,|$)/i)
  )
)

export const BridgeId = Schema.String.pipe(
  Schema.check(Schema.isUUID(4)),
  Schema.brand("BridgeId")
)
export type BridgeId = typeof BridgeId.Type

export const Registration = Schema.Struct({
  type: Schema.Literal("register")
})
export type Registration = typeof Registration.Type

export const ResumeSecret = Schema.String.pipe(
  Schema.check(Schema.isUUID(4)),
  Schema.brand("ResumeSecret")
)
export type ResumeSecret = typeof ResumeSecret.Type

export const Reconnection = Schema.Struct({
  type: Schema.Literal("reconnect"),
  bridgeId: BridgeId,
  token: ResumeSecret
})
export type Reconnection = typeof Reconnection.Type

const SocketError = Schema.Struct({
  message: Schema.String
})

const SocketSuccess = Schema.Struct({
  type: Schema.Literal("response"),
  id: Schema.NonEmptyString,
  result: Schema.Unknown
})

const SocketFailure = Schema.Struct({
  type: Schema.Literal("response"),
  id: Schema.NonEmptyString,
  error: SocketError
})

export const SocketResponse = Schema.Union([SocketSuccess, SocketFailure])
export type SocketResponse = typeof SocketResponse.Type

/**
 * The keepalive the extension sends while a run is live.
 *
 * An MV3 service worker stops after 30 idle seconds. WebSocket traffic resets that timer,
 * so a quiet SSE run stays alive on the socket it already owns.
 */
export const SocketPing = Schema.Struct({
  type: Schema.Literal("ping")
})
export type SocketPing = typeof SocketPing.Type

export const SocketPong = Schema.Struct({
  type: Schema.Literal("pong")
})
export type SocketPong = typeof SocketPong.Type

export const SocketInbound = Schema.Union([
  Registration,
  Reconnection,
  SocketResponse,
  SocketPing
])
export type SocketInbound = typeof SocketInbound.Type

export const SocketRequest = Schema.Struct({
  type: Schema.Literal("request"),
  id: Schema.NonEmptyString,
  method: Schema.Literals(["tools/list", "tools/call"]),
  params: Schema.Unknown
})

export const SocketRegistered = Schema.Struct({
  type: Schema.Literal("registered"),
  bridgeId: BridgeId,
  token: ResumeSecret,
  mcpUrl: Schema.String
})

export const SocketProtocolError = Schema.Struct({
  type: Schema.Literal("error"),
  error: Schema.String
})

export const SocketOutbound = Schema.Union([
  SocketRequest,
  SocketRegistered,
  SocketProtocolError,
  SocketPong
])
export type SocketOutbound = typeof SocketOutbound.Type

const SocketInboundJson = Schema.fromJsonString(SocketInbound)
const SocketOutboundJson = Schema.fromJsonString(SocketOutbound)

export class RelayProtocolError extends Schema.TaggedError<RelayProtocolError>()(
  "RelayProtocolError",
  { detail: Schema.String }
) {
  override readonly message = this.detail
}

export class RelayUnauthorizedError extends Schema.TaggedError<RelayUnauthorizedError>()(
  "RelayUnauthorizedError",
  {}
) {
  override readonly message = "Missing or invalid bearer token"
}

export class RelayThreadNotFoundError extends Schema.TaggedError<RelayThreadNotFoundError>()(
  "RelayThreadNotFoundError",
  {}
) {
  override readonly message = "Unknown or expired thread"
}

export class RelayPanelClosedError extends Schema.TaggedError<RelayPanelClosedError>()(
  "RelayPanelClosedError",
  {}
) {
  override readonly message = "The reader closed the panel"
}

export class RelayTimeoutError extends Schema.TaggedError<RelayTimeoutError>()(
  "RelayTimeoutError",
  {}
) {
  override readonly message = "The reader did not answer before the timeout"
}

export class RelayRemoteError extends Schema.TaggedError<RelayRemoteError>()(
  "RelayRemoteError",
  { detail: Schema.String }
) {
  override readonly message = this.detail
}

export class RelayMethodNotFoundError extends Schema.TaggedError<RelayMethodNotFoundError>()(
  "RelayMethodNotFoundError",
  {}
) {
  override readonly message = "Method not found"
}

export class RelayStartupError extends Schema.TaggedError<RelayStartupError>()(
  "RelayStartupError",
  { detail: Schema.String }
) {
  override readonly message = this.detail
}

export type RelayRequestError =
  | RelayProtocolError
  | RelayUnauthorizedError
  | RelayThreadNotFoundError
  | RelayPanelClosedError
  | RelayTimeoutError
  | RelayRemoteError
  | RelayMethodNotFoundError

export const decodeJsonRpcRequest = (value: unknown) =>
  Schema.decodeUnknownEffect(JsonRpcRequest)(value).pipe(
    Effect.mapError(() => new RelayProtocolError({ detail: "Invalid JSON-RPC request" }))
  )

export const decodeInitializeParams = (value: unknown) =>
  Schema.decodeUnknownEffect(InitializeParams)(value).pipe(
    Effect.mapError(() => new RelayProtocolError({ detail: "Invalid initialize parameters" }))
  )

export const decodeSocketInbound = (value: string) =>
  Schema.decodeUnknownEffect(SocketInboundJson, { onExcessProperty: "error" })(value).pipe(
    Effect.mapError(() => new RelayProtocolError({ detail: "Invalid WebSocket message" }))
  )

export const encodeSocketInbound = Schema.encodeSync(SocketInboundJson)
export const decodeSocketOutbound = (value: string) =>
  Schema.decodeUnknownEffect(SocketOutboundJson, { onExcessProperty: "error" })(value).pipe(
    Effect.mapError(() => new RelayProtocolError({ detail: "Invalid WebSocket message" }))
  )
export const encodeSocketOutbound = Schema.encodeSync(SocketOutboundJson)

const BearerAuthorization = Schema.TemplateLiteral(["Bearer ", Schema.NonEmptyString])

export const decodeBearerToken = (value: unknown) =>
  Schema.decodeUnknownEffect(BearerAuthorization)(value).pipe(
    Effect.map((authorization) => authorization.slice("Bearer ".length)),
    Effect.flatMap(Schema.decodeUnknownEffect(ResumeSecret)),
    Effect.mapError(() => new RelayUnauthorizedError())
  )

export const decodeBridgeId = (value: unknown) =>
  Schema.decodeUnknownEffect(BridgeId)(value).pipe(
    Effect.mapError(() => new RelayProtocolError({ detail: "Invalid bridge id" }))
  )

export const decodeResumeSecret = (value: unknown) =>
  Schema.decodeUnknownEffect(ResumeSecret)(value).pipe(
    Effect.mapError(() => new RelayProtocolError({ detail: "Invalid resume secret" }))
  )
