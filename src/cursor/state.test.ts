import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { RelayIdentity } from "../relay/extension"
import type { Step } from "../session/contract"
import { flakySteps, said } from "./testing"
import {
  CURSOR_RECORD_VERSION,
  CursorStorageError,
  CursorStore,
  cursorStoreLayer,
  EMPTY_CURSOR_STATE,
  memoryCursorStepStorage,
  memoryCursorStorage,
  type CursorStepStorage,
  type CursorStorage,
  type CursorThreadState
} from "./state"

/**
 * The Cursor thread record is what a reopened panel reads: the agent to continue, the
 * steps that already happened, the relay identity to reconnect with, and the run that was
 * live when the panel went away. A record Morph cannot read must never throw at a reader.
 */

const IDENTITY = Schema.decodeUnknownSync(RelayIdentity)({
  bridgeId: "11111111-1111-4111-8111-111111111111",
  token: "22222222-2222-4222-8222-222222222222",
  mcpUrl: "https://relay.test/mcp/11111111-1111-4111-8111-111111111111"
})

const withStore = <A>(program: Effect.Effect<A, never, CursorStore>, stored?: unknown) =>
  Effect.runPromise(Effect.provide(program, cursorStoreLayer(memoryCursorStorage(stored))))

/** A metadata storage the test can look inside, to prove what the shared record holds. */
const spyStorage = (initial: Record<string, unknown> = {}) => {
  let value: Record<string, unknown> = initial
  return {
    read: () => Effect.sync(() => value),
    write: (next: Record<string, unknown>) =>
      Effect.sync(() => {
        value = next
      }),
    peek: () => value
  } satisfies CursorStorage & { readonly peek: () => Record<string, unknown> }
}

/** A step history long enough that one shared local-storage record could not hold it. */
const manySteps = (count: number): ReadonlyArray<Step> =>
  Array.from({ length: count }, (_, index) => ({
    kind: "assistant" as const,
    text: `line ${index} ${"x".repeat(200)}`,
    at: index
  }))

