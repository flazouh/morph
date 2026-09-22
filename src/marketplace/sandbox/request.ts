import { Deferred, Duration, Effect, Ref, Schema, Scope, Stream } from "effect"
import { eventStream } from "./events"
import { decodeHostResponse } from "./messages"

export class SandboxFailure extends Schema.TaggedError<SandboxFailure>()("SandboxFailure", {
  message: Schema.String
}) {}

type Pending = ReadonlyMap<string, Deferred.Deferred<unknown, SandboxFailure>>

export interface SandboxRequester {
  readonly request: (
    capability: string,
    fields?: Readonly<Record<string, unknown>>
  ) => Effect.Effect<unknown, SandboxFailure>
}

const DEFAULT_TIMEOUT = Duration.seconds(15)

export const makeRequester = Effect.fn("sandbox.makeRequester")(function* (
  port: MessagePort,
  answerWithin: Duration.Duration = DEFAULT_TIMEOUT
): Effect.fn.Return<SandboxRequester, never, Scope.Scope> {
  const sequence = yield* Ref.make(0)
  const pending = yield* Ref.make<Pending>(new Map())

  const receive = Effect.fn("sandbox.receiveResponse")(function* (event: MessageEvent<unknown>) {
    const message = yield* decodeHostResponse(event.data).pipe(Effect.option)
    if (message._tag === "None") return
    const deferred = yield* Ref.modify(pending, (current) => {
      const next = new Map(current)
      const found = next.get(message.value.id)
      next.delete(message.value.id)
      return [found, next] as const
    })
    if (deferred === undefined) return
    yield* message.value.ok
      ? Deferred.succeed(deferred, message.value.value)
      : Deferred.fail(deferred, new SandboxFailure({ message: message.value.error }))
  })

  const responses = yield* eventStream<MessageEvent<unknown>>(port, "message")
  yield* responses.pipe(
    Stream.runForEach(receive),
    Effect.forkScoped
  )
  yield* Effect.acquireRelease(
    Effect.sync(() => port.start()),
    () => Effect.sync(() => port.close())
  )

  const request = Effect.fn("sandbox.request")(function* (
    capability: string,
    fields: Readonly<Record<string, unknown>> = {}
  ) {
    const id = String(yield* Ref.updateAndGet(sequence, (value) => value + 1))
    const deferred = yield* Deferred.make<unknown, SandboxFailure>()
    yield* Ref.update(pending, (current) => new Map(current).set(id, deferred))
    yield* Effect.sync(() =>
      port.postMessage({ type: "morph:request", id, request: { id, capability, ...fields } })
    )
    return yield* Deferred.await(deferred).pipe(
      Effect.timeout(answerWithin),
      Effect.catchTag(
        "TimeoutError",
        () =>
          Effect.sync(() => port.postMessage({ type: "morph:cancel", id })).pipe(
            Effect.andThen(new SandboxFailure({ message: "Morph did not answer before the timeout" }))
          )
      ),
      Effect.ensuring(
        Ref.update(pending, (current) => {
          const next = new Map(current)
          next.delete(id)
          return next
        })
      )
    )
  })

  return { request }
})
