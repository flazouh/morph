import {
  Cause,
  Clock,
  Context,
  Effect,
  Layer,
  Option,
  Queue,
  Ref,
  Schema,
  SchemaIssue,
  SchemaTransformation,
  Semaphore,
  type Scope
} from "effect"
import type { NativeTool } from "@clavia/tardigrade"
import { Shot, SHOT_NOTE } from "../agent/eyes"
import { ASK_USER } from "../agent/tool-names"
import { createQuestionController } from "../agent/question"
import type { Step } from "../session/contract"
import { toolsFor, type PagePublishContext } from "../agent/tools"
import type { World } from "../agent/world"
import {
  BridgeId,
  decodeSocketOutbound,
  encodeSocketInbound,
  ResumeSecret,
  type SocketInbound,
  type SocketOutbound
} from "./protocol"

export const ToolCallParams = Schema.Struct({
  name: Schema.NonEmptyString,
  arguments: Schema.optionalKey(Schema.Unknown)
})
export type ToolCallParams = typeof ToolCallParams.Type

export type McpToolResult = {
  readonly content: ReadonlyArray<
    | { readonly type: "text"; readonly text: string }
    | { readonly type: "image"; readonly data: string; readonly mimeType: string }
  >
  readonly isError?: true
}

export interface ExtensionToolServer {
  readonly openRun: () => Effect.Effect<void>
  readonly closeRun: () => Effect.Effect<void>
  /** True between `openRun` and `closeRun`. The one answer to "is a run live here". */
  readonly runIsOpen: () => Effect.Effect<boolean>
  readonly list: () => Effect.Effect<ReadonlyArray<NativeTool<World>["spec"]>>
  readonly call: (callId: string, params: ToolCallParams) => Effect.Effect<McpToolResult>
  /** Answer a pending ask_user call. False means the call or the options are stale. */
  readonly answerQuestion: (callId: string, optionIds: ReadonlyArray<string>) => boolean
}

export interface ExtensionToolServerOptions {
  readonly url: string
  readonly world: Layer.Layer<World>
  /** Publishing the page's own redesign; absent when the page runs an installed Morph. */
  readonly publish?: PagePublishContext | undefined
  readonly onToolStart?: (step: Extract<Step, { readonly kind: "tool" }>) => Effect.Effect<void>
  readonly onStep: (step: Extract<Step, { readonly kind: "tool" }>) => Effect.Effect<void>
}

/**
 * The bridge the relay registered for this extension, as the extension keeps it.
 *
 * The two ids are the protocol's own brands, imported rather than restated: a second
 * declaration of the same brand is a second rule about what a bridge id is, and the two
 * drift apart on the day one of them is tightened.
 */
export const RelayIdentity = Schema.Struct({
  bridgeId: BridgeId,
  token: ResumeSecret,
  mcpUrl: Schema.String
})
export type RelayIdentity = typeof RelayIdentity.Type

export class RelayConnectionError extends Schema.TaggedError<RelayConnectionError>()(
  "RelayConnectionError",
  { detail: Schema.String }
) {
  override readonly message = this.detail
}

export interface RelayConnection {
  readonly receive: Effect.Effect<SocketOutbound, RelayConnectionError>
  readonly send: (
    message: SocketInbound
  ) => Effect.Effect<void, RelayConnectionError>
}

export interface RelayWebSocket extends EventTarget {
  readonly close: () => void
  readonly send: (data: string) => void
}

export class RelayThreadOwnedError extends Schema.TaggedError<RelayThreadOwnedError>()(
  "RelayThreadOwnedError",
  {}
) {
  override readonly message = "This thread is already active in a tab"
}

export class RelayThreadOwnership extends Context.Service<
  RelayThreadOwnership,
  {
    readonly claim: (
      threadId: string,
      tabId: number
    ) => Effect.Effect<void, RelayThreadOwnedError, Scope.Scope>
  }
