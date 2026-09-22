import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Option, Stream } from "effect"
import { eventStream, oneEvent } from "./events"

describe("scoped event stream", () => {
  test("registers before it returns and removes the listener with its scope", async () => {
    class CountingTarget extends EventTarget {
      added = 0
      removed = 0

      override addEventListener(...args: Parameters<EventTarget["addEventListener"]>): void {
        this.added += 1
        super.addEventListener(...args)
      }

      override removeEventListener(...args: Parameters<EventTarget["removeEventListener"]>): void {
        this.removed += 1
        super.removeEventListener(...args)
      }
    }
    const target = new CountingTarget()

    const received = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* eventStream<Event>(target, "message")
          const first = yield* Stream.runHead(events).pipe(Effect.forkScoped)
          target.dispatchEvent(new Event("message"))
          return yield* Fiber.join(first)
        })
      )
    )

    expect(Option.isSome(received)).toBe(true)
    expect({ added: target.added, removed: target.removed }).toEqual({ added: 1, removed: 1 })
  })

  test("bounds events from an untrusted sender", async () => {
    const target = new EventTarget()
    const received = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* eventStream<Event>(target, "message")
          for (let index = 0; index < 100; index += 1) target.dispatchEvent(new Event("message"))
          return yield* events.pipe(Stream.take(64), Stream.runCollect)
        })
      )
    )

    expect(received).toHaveLength(64)
  })

  test("does not let rejected events consume a one-shot listener", async () => {
    const target = new EventTarget()
    const accepted = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const next = yield* oneEvent<Event>(
            target,
            "message",
            (event) => event instanceof CustomEvent && event.detail === "accepted"
          )
          for (let index = 0; index < 100; index += 1) {
            target.dispatchEvent(new CustomEvent("message", { detail: "rejected" }))
          }
          target.dispatchEvent(new CustomEvent("message", { detail: "accepted" }))
          return yield* next
        })
      )
    )

    expect((accepted as CustomEvent<string>).detail).toBe("accepted")
  })
})