describe("cursor thread state", () => {
  test("an unknown thread reads the empty record", async () => {
    const state = await withStore(CursorStore.use((store) => store.read("thread-1")))
    expect(state).toEqual(EMPTY_CURSOR_STATE)
  })

  test("a thread round-trips its agent, steps, relay identity and active run", async () => {
    const written = {
      agentId: "bc-1",
      steps: [
        { kind: "user" as const, text: "Restyle it", at: 1 },
        {
          kind: "tool" as const,
          callId: "call-1",
          name: "apply_styles",
          input: { css: "body{}" },
          result: { ok: true, applied: { css: "body{}" } },
          at: 2
        },
        { kind: "assistant" as const, text: "Applied.", at: 3 }
      ],
      identity: IDENTITY,
      activeRun: { agentId: "bc-1", runId: "run-1", startedAt: 4 },
      spend: {
        provider: "cursor" as const,
        usd: 0,
        promptTokens: 120,
        completionTokens: 30,
        cacheReadTokens: 400,
        cacheWriteTokens: 50,
        priced: 0
      }
    }
    const read = await withStore(
      CursorStore.use((store) =>
        Effect.andThen(store.write("thread-1", written), store.read("thread-1"))
      )
    )
    expect(read).toEqual(written)
  })

  test("two threads keep their own records", async () => {
    const [first, second] = await withStore(
      CursorStore.use((store) =>
        Effect.gen(function* () {
          yield* store.write("thread-1", { ...EMPTY_CURSOR_STATE, agentId: "bc-1" })
          yield* store.write("thread-2", { ...EMPTY_CURSOR_STATE, agentId: "bc-2" })
          return [yield* store.read("thread-1"), yield* store.read("thread-2")] as const
        })
      )
    )
    expect(first.agentId).toBe("bc-1")
    expect(second.agentId).toBe("bc-2")
  })

  test("a stored record Morph cannot read comes back empty instead of throwing", async () => {
    const state = await withStore(CursorStore.use((store) => store.read("thread-1")), {
      "thread-1": { agentId: 7, steps: "not a list" }
    })
    expect(state).toEqual(EMPTY_CURSOR_STATE)
  })

  test("one unreadable field keeps the steps, the agent, the relay identity and the spend", async () => {
    const state = await withStore(CursorStore.use((store) => store.read("thread-1")), {
      "thread-1": {
        agentId: "bc-1",
        steps: [{ kind: "user", text: "Restyle it", at: 1 }],
        identity: IDENTITY,
        // A field an older or newer build wrote in a shape this one does not read.
        activeRun: { agentId: "bc-1", runId: 7 },
        spend: {
          provider: "cursor",
          usd: 0,
          promptTokens: 120,
          completionTokens: 30,
          cacheReadTokens: 400,
          cacheWriteTokens: 50,
          priced: 0
        }
      }
    })

    expect(state.agentId).toBe("bc-1")
    expect(state.steps).toEqual([{ kind: "user", text: "Restyle it", at: 1 }])
    expect(state.identity).toEqual(IDENTITY)
    expect(state.spend?.promptTokens).toBe(120)
    expect(state.activeRun).toBeUndefined()
  })

  test("a malformed step keeps the steps around it", async () => {
    const state = await withStore(CursorStore.use((store) => store.read("thread-1")), {
      "thread-1": {
        agentId: "bc-1",
        steps: [
          { kind: "user", text: "Restyle it", at: 1 },
          { kind: "nonsense", text: 4 },
          { kind: "assistant", text: "Applied.", at: 3 }
        ]
      }
    })

    expect(state.agentId).toBe("bc-1")
    expect(state.steps).toEqual([
      { kind: "user", text: "Restyle it", at: 1 },
      { kind: "assistant", text: "Applied.", at: 3 }
    ])
  })

  test("an unreadable spend keeps the agent and the steps", async () => {
    const state = await withStore(CursorStore.use((store) => store.read("thread-1")), {
      "thread-1": {
        agentId: "bc-1",
        steps: [{ kind: "user", text: "Restyle it", at: 1 }],
        spend: { provider: "cursor", usd: "free" }
      }
    })

    expect(state.agentId).toBe("bc-1")
    expect(state.steps).toHaveLength(1)
    expect(state.spend).toBeUndefined()
  })

  test("a record written before the step store moved reads its inline steps", async () => {
    const state = await withStore(CursorStore.use((store) => store.read("thread-1")), {
      "thread-1": {
        agentId: "bc-1",
        steps: [
          { kind: "user", text: "Restyle it", at: 1 },
          { kind: "assistant", text: "Applied.", at: 2 }
        ],
        identity: IDENTITY
      }
    })

    expect(state.agentId).toBe("bc-1")
    expect(state.identity).toEqual(IDENTITY)
    expect(said(state.steps)).toEqual(["user:Restyle it", "assistant:Applied."])
  })

  test("a migrated thread writes its steps outside the shared metadata record", async () => {
    const metadata = spyStorage()
    const steps = memoryCursorStepStorage()
    const written: CursorThreadState = {
      agentId: "bc-1",
      steps: manySteps(500),
      identity: IDENTITY
    }
    const read = await Effect.runPromise(
      Effect.provide(
        CursorStore.use((store) =>
          Effect.andThen(store.write("thread-1", written), store.read("thread-1"))
        ),
        cursorStoreLayer(metadata, { steps })
      )
    )

    expect(read.steps).toHaveLength(500)
    expect(read.agentId).toBe("bc-1")
    const record = metadata.peek()["thread-1"] as Record<string, unknown>
    expect(record.steps).toBeUndefined()
    expect(record.version).toBe(CURSOR_RECORD_VERSION)
    expect(JSON.stringify(metadata.peek()).length).toBeLessThan(2_000)
  })

  test("a large step history round-trips whole through the step store", async () => {
    const metadata = spyStorage()
    const steps = memoryCursorStepStorage()
    const history = manySteps(4_000)
    const read = await Effect.runPromise(
      Effect.provide(
        CursorStore.use((store) =>
          Effect.andThen(
            store.write("thread-1", { steps: history }),
            store.read("thread-1")
          )
        ),
        cursorStoreLayer(metadata, { steps })
      )
    )

    expect(read.steps).toHaveLength(4_000)
    expect(read.steps[3_999]).toEqual(history[3_999]!)
  })

  test("dropping a thread removes its step history too", async () => {
    const metadata = spyStorage()
    const steps = memoryCursorStepStorage()
    const read = await Effect.runPromise(
      Effect.provide(
        CursorStore.use((store) =>
          Effect.gen(function* () {
            yield* store.write("thread-1", { steps: manySteps(10) })
            yield* store.write("thread-2", { steps: manySteps(10) })
            yield* store.drop("thread-1")
            return [yield* store.read("thread-1"), yield* store.read("thread-2")] as const
          })
        ),
        cursorStoreLayer(metadata, { steps })
      )
    )

    expect(read[0]).toEqual(EMPTY_CURSOR_STATE)
    expect(read[1]!.steps).toHaveLength(10)
    expect(steps.peek()["thread-1"]).toBeUndefined()
  })

  test("a step store that cannot write reports a safe diagnostic and does not fail", async () => {
    const failures: Array<CursorStorageError> = []
    const metadata = spyStorage()
    const steps: CursorStepStorage = {
      load: () => Effect.succeed(undefined),
      save: () => new CursorStorageError({ operation: "write", detail: "QuotaExceededError" }),
      drop: () => Effect.void
    }
    await Effect.runPromise(
      Effect.provide(
        CursorStore.use((store) =>
          store.write("thread-1", { steps: [{ kind: "user", text: "secret page text", at: 1 }] })
        ),
        cursorStoreLayer(metadata, {
          steps,
          onFailure: (failure) =>
            Effect.sync(() => {
              failures.push(failure)
            })
        })
      )
    )

    expect(failures).toHaveLength(1)
    expect(failures[0]!.operation).toBe("write")
    expect(failures[0]!.message).not.toContain("secret page text")
    // The agent is still reachable, so the next send continues the same Cursor agent.
    expect(metadata.peek()["thread-1"]).toBeDefined()
  })

  test("a step history the store cannot read says so instead of reading empty", async () => {
    const steps = flakySteps({ "thread-1": [{ kind: "user", text: "Restyle it", at: 1 }] })
    steps.failLoads(1)
    const state = await Effect.runPromise(
      Effect.provide(
        CursorStore.use((store) => store.read("thread-1")),
        cursorStoreLayer(
          memoryCursorStorage({
            "thread-1": { version: CURSOR_RECORD_VERSION, agentId: "bc-1", identity: IDENTITY }
          }),
          { steps, onFailure: () => Effect.void }
        )
      )
    )

    // Empty and unknown are not the same answer, and only one of them may be written back.
    expect(state.stepsUnread).toBe(true)
    expect(state.steps).toEqual([])
    // The rest of the thread is in the record beside it, and it is still readable.
    expect(state.agentId).toBe("bc-1")
    expect(state.identity).toEqual(IDENTITY)
  })

  test("a write after a step read failed leaves the saved history in place", async () => {
    const history = [
      { kind: "user" as const, text: "Restyle it", at: 1 },
      { kind: "assistant" as const, text: "Applied.", at: 2 }
    ]
    const steps = flakySteps({ "thread-1": history })
    steps.failLoads(1)
    const metadata = spyStorage({
      "thread-1": { version: CURSOR_RECORD_VERSION, agentId: "bc-1" }
    })
    const result = await Effect.runPromise(
      Effect.provide(
        CursorStore.use((store) =>
          Effect.gen(function* () {
            const first = yield* store.read("thread-1")
            // The session goes on working from what it has, and saves as it goes.
            yield* store.write("thread-1", {
              agentId: "bc-1",
              steps: [{ kind: "user", text: "Again", at: 9 }]
            })
            const saved = steps.peek("thread-1")
            const second = yield* store.read("thread-1")
            return { first, saved, second }
          })
        ),
        cursorStoreLayer(metadata, { steps, onFailure: () => Effect.void })
      )
    )

    expect(result.first.stepsUnread).toBe(true)
    // The write could not know the history, so it left every step of it alone.
    expect(result.saved).toEqual(history)
    // The store answers again, and the thread reads back whole.
    expect(said(result.second.steps)).toEqual(["user:Restyle it", "assistant:Applied."])
    expect(result.second.stepsUnread).toBeUndefined()
    expect(result.second.agentId).toBe("bc-1")
  })

  test("a version 1 thread keeps its inline steps when the move cannot be saved", async () => {
    const inline = [
      { kind: "user", text: "Restyle it", at: 1 },
      { kind: "assistant", text: "Applied.", at: 2 }
    ]
    const steps = flakySteps()
    steps.failSaves(1)
    const metadata = spyStorage({
      "thread-1": { agentId: "bc-1", steps: inline, identity: IDENTITY }
    })
    const result = await Effect.runPromise(
      Effect.provide(
        CursorStore.use((store) =>
          Effect.gen(function* () {
            const first = yield* store.read("thread-1")
            yield* store.write("thread-1", {
              agentId: "bc-1",
              steps: [...first.steps, { kind: "user", text: "Again", at: 9 }],
              identity: IDENTITY
            })
            return { first, second: yield* store.read("thread-1") }
          })
        ),
        cursorStoreLayer(metadata, { steps, onFailure: () => Effect.void })
      )
    )

    const record = metadata.peek()["thread-1"] as Record<string, unknown>
    // The steps are still where version 1 keeps them, and the record still says so.
    expect(record.version).toBe(1)
    expect(record.steps).toEqual(inline)
    expect(steps.peek("thread-1")).toBeUndefined()
    // So the thread reads its history back, which is the whole point of not moving it.
    expect(said(result.second.steps)).toEqual(["user:Restyle it", "assistant:Applied."])
    expect(result.second.agentId).toBe("bc-1")
    expect(result.second.identity).toEqual(IDENTITY)
  })

  test("the move to the step store finishes on the write after the failing one", async () => {
    const inline = [{ kind: "user", text: "Restyle it", at: 1 }]
    const steps = flakySteps()
    steps.failSaves(1)
    const metadata = spyStorage({ "thread-1": { agentId: "bc-1", steps: inline } })
    const read = await Effect.runPromise(
      Effect.provide(
        CursorStore.use((store) =>
          Effect.gen(function* () {
            const first = yield* store.read("thread-1")
            yield* store.write("thread-1", { agentId: "bc-1", steps: first.steps })
            const retried = yield* store.read("thread-1")
            yield* store.write("thread-1", {
              agentId: "bc-1",
              steps: [...retried.steps, { kind: "assistant", text: "Applied.", at: 2 }]
            })
            return yield* store.read("thread-1")
          })
        ),
        cursorStoreLayer(metadata, { steps, onFailure: () => Effect.void })
      )
    )

    const record = metadata.peek()["thread-1"] as Record<string, unknown>
    expect(record.version).toBe(CURSOR_RECORD_VERSION)
    expect(record.steps).toBeUndefined()
    expect(said(read.steps)).toEqual(["user:Restyle it", "assistant:Applied."])
  })

  test("dropping a thread leaves the other threads in place", async () => {
    const [dropped, kept] = await withStore(
      CursorStore.use((store) =>
        Effect.gen(function* () {
          yield* store.write("thread-1", { ...EMPTY_CURSOR_STATE, agentId: "bc-1" })
          yield* store.write("thread-2", { ...EMPTY_CURSOR_STATE, agentId: "bc-2" })
          yield* store.drop("thread-1")
          return [yield* store.read("thread-1"), yield* store.read("thread-2")] as const
        })
      )
    )
    expect(dropped).toEqual(EMPTY_CURSOR_STATE)
    expect(kept.agentId).toBe("bc-2")
  })
})
