import { Effect, Queue, Scope, Stream } from "effect"

/**
 * An event stream whose listener is active before this Effect returns.
 *
 * `Stream.fromEventListener` installs its listener when a consumer starts the stream.
 * A frame can post its handshake between that fork and the listener install. This
 * adapter installs first, buffers at most 64 events, and removes the listener with the
 * current scope. The fixed queue stops an untrusted page from growing trusted memory.
 */
export const eventStream = Effect.fn("sandbox.eventStream")(function* <A>(
  target: Stream.EventListener<A>,
  type: string
): Effect.fn.Return<Stream.Stream<A>, never, Scope.Scope> {
  const queue = yield* Queue.bounded<A>(64)
  const receive = (event: A): void => {
    Queue.offerUnsafe(queue, event)
  }
  yield* Effect.acquireRelease(
    Effect.sync(() => target.addEventListener(type, receive)),
    () =>
      Effect.gen(function* () {
        target.removeEventListener(type, receive)
        yield* Queue.shutdown(queue)
      })
  )
  return Stream.fromQueue(queue)
})

/**
 * Installs one filtered listener now and returns the Effect that waits for its event.
 * Rejected events never enter the queue, so a hostile page cannot occupy the slot.
 */
export const oneEvent = Effect.fn("sandbox.oneEvent")(function* <A>(
  target: Stream.EventListener<A>,
  type: string,
  accept: (event: A) => boolean
): Effect.fn.Return<Effect.Effect<A>, never, Scope.Scope> {
  const queue = yield* Queue.bounded<A>(1)
  const receive = (event: A): void => {
    if (accept(event)) Queue.offerUnsafe(queue, event)
  }
  yield* Effect.acquireRelease(
    Effect.sync(() => target.addEventListener(type, receive)),
    () =>
      Effect.gen(function* () {
        target.removeEventListener(type, receive)
        yield* Queue.shutdown(queue)
      })
  )
  return Queue.take(queue)
})
