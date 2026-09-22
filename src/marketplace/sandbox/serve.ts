import { Deferred, Effect, Fiber, Ref, Scope, Stream } from "effect"
import { eventStream } from "./events"
import type { CapabilityResponse } from "./firewall"
import { decodeGuestMessage, type GuestMessage } from "./messages"

type Running = ReadonlyMap<string, Fiber.Fiber<void, never>>

export interface CapabilityServer {
  readonly port: MessagePort
  readonly run: (
    input: unknown,
    secureFields?: Readonly<Record<string, string>>
  ) => Effect.Effect<CapabilityResponse>
  readonly secrets: Effect.Effect<Readonly<Record<string, string>>>
  readonly onDenied?: (
    response: Extract<CapabilityResponse, { ok: false }>
  ) => Effect.Effect<void>
  /** Runs each time the package reports how tall it drew itself. */
  readonly onResize?: (height: number) => Effect.Effect<void>
  readonly onStarted?: () => Effect.Effect<void>
  readonly onStartFailed?: (error: string) => Effect.Effect<void>
}

/**
 * Serves a private package channel.
 *
 * Each request owns a child fiber. A slow request cannot hold the message stream, and
 * a matching cancel message interrupts the port Effect, including an active fetch.
 */
export const serveCapabilities = Effect.fn("sandbox.serveCapabilities")(function* (
  options: CapabilityServer
): Effect.fn.Return<void, never, Scope.Scope> {
  const running = yield* Ref.make<Running>(new Map())

  const remove = (id: string) =>
    Ref.update(running, (current) => {
      const next = new Map(current)
      next.delete(id)
      return next
    })

  const execute = Effect.fn("sandbox.executeRequest")(function* (
    message: Extract<GuestMessage, { type: "morph:request" }>
  ) {
    const secrets = yield* options.secrets
    const response = yield* options.run(message.request, secrets)
    yield* Effect.sync(() => options.port.postMessage({ type: "morph:response", ...response }))
    if (!response.ok && options.onDenied !== undefined) yield* options.onDenied(response)
  })

  const start = Effect.fn("sandbox.startRequest")(function* (
    message: Extract<GuestMessage, { type: "morph:request" }>
  ) {
    if ((yield* Ref.get(running)).has(message.id)) return
    const started = yield* Deferred.make<void>()
    const fiber = yield* Deferred.await(started).pipe(
      Effect.andThen(execute(message)),
      Effect.ensuring(remove(message.id)),
      Effect.forkScoped
    )
    yield* Ref.update(running, (current) => new Map(current).set(message.id, fiber))
    yield* Deferred.succeed(started, undefined)
  })

  const cancel = Effect.fn("sandbox.cancelRequest")(function* (id: string) {
    const fiber = (yield* Ref.get(running)).get(id)
    if (fiber !== undefined) yield* Fiber.interrupt(fiber)
  })

  const receive = Effect.fn("sandbox.receiveMessage")(function* (event: MessageEvent<unknown>) {
    const message = yield* decodeGuestMessage(event.data).pipe(Effect.option)
    if (message._tag === "None") return
    if (message.value.type === "morph:request") {
      yield* start(message.value)
    } else if (message.value.type === "morph:cancel") {
      yield* cancel(message.value.id)
    } else if (message.value.type === "morph:size" && options.onResize !== undefined) {
      yield* options.onResize(message.value.height)
    } else if (message.value.type === "morph:started" && options.onStarted !== undefined) {
      yield* options.onStarted()
    } else if (message.value.type === "morph:start-failed" && options.onStartFailed !== undefined) {
      yield* options.onStartFailed(message.value.error)
    }
  })

  const messages = yield* eventStream<MessageEvent<unknown>>(options.port, "message")
  yield* messages.pipe(Stream.runForEach(receive), Effect.forkScoped)
  yield* Effect.acquireRelease(
    Effect.sync(() => options.port.start()),
    () => Effect.sync(() => options.port.close())
  )
})
