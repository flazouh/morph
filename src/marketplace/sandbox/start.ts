import { Cause, Effect, Exit, Fiber } from "effect"
import { SandboxFailure } from "./request"

type StartPort = Pick<MessagePort, "postMessage">

/** Run one package entry and confirm only after its Effect survives its first scheduler turn. */
export const startPackage = Effect.fn("sandbox.startPackage")(function* (
  port: StartPort,
  packageProgram: unknown
) {
  if (!Effect.isEffect(packageProgram)) {
    const message = "Package entry must return an Effect"
    yield* Effect.sync(() =>
      port.postMessage({ type: "morph:start-failed", error: message })
    )
    return yield* new SandboxFailure({ message })
  }
  const running = yield* (packageProgram as Effect.Effect<unknown, unknown>).pipe(
    Effect.catchCause((cause) => new SandboxFailure({ message: Cause.pretty(cause) })),
    Effect.forkScoped
  )
  const first = yield* Effect.race(
    Fiber.await(running).pipe(
      Effect.map((exit) => ({ type: "exit" as const, exit }))
    ),
    Effect.sleep("1 millis").pipe(Effect.as({ type: "running" as const }))
  )
  if (first.type === "exit" && Exit.isFailure(first.exit)) {
    const message = Cause.pretty(first.exit.cause)
    yield* Effect.sync(() =>
      port.postMessage({ type: "morph:start-failed", error: message })
    )
    return yield* new SandboxFailure({ message })
  }
  yield* Effect.sync(() => port.postMessage({ type: "morph:started" }))
  if (first.type === "running") yield* Fiber.join(running)
})
