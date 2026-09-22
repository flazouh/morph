import { Context, Effect, Layer, Option, Schema, Semaphore } from "effect"
import { Spend } from "../agent/spend"
import { RelayIdentity } from "../relay/extension"
import type { Step, TurnView } from "../session/contract"
import { CursorStep } from "./messages"

export { CursorStep }

/**
 * What a Cursor thread keeps between panel openings.
 *
 * The Cursor session's log is a list of steps, not a runtime event log, so it is stored
 * apart from the OpenRouter log. A reader who switches provider and switches back finds
 * both histories where they were.
 *
 * The record is split by size. The small, bounded part — the agent to continue, the relay
 * bridge, the run that was live, the spend — sits in one `chrome.storage.local` object
 * with every other thread's. The step history, which grows without a bound, gets one
 * durable record of its own per thread. See `steps.ts` for why.
 *
 * Every field decodes on its own. A build that wrote a field this one cannot read, or a
 * single step in a shape that changed, must cost the reader that field and nothing more:
 * a thread is a reader's work, and one unreadable number is no reason to erase it.
 */

const KEY = "cursorThreads"

/**
 * Version 1 kept the steps inline in the shared record. Version 2 moved them to the step
 * store. A record with no version is version 1, and its inline steps are read as they
 * were written; the thread's next write moves them.
 */
export const CURSOR_RECORD_VERSION = 2

/** The run that was live when the panel went away, so a reopened panel can rejoin it. */
export const ActiveRun = Schema.Struct({
  agentId: Schema.NonEmptyString,
  runId: Schema.NonEmptyString,
  startedAt: Schema.Number
})
export type ActiveRun = typeof ActiveRun.Type

export const CursorThreadState = Schema.Struct({
  /** The Cursor cloud agent this thread continues. Absent until the first send creates one. */
  agentId: Schema.optionalKey(Schema.NonEmptyString),
  steps: Schema.Array(CursorStep),
  /** The relay bridge this thread reconnects with. */
  identity: Schema.optionalKey(RelayIdentity),
  activeRun: Schema.optionalKey(ActiveRun),
  spend: Schema.optionalKey(Spend)
})
export type CursorThreadState = typeof CursorThreadState.Type

/**
 * The live state of one thread's session: the persisted record, plus the reducer-owned
 * turn and the per-tool turn map that exist only while the panel is open.
 */
export interface SessionState {
  readonly agentId: string | undefined
  readonly steps: ReadonlyArray<Step>
  readonly identity: RelayIdentity | undefined
  /**
   * The run in flight. This is the whole answer to "is this thread working": a run that
   * is live is the working state, so there is no second flag to fall out of step with it.
   */
  readonly activeRun: ActiveRun | undefined
  readonly spend: Spend
  /** The reducer-owned live turn. It is never persisted as transcript history. */
  readonly turn: TurnView
  /** Monotonic identity for the live turn, including its run-creation window. */
  readonly turnId: number
  /** The turn that started each tool, so a late result cannot change a newer phase. */
  readonly toolTurns: ReadonlyMap<string, number>
}

/**
 * What a read of a thread found.
 *
 * `stepsUnread` is the difference between a thread with no history and a thread whose
 * history nobody could read. They look the same in the steps, and they are not the same:
 * one may be written over and the other may not. A reader's transcript is their work, and
 * a store that failed once must not cost them it.
 */
export interface CursorThreadRead extends CursorThreadState {
  /** Set when the step store could not answer, so these steps are not the history. */
  readonly stepsUnread?: boolean
}

/** The steps are the panel's `Step` list. This holds the two shapes together. */
const _stepsAreSteps: ReadonlyArray<Step> = [] as CursorThreadState["steps"]

export const EMPTY_CURSOR_STATE: CursorThreadState = { steps: [] }

/** A persisted read, write or delete that did not happen. Carries no page data. */
export class CursorStorageError extends Schema.TaggedError<CursorStorageError>()(
  "CursorStorageError",
  {
    operation: Schema.Literals(["read", "write", "drop"]),
    /** The name of the failure, never the value that caused it. */
    detail: Schema.String
  }
) {
  override readonly message = `Could not ${this.operation} the Cursor thread history (${this.detail})`
}

