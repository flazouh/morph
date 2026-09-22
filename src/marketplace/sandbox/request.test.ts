import { describe, expect, test } from "bun:test"
import { Duration, Effect, Stream } from "effect"
import { makeRequester } from "./request"

describe("sandbox requester", () => {
  test("matches each response to its request", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const channel = new MessageChannel()
          yield* Stream.fromEventListener<MessageEvent<unknown>>(channel.port2, "message").pipe(
            Stream.runForEach((event) =>
              Effect.sync(() => {
                const request = event.data as { request: { id: string } }
                channel.port2.postMessage({ type: "morph:response", id: request.request.id, ok: true, value: "answer" })
              })
            ),
            Effect.forkScoped
          )
          const requester = yield* makeRequester(channel.port1)
          return yield* requester.request("page.read", { selector: "main" })
        })
      )
    )

    expect(result).toBe("answer")
  })

  test("fails when Morph does not answer before the timeout", async () => {
    const result = Effect.scoped(
      Effect.gen(function* () {
        const channel = new MessageChannel()
        const requester = yield* makeRequester(channel.port1, Duration.millis(5))
        return yield* requester.request("page.read", { selector: "main" })
      })
    )

    await expect(Effect.runPromise(result)).rejects.toMatchObject({
      _tag: "SandboxFailure",
      message: "Morph did not answer before the timeout"
    })
  })
})