>()("morph/relay/RelayThreadOwnership") {
  static readonly layer = Layer.effect(
    RelayThreadOwnership,
    Effect.gen(function* () {
      const owners = yield* Ref.make<ReadonlyMap<string, number>>(new Map())
      const claim = Effect.fn("RelayThreadOwnership.claim")(function* (
        threadId: string,
        tabId: number
      ) {
        yield* Effect.acquireRelease(
          Effect.gen(function* () {
            const acquired = yield* Ref.modify(owners, (current) => {
              const owner = current.get(threadId)
              if (owner !== undefined) return [false, current] as const
              return [true, new Map(current).set(threadId, tabId)] as const
            })
            if (!acquired) return yield* new RelayThreadOwnedError()
          }),
          () =>
            Ref.update(owners, (current) => {
              if (current.get(threadId) !== tabId) return current
              const next = new Map(current)
              next.delete(threadId)
              return next
            })
        )
      })
      return RelayThreadOwnership.of({ claim })
    })
  )
}

export class RelayLink extends Context.Service<
  RelayLink,
  {
    readonly connect: (
      url: string
    ) => Effect.Effect<RelayConnection, RelayConnectionError, Scope.Scope>
  }
>()("morph/relay/RelayLink") {
  static readonly webSocketLayerWith = (
    createSocket: (url: string) => RelayWebSocket
  ): Layer.Layer<RelayLink> =>
    Layer.succeed(
      RelayLink,
      RelayLink.of({
        connect: Effect.fn("RelayLink.connect")(function* (url: string) {
          const incoming = yield* Queue.make<string, RelayConnectionError>()
          const socket = yield* Effect.acquireRelease(
            Effect.interruptible(
              Effect.callback<RelayWebSocket, RelayConnectionError>((resume) => {
                const connection = createSocket(url)
                connection.addEventListener(
                  "open",
                  () => resume(Effect.succeed(connection)),
                  { once: true }
                )
                connection.addEventListener(
                  "error",
                  () =>
                    resume(
                      Effect.fail(
                        new RelayConnectionError({ detail: "Could not connect to the relay" })
                      )
                    ),
                  { once: true }
                )
                return Effect.sync(() => connection.close())
              })
            ),
            (socket) => Effect.sync(() => socket.close())
          )
          socket.addEventListener("message", (event) => {
            if ("data" in event && typeof event.data === "string") {
              Effect.runFork(Queue.offer(incoming, event.data))
            } else {
              Effect.runFork(
                Queue.fail(
                  incoming,
                  new RelayConnectionError({ detail: "Invalid relay WebSocket message" })
                )
              )
            }
          })
          socket.addEventListener(
            "close",
            () =>
              Effect.runFork(
                Queue.fail(
                  incoming,
                  new RelayConnectionError({ detail: "The relay WebSocket closed" })
                )
              ),
            { once: true }
          )
          return {
            receive: Queue.take(incoming).pipe(
              Effect.flatMap(decodeSocketOutbound),
              Effect.mapError(
                () => new RelayConnectionError({ detail: "Invalid relay WebSocket message" })
              )
            ),
            send: (message) =>
              Effect.try({
                try: () => {
                  socket.send(encodeSocketInbound(message))
                },
                catch: () =>
                  new RelayConnectionError({ detail: "Could not send to the relay" })
              })
          }
        })
      })
    )

  static readonly webSocketLayer = RelayLink.webSocketLayerWith(
    (url) => new WebSocket(url)
  )
}

export interface ExtensionRelayOptions {
  readonly relayUrl: string
  readonly threadId: string
  readonly tabId: number
  readonly pageUrl: string
  readonly world: Layer.Layer<World>
  readonly onToolStart?: ExtensionToolServerOptions["onToolStart"]
  readonly onStep: ExtensionToolServerOptions["onStep"]
  readonly publish?: ExtensionToolServerOptions["publish"]
  readonly identity?: unknown
  readonly reconnectBaseDelayMs?: number
  readonly onIdentity?: (identity: RelayIdentity) => Effect.Effect<void>
  /** How often the open run pings the relay to keep the service worker alive. */
  readonly heartbeatMs?: number
}