/** The small metadata every thread shares one record with. */
export interface CursorStorage {
  readonly read: () => Effect.Effect<unknown>
  readonly write: (value: Record<string, unknown>) => Effect.Effect<void>
}

/** One durable record per thread, holding that thread's whole step history. */
export interface CursorStepStorage {
  readonly load: (threadId: string) => Effect.Effect<unknown, CursorStorageError>
  readonly save: (
    threadId: string,
    steps: ReadonlyArray<unknown>
  ) => Effect.Effect<void, CursorStorageError>
  readonly drop: (threadId: string) => Effect.Effect<void, CursorStorageError>
}

const StoredThreads = Schema.Record(Schema.String, Schema.Unknown)
const StoredRecord = Schema.Record(Schema.String, Schema.Unknown)

/**
 * The shared record, without the two fields that say where the history is.
 *
 * `version` and, for version 1, `steps` belong to whichever store holds the history, so
 * the write path decides them from what the step store did. See `historyFields`.
 */
const StoredMetadata = Schema.Struct({
  agentId: Schema.optionalKey(Schema.NonEmptyString),
  identity: Schema.optionalKey(RelayIdentity),
  activeRun: Schema.optionalKey(ActiveRun),
  spend: Schema.optionalKey(Spend)
})

const StepList = Schema.Array(CursorStep)

const decodeStored = Schema.decodeUnknownOption(StoredThreads)
const decodeRecord = Schema.decodeUnknownOption(StoredRecord)
const decodeVersion = Schema.decodeUnknownOption(Schema.Number)
const decodeAgentId = Schema.decodeUnknownOption(Schema.NonEmptyString)
const decodeIdentity = Schema.decodeUnknownOption(RelayIdentity)
const decodeActiveRun = Schema.decodeUnknownOption(ActiveRun)
const decodeSpend = Schema.decodeUnknownOption(Spend)
const decodeStepList = Schema.decodeUnknownOption(StepList)
const decodeStep = Schema.decodeUnknownOption(CursorStep)
const encodeMetadata = Schema.encodeUnknownOption(StoredMetadata)
const encodeStepList = Schema.encodeUnknownOption(StepList)

/** Whatever of this list decodes as steps, in order. */
const stepsOf = (value: unknown): ReadonlyArray<Step> => {
  const whole = decodeStepList(value)
  if (Option.isSome(whole)) return whole.value
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const step = decodeStep(entry)
    return Option.isSome(step) ? [step.value] : []
  })
}

export class CursorStore extends Context.Service<
  CursorStore,
  {
    readonly read: (threadId: string) => Effect.Effect<CursorThreadRead>
    readonly write: (threadId: string, state: CursorThreadState) => Effect.Effect<void>
    readonly drop: (threadId: string) => Effect.Effect<void>
  }
>()("morph/cursor/CursorStore") {}

/** A thread whose history could not be read, and whether a write already reported it. */
interface UnreadHistory {
  readonly told: boolean
}

export interface CursorStoreOptions {
  /** Where the step history lives. Defaults to memory, which the panel never uses. */
  readonly steps?: CursorStepStorage
  /**
   * Told about a persisted read, write or delete that did not happen. The Session stays
   * usable either way: the steps it holds in memory are still the ones it draws.
   */
  readonly onFailure?: (failure: CursorStorageError) => Effect.Effect<void>
}

/**
 * One metadata record per thread inside one stored object, and one step record per thread
 * beside it. Metadata writes take a permit, so two threads saving at the same moment
 * cannot drop each other's record; step writes need no permit, because no two threads
 * share a step record.
 */
