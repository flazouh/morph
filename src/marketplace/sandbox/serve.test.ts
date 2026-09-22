import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Stream } from "effect"
import { capabilityFirewall, type CapabilityManifest, type CapabilityPorts } from "./firewall"
import { eventStream } from "./events"
import { serveCapabilities } from "./serve"

const manifest: CapabilityManifest = {
  slug: "morph/concurrency-test",
  permissions: {
    page: { read: ["#slow", "#fast"], navigate: [], traverse: false },
    network: [],
    storage: false,
    secureForms: []
  }
}

describe("capability server", () => {
  test("answers later requests and cancels work by request id", async () => {
    const interrupted = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const slowInterrupted = yield* Deferred.make<void>()
          const ports: CapabilityPorts = {
            read: (selector) =>
              selector === "#slow"
                ? Effect.never.pipe(Effect.ensuring(Deferred.succeed(slowInterrupted, undefined)))
                : Effect.succeed({ text: "fast" }),
            fetch: () => Effect.die("unused"),
            navigate: () => Effect.die("unused"),
            traverse: () => Effect.die("unused"),
            context: () => Effect.die("unused"),
            restore: () => Effect.die("unused"),
            loadAsset: () => Effect.die("unused"),
            storage: {
              get: () => Effect.die("unused"),
              set: () => Effect.die("unused")
            },
            secureSubmit: () => Effect.die("unused")
          }
          const channel = new MessageChannel()
          yield* serveCapabilities({
            port: channel.port1,
            run: capabilityFirewall(manifest, ports),
            secrets: Effect.succeed({})
          })
          const responses = yield* eventStream<MessageEvent<unknown>>(channel.port2, "message")
          yield* Effect.acquireRelease(
            Effect.sync(() => channel.port2.start()),
            () => Effect.sync(() => channel.port2.close())
          )

          channel.port2.postMessage({
            type: "morph:request",
            id: "slow",
            request: { id: "slow", capability: "page.read", selector: "#slow" }
          })
          channel.port2.postMessage({
            type: "morph:request",
            id: "fast",
            request: { id: "fast", capability: "page.read", selector: "#fast" }
          })
          const response = yield* Stream.runHead(responses)
          expect(response._tag === "Some" ? response.value.data : undefined).toMatchObject({
            type: "morph:response",
            id: "fast",
            ok: true
          })

          channel.port2.postMessage({ type: "morph:cancel", id: "slow" })
          yield* Deferred.await(slowInterrupted)
          return true
        })
      )
    )

    expect(interrupted).toBe(true)
  })

  test("passes on the height the package reports", async () => {
    const height = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const reported = yield* Deferred.make<number>()
          const channel = new MessageChannel()
          yield* serveCapabilities({
            port: channel.port1,
            run: () => Effect.die("unused"),
            secrets: Effect.succeed({}),
            onResize: (value) => Deferred.succeed(reported, value).pipe(Effect.asVoid)
          })
          yield* Effect.acquireRelease(
            Effect.sync(() => channel.port2.start()),
            () => Effect.sync(() => channel.port2.close())
          )

          channel.port2.postMessage({ type: "morph:size", height: 1840 })
          return yield* Deferred.await(reported)
        })
      )
    )

    expect(height).toBe(1840)
  })

  test("reports whether the guest accepted or refused the package entry", async () => {
    const events = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const received = yield* Deferred.make<ReadonlyArray<string>>()
          const values: string[] = []
          const channel = new MessageChannel()
          const record = (value: string) =>
            Effect.sync(() => {
              values.push(value)
              return [...values]
            }).pipe(
              Effect.flatMap((current) =>
                current.length === 2
                  ? Deferred.succeed(received, current).pipe(Effect.asVoid)
                  : Effect.void
              )
            )
          yield* serveCapabilities({
            port: channel.port1,
            run: () => Effect.die("unused"),
            secrets: Effect.succeed({}),
            onStarted: () => record("started"),
            onStartFailed: (error) => record(`failed:${error}`)
          })
          yield* Effect.acquireRelease(
            Effect.sync(() => channel.port2.start()),
            () => Effect.sync(() => channel.port2.close())
          )

          channel.port2.postMessage({ type: "morph:started" })
          channel.port2.postMessage({ type: "morph:start-failed", error: "bad entry" })
          return yield* Deferred.await(received)
        })
      )
    )

    expect(events).toEqual(["started", "failed:bad entry"])
  })
})