/**
 * Chrome stops an idle MV3 service worker after 30 seconds. Traffic on an open WebSocket
 * resets that timer, so the heartbeat sits well inside the window.
 */
const HEARTBEAT_MS = 20_000

export interface ExtensionRelayService extends ExtensionToolServer {
  /** The stored identity: a reconnect hint, which may name a bridge the relay dropped. */
  readonly identity: () => Effect.Effect<RelayIdentity | undefined>
  /**
   * The identity of the connection that is registered right now, or nothing while the
   * socket is down. A caller that hands this bridge to a cloud agent uses this one.
   */
  readonly connected: () => Effect.Effect<RelayIdentity | undefined>
}

const textResult = (result: unknown, isError = false): McpToolResult => ({
  content: [{ type: "text", text: JSON.stringify(result) }],
  ...(isError ? { isError: true as const } : {})
})

/**
 * A base64 image data URL, split into its type and its bytes.
 *
 * The screenshot arrives as one string and leaves as two fields, so something has to read
 * the string. Hand-written slicing read `data:image/png,QUJD` and a bare URL as image
 * bytes with a guessed type, which is a page's own text reaching the agent dressed as a
 * screenshot. This is the rule instead, in one place: a `data:` scheme, an `image/` type,
 * optional parameters, `base64`, then the payload.
 */
const IMAGE_DATA_URL = /^data:(image\/[\w.+-]+)(?:;[\w.+-]+=[^;,]*)*;base64,([\s\S]*)$/

const ImageDataUrl = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Struct({ mimeType: Schema.NonEmptyString, data: Schema.String }),
    SchemaTransformation.transformOrFail({
      decode: (value: string, options) => {
        const match = IMAGE_DATA_URL.exec(value)
        return match === null
          ? Effect.fail(
              new SchemaIssue.InvalidValue(
                { message: "not a base64 image data URL" },
                value,
                options
              )
            )
          : Effect.succeed({ mimeType: match[1]!, data: match[2]! })
      },
      encode: (parts: { readonly mimeType: string; readonly data: string }) =>
        Effect.succeed(`data:${parts.mimeType};base64,${parts.data}`)
    })
  )
)

const decodeImageDataUrl = Schema.decodeUnknownOption(ImageDataUrl)

/**
 * The screenshot as MCP image content, or a tool error when the page did not hand one
 * back. Exported for its own test: it is the boundary between the page's string and what
 * the cloud agent is told is a picture.
 */
export const imageContent = (dataUrl: string): McpToolResult => {
  const parts = decodeImageDataUrl(dataUrl)
  if (Option.isNone(parts)) return unavailable("the page did not return a screenshot")
  return { content: [{ type: "image", ...parts.value }] }
}

const unavailable = (error: string): McpToolResult => textResult({ error }, true)
const rejectsBridgeIdentity = (error: string): boolean =>
  error === "Bridge does not exist" || error === "Bridge token does not match"