export const cursorStoreLayer = (
  storage: CursorStorage,
  options: CursorStoreOptions = {}
): Layer.Layer<CursorStore> =>
  Layer.effect(
    CursorStore,
    Effect.gen(function* () {
      const gate = yield* Semaphore.make(1)
      const stepStorage = options.steps ?? memoryCursorStepStorage()
      const report = (failure: CursorStorageError) =>
        options.onFailure?.(failure) ?? Effect.logWarning(failure.message)

      /**
       * Threads whose step history the store could not read, and whether a write has
       * already said so.
       *
       * A thread in here has a history this store knows nothing about. The caller read an
       * empty list and went on working from it, so saving its steps would replace a
       * transcript nobody could read with the part that came after it. Only a successful
       * read takes a thread out again, and a read hands the caller a new state to work
       * from, so there is no moment where a part of a history can be saved as the whole
       * of one.
       */
      const unread = new Map<string, UnreadHistory>()

      const all = Effect.fn("CursorStore.all")(function* () {
        const raw = yield* storage.read()
        const decoded = decodeStored(raw)
        return Option.isNone(decoded) ? {} : decoded.value
      })

      /**
       * The thread's steps, from wherever that version of the record keeps them, and
       * whether that place answered.
       *
       * Version 1 wrote them inline. Version 2 keeps them in the step store, and a store
       * that cannot answer costs the reader the transcript, not the thread: the agent id,
       * the bridge and the spend are all still in the record beside it. It must not cost
       * them the transcript twice, so the thread is marked and nothing writes over a
       * history it could not read.
       */
      const historyOf = Effect.fn("CursorStore.historyOf")(function* (
        threadId: string,
        version: number,
        fields: Record<string, unknown>
      ) {
        if (version < CURSOR_RECORD_VERSION) {
          // Version 1 keeps the steps inside the record just read. Nothing can fail here.
          unread.delete(threadId)
          return { steps: stepsOf(fields.steps), read: true }
        }
        const loaded = yield* Effect.option(Effect.tapError(stepStorage.load(threadId), report))
        if (Option.isNone(loaded)) {
          unread.set(threadId, { told: false })
          return { steps: [], read: false }
        }
        unread.delete(threadId)
        return { steps: stepsOf(loaded.value), read: true }
      })

      const read = Effect.fn("CursorStore.read")(function* (threadId: string) {
        const stored = yield* all()
        const record = decodeRecord(stored[threadId])
        if (Option.isNone(record)) {
          // A thread with no record has no history for a write to overwrite, so a mark an
          // earlier failed read left goes. A record that is there but unreadable keeps it.
          if (stored[threadId] === undefined) unread.delete(threadId)
          return EMPTY_CURSOR_STATE
        }
        const fields = record.value
        const version = Option.getOrElse(decodeVersion(fields.version), () => 1)
        // Every field on its own, so one unreadable one costs the reader that field only.
        const agentId = Option.getOrUndefined(decodeAgentId(fields.agentId))
        const identity = Option.getOrUndefined(decodeIdentity(fields.identity))
        const activeRun = Option.getOrUndefined(decodeActiveRun(fields.activeRun))
        const spend = Option.getOrUndefined(decodeSpend(fields.spend))
        const history = yield* historyOf(threadId, version, fields)
        return {
          ...(agentId === undefined ? {} : { agentId }),
          steps: history.steps,
          ...(history.read ? {} : { stepsUnread: true }),
          ...(identity === undefined ? {} : { identity }),
          ...(activeRun === undefined ? {} : { activeRun }),
          ...(spend === undefined ? {} : { spend })
        }
      })

      /**
       * Puts this thread's history in the step store, and answers whether the store holds
       * it now. A false answer leaves the stored history alone, whatever it is.
       */
      const saveHistory = Effect.fn("CursorStore.saveHistory")(function* (
        threadId: string,
        steps: ReadonlyArray<Step>
      ) {
        const mark = unread.get(threadId)
        if (mark !== undefined) {
          // Said once for the thread, not once for every step it goes on to take.
          if (!mark.told) {
            unread.set(threadId, { told: true })
            yield* report(
              new CursorStorageError({ operation: "write", detail: "history was not read" })
            )
          }
          return false
        }
        const encoded = encodeStepList(steps)
        if (Option.isNone(encoded)) {
          yield* report(new CursorStorageError({ operation: "write", detail: "unencodable steps" }))
          return false
        }
        const saved = yield* Effect.option(
          Effect.tapError(stepStorage.save(threadId, encoded.value), report)
        )
        return Option.isSome(saved)
      })

      /**
       * The two fields that say where this thread's history is.
       *
       * With the save committed, it is the step store: version 2, and no steps in the
       * shared record. Without it, the record keeps the version and the inline steps it
       * already had, so a version 1 thread whose move did not commit still reads its own
       * steps back, and a version 2 thread keeps pointing at the history in the store.
       */
      const historyFields = (previous: unknown, saved: boolean): Record<string, unknown> => {
        if (saved) return { version: CURSOR_RECORD_VERSION }
        const record = decodeRecord(previous)
        if (Option.isNone(record)) return { version: 1 }
        const version = Option.getOrElse(decodeVersion(record.value.version), () => 1)
        const steps = record.value.steps
        return version < CURSOR_RECORD_VERSION && steps !== undefined ? { version, steps } : { version }
      }

      const write = Effect.fn("CursorStore.write")(function* (
        threadId: string,
        state: CursorThreadState
      ) {
        // The steps go first, for two reasons. A quota failure still leaves the agent id
        // reachable, so the next send continues the same Cursor agent instead of starting
        // a new one. And only the step store can say whether it took the history, which
        // is what the record has to record.
        const saved = yield* saveHistory(threadId, state.steps)
        const encoded = encodeMetadata({
          ...(state.agentId === undefined ? {} : { agentId: state.agentId }),
          ...(state.identity === undefined ? {} : { identity: state.identity }),
          ...(state.activeRun === undefined ? {} : { activeRun: state.activeRun }),
          ...(state.spend === undefined ? {} : { spend: state.spend })
        })
        if (Option.isNone(encoded)) {
          return yield* report(
            new CursorStorageError({ operation: "write", detail: "unencodable thread record" })
          )
        }
        yield* gate.withPermits(1)(
          Effect.gen(function* () {
            const stored = yield* all()
            const record = { ...encoded.value, ...historyFields(stored[threadId], saved) }
            yield* storage.write({ ...stored, [threadId]: record })
          })
        )
      })

      const drop = Effect.fn("CursorStore.drop")(function* (threadId: string) {
        // A delete goes through even for a thread whose history could not be read. The
        // reader closed the thread, and its metadata goes with it, so a step record held
        // back here would be one nothing could ever reach again.
        yield* Effect.ignore(Effect.tapError(stepStorage.drop(threadId), report))
        unread.delete(threadId)
        yield* gate.withPermits(1)(
          Effect.gen(function* () {
            const stored = yield* all()
            if (!(threadId in stored)) return
            const next = { ...stored }
            delete next[threadId]
            yield* storage.write(next)
          })
        )
      })

      return CursorStore.of({ read, write, drop })
    })
  )

