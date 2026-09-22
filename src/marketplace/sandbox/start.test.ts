import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { startPackage } from "./start"

describe("sandbox package startup", () => {
  test("a running Effect receives one start acknowledgement", async () => {
    const messages: unknown[] = []
    await Effect.runPromise(
      Effect.scoped(
        Effect.race(
          startPackage(
            { postMessage: (message) => messages.push(message) },
            Effect.never
          ),
          Effect.sleep("10 millis")
        )
      )
    )

    expect(messages).toEqual([{ type: "morph:started" }])
  })

  test("an immediate Effect failure is refused before start acknowledgement", async () => {
    const messages: unknown[] = []
    await expect(
      Effect.runPromise(
        Effect.scoped(
          startPackage(
            { postMessage: (message) => messages.push(message) },
            Effect.fail("broken during start")
          )
        )
      )
    ).rejects.toThrow("broken during start")

    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ type: "morph:start-failed" })
  })

  test("a value that is not an Effect is refused before start acknowledgement", async () => {
    const messages: unknown[] = []
    await expect(
      Effect.runPromise(
        Effect.scoped(
          startPackage(
            { postMessage: (message) => messages.push(message) },
            undefined
          )
        )
      )
    ).rejects.toThrow("Package entry must return an Effect")

    expect(messages).toEqual([
      {
        type: "morph:start-failed",
        error: "Package entry must return an Effect"
      }
    ])
  })
})