export const makeExtensionToolServer = Effect.fn("ExtensionToolServer.make")(
  function* (options: ExtensionToolServerOptions): Effect.fn.Return<ExtensionToolServer> {
    /** Open between the start and the end of one run. Closed, the server takes no call. */
    const runIsLive = yield* Ref.make(false)
    const semaphore = yield* Semaphore.make(1)
    /**
     * The questions a Cursor run asks. The cloud agent's tool call waits on this, and the
     * panel's click lands here. A run that ends cancels what it asked.
     */
    const questions = createQuestionController()
    const tools = toolsFor({ url: options.url }, { questions, publish: options.publish })

    const openRun = Effect.fn("ExtensionToolServer.openRun")(function* () {
      questions.beginTurn()
      yield* Ref.set(runIsLive, true)
    })

    /**
     * A run ended. Its parked questions die with it, but a release the reader already
     * authorized does not: the publish it authorizes is retried in the next run whenever
     * the ask_user call itself timed out, which is how Cursor ends a long tool call.
     */
    const closeRun = Effect.fn("ExtensionToolServer.closeRun")(function* () {
      yield* Ref.set(runIsLive, false)
      questions.cancelPending()
    })

    const runIsOpen = Effect.fn("ExtensionToolServer.runIsOpen")(function* () {
      return yield* Ref.get(runIsLive)
    })

    const list = Effect.fn("ExtensionToolServer.list")(function* () {
      return tools.map((tool) => tool.spec)
    })

    /**
     * Page tools run one at a time, so the page never sees two writers. A question waits
     * on the reader, for as long as the reader takes, and holds no place in that queue:
     * the run's other calls go on while the card is open.
     */
    const serialized = <A, E, R>(name: string, work: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      name === ASK_USER ? work : semaphore.withPermits(1)(work)

    const call = Effect.fn("ExtensionToolServer.call")(function* (
      _relayCallId: string,
      params: ToolCallParams
    ) {
      return yield* serialized(
        params.name,
        Effect.gen(function* () {
          const tool = tools.find((candidate) => candidate.spec.name === params.name)
          if (tool === undefined) return unavailable(`unknown tool: ${params.name}`)

          if (!(yield* Ref.get(runIsLive))) {
            return unavailable("tool calls are not accepted outside an open run")
          }
          const callId = crypto.randomUUID()
          const input = params.arguments ?? {}
          const startedAt = yield* Clock.currentTimeMillis
          if (options.onToolStart !== undefined) {
            yield* options.onToolStart({
              kind: "tool",
              callId,
              name: params.name,
              input,
              at: startedAt
            })
          }
          const result = yield* Effect.provide(tool.run(input, { callId }), options.world)
          const stepResult = result instanceof Shot ? SHOT_NOTE : result
          const at = yield* Clock.currentTimeMillis
          const step = {
            kind: "tool" as const,
            callId,
            name: params.name,
            input,
            result: stepResult,
            at
          }
          yield* options.onStep(step)
          return result instanceof Shot
            ? imageContent(result.image)
            : textResult(result)
        })
      )
    })

    return { openRun, closeRun, runIsOpen, list, call, answerQuestion: questions.answer }
  }
)

const relaySocketUrl = (relayUrl: string): string => {
  const url = new URL("/ws", relayUrl)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  return url.toString()
}

export class ExtensionRelay extends Context.Service<
  ExtensionRelay,
  ExtensionRelayService
>()("morph/relay/ExtensionRelay") {
  static readonly make = Effect.fn("ExtensionRelay.make")(function* (
    options: ExtensionRelayOptions
  ): Effect.fn.Return<
    ExtensionRelayService,
    RelayThreadOwnedError,
    RelayLink | RelayThreadOwnership | Scope.Scope
  > {
    const link = yield* RelayLink
    const ownership = yield* RelayThreadOwnership
    yield* ownership.claim(options.threadId, options.tabId)
    const server = yield* makeExtensionToolServer({
      url: options.pageUrl,
      world: options.world,
      ...(options.onToolStart === undefined ? {} : { onToolStart: options.onToolStart }),
      ...(options.publish === undefined ? {} : { publish: options.publish }),
      onStep: options.onStep
    })
    const initialIdentity =
      options.identity === undefined
        ? undefined
        : yield* Schema.decodeUnknownEffect(RelayIdentity)(options.identity).pipe(
            Effect.catch(() => Effect.succeed(undefined))
          )
    const identity = yield* Ref.make<RelayIdentity | undefined>(initialIdentity)
    /** The connection in hand, and the identity the relay registered on it. */
    const live = yield* Ref.make<
      { readonly connection: RelayConnection; readonly identity: RelayIdentity | undefined } | undefined
    >(undefined)
    let failures = 0

    const handleMessage = Effect.fn("ExtensionRelay.handleMessage")(function* (
      connection: RelayConnection,
      message: SocketOutbound
    ) {
      if (message.type === "registered") {
        const registered = yield* Schema.decodeUnknownEffect(RelayIdentity)({
          bridgeId: message.bridgeId,
          token: message.token,
          mcpUrl: message.mcpUrl
        })
        yield* Ref.set(identity, registered)
        yield* Ref.update(live, (current) =>
          current === undefined || current.connection !== connection
            ? current
            : { connection, identity: registered }
        )
        failures = 0
        yield* options.onIdentity?.(registered) ?? Effect.void
        return
      }
      if (message.type === "error") {
        if (rejectsBridgeIdentity(message.error)) {
          yield* Ref.set(identity, undefined)
        }
        return yield* new RelayConnectionError({ detail: message.error })
      }
      // The answer to a keepalive. It carries no work, only the traffic that keeps
      // the service worker alive.
      if (message.type === "pong") return

      if (message.method === "tools/list") {
        const tools = yield* server.list()
        yield* connection.send({
          type: "response",
          id: message.id,
          result: { tools }
        })
        return
      }

      // A tool call runs beside the reader, not in it. An `ask_user` waits as long as the
      // reader takes to click, and the socket must keep answering pings and lists and
      // must notice a drop under it in the meantime. The fiber lives in the connection's
      // scope: a dropped socket ends the call, and the relay fails the pending request on
      // its side, so no answer goes out on a socket that no longer holds the question.
      yield* Effect.forkScoped(
        Schema.decodeUnknownEffect(ToolCallParams)(message.params).pipe(
          Effect.flatMap((params) => server.call(message.id, params)),
          Effect.match({
            onFailure: () => ({
              type: "response" as const,
              id: message.id,
              error: { message: "Invalid tool call parameters" }
            }),
            onSuccess: (answer) => ({
              type: "response" as const,
              id: message.id,
              result: answer
            })
          }),
          Effect.flatMap((result) => connection.send(result)),
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause)
              ? Effect.void
              : Effect.logWarning("Relay tool call could not answer", cause)
          )
        )
      )
    })

    const connectOnce = Effect.fnUntraced(function* () {
      const connection = yield* link.connect(relaySocketUrl(options.relayUrl))
      // The live entry lasts exactly as long as this connection's scope, so a caller
      // that reads it never reads a bridge that is already gone.
      yield* Effect.acquireRelease(
        Ref.set(live, { connection, identity: undefined }),
        () => Ref.set(live, undefined)
      )
      const current = yield* Ref.get(identity)
      yield* connection.send(
        current === undefined
          ? { type: "register" }
          : {
              type: "reconnect",
              bridgeId: current.bridgeId,
              token: current.token
            }
      )
      yield* Effect.forever(
        connection.receive.pipe(
          Effect.flatMap((message) => handleMessage(connection, message))
        )
      )
    })

    const reconnect = Effect.fnUntraced(function* () {
      yield* Effect.scoped(connectOnce()).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterrupts(cause)) return Effect.failCause(cause)
          const delay =
            (options.reconnectBaseDelayMs ?? 250) *
            Math.min(2 ** failures, 64)
          failures += 1
          return Effect.logWarning(
            "Relay connection stopped unexpectedly; reconnecting"
          ).pipe(Effect.andThen(Effect.sleep(delay)))
        })
      )
    })

    yield* Effect.forever(reconnect()).pipe(Effect.forkScoped)

    /**
     * The keepalive. It beats only while the tool gate is open, on the socket this relay
     * owns, and it ends with the scope: no timer outlives the thread that asked for it.
     *
     * The gate is the one state it reads. A second flag beside it could say "running"
     * while the gate said "closed", and the reader would watch a run the worker was free
     * to stop.
     */
    const beat = Effect.fnUntraced(function* () {
      yield* Effect.sleep(options.heartbeatMs ?? HEARTBEAT_MS)
      if (!(yield* server.runIsOpen())) return
      const current = yield* Ref.get(live)
      if (current === undefined) return
      yield* Effect.ignore(current.connection.send({ type: "ping" }))
    })
    yield* Effect.forever(beat()).pipe(Effect.forkScoped)

    return ExtensionRelay.of({
      ...server,
      identity: () => Ref.get(identity),
      connected: () => Effect.map(Ref.get(live), (current) => current?.identity)
    })
  })
}