export const memoryCursorStorage = (initial: unknown = {}): CursorStorage => {
  let value: unknown = initial
  return {
    read: () => Effect.sync(() => value),
    write: (next) =>
      Effect.sync(() => {
        value = next
      })
  }
}

export const memoryCursorStepStorage = (): CursorStepStorage & {
  readonly peek: () => Record<string, unknown>
} => {
  const records = new Map<string, ReadonlyArray<unknown>>()
  return {
    load: (threadId) => Effect.sync(() => records.get(threadId)),
    save: (threadId, steps) =>
      Effect.sync(() => {
        records.set(threadId, steps)
      }),
    drop: (threadId) =>
      Effect.sync(() => {
        records.delete(threadId)
      }),
    peek: () => Object.fromEntries(records)
  }
}

/** `chrome.storage.local`: small metadata only. The steps live in IndexedDB beside it. */
export const chromeCursorStorage: CursorStorage = {
  read: () =>
    Effect.tryPromise(async () => (await chrome.storage.local.get(KEY))[KEY]).pipe(
      Effect.catch(() => Effect.succeed(undefined))
    ),
  write: (value) =>
    Effect.tryPromise(() => chrome.storage.local.set({ [KEY]: value })).pipe(
      Effect.catch(() => Effect.void)
    )
}

export const memoryCursorStore = (initial: unknown = {}): Layer.Layer<CursorStore> =>
  cursorStoreLayer(memoryCursorStorage(initial))
