/**
 * Reading one Cursor run to its end.
 *
 * The stream is Cursor's account of the run, and it breaks for reasons that say nothing
 * about the run itself: the service worker reloads, the network drops, the agent behind
 * the run dies. So a break never settles a run here. The run's own record at Cursor
 * decides what the break meant: a finished run folds its real ending into the
 * transcript, a live one gets one more read (from the last event id, or from the top
 * when nothing was applied yet), and a gone one costs the agent, not the thread. A live
 * run Morph cannot read at all is followed through its record instead: the reader keeps
 * the turn, and with it the tool gate the agent calls back through, until Cursor says the
 * run ended. Seen live on 2026-09-13: a read that gave up closed the gate under a live
 * run, and the agent's three tool calls came back "outside an open run".
 */

import { Effect, Stream } from "effect"
import type { UserStep } from "../session/contract"
import { CursorClient, isTerminal, type CursorEvent, type CursorFailure, type CursorRunStatus } from "./api"
import type { ActiveRun } from "./state"
import { cursorFinalText, terminalTurnEvent, type CursorTurnEvent } from "./turn"

export const NO_TERMINAL_STATUS = "The Cursor run stream ended without a final status."
export const CURSOR_AGENT_GONE =
  "Cursor no longer holds this agent, so the run cannot continue. Send again, and Morph starts a fresh agent."
export const CURSOR_RUN_GONE =
  "Cursor no longer holds this run, so it cannot continue. Send again, and Morph starts a new run on the same agent."
/** The notice for a live run whose stream Morph lost, with what the stream said when it broke. */
export const streamUnreadable = (detail: string): string =>
  `Morph lost this run's stream (${detail}), but Cursor says the run is still going. Morph follows it through the run's record: the text it streams from here is lost, its tool calls and its result are not. Stop cancels it.`

/** How often a followed run's record is read. */
export const FOLLOW_EVERY_MS = 5_000
/**
 * How long the reader waits before reading a stream again from the top. Seen live on
 * 2026-09-13 on an agent with a long history: Cursor's stream said `stream_unavailable`
 * 1.4 s into a live run, and the same request 4 s later streamed the whole run.
 */
export const RETRY_STREAM_AFTER_MS = 3_000
/** Consecutive record reads that may fail before the follow gives up and keeps the run for Stop. */
const FOLLOW_FAILURES = 5

/** True when this event ends the run's stream. */
const endsRun = (event: CursorEvent): boolean =>
  (event._tag === "status" && isTerminal(event.status)) ||
  (event._tag === "result" && isTerminal(event.status)) ||
  event._tag === "error"

/**
 * The first frame of a run stream is Cursor's status at connect time, and it carries no
 * event id. On a run that already ended it says FINISHED ahead of the replay of the run,
 * so it must not end the read: the run is in the frames behind it. Morph joins late
 * whenever Cursor's create call answers after the run it started has finished, which it
 * did live when the run's tools ran through the relay meanwhile.
 */
const withoutOpeningSnapshot = <E, R>(events: Stream.Stream<CursorEvent, E, R>): Stream.Stream<CursorEvent, E, R> => {
  let opening = true
  return Stream.filter(events, (event) => {
    const snapshot = opening && event._tag === "status"
    opening = false
    return !snapshot
  })
}

/** What a broken read learned from the run's own record at Cursor. */
type ReadVerdict =
  | { readonly action: "reattach" }
  | { readonly action: "follow" }
  | { readonly action: "done"; readonly keepRun: boolean }

/** How far one run's reads got: what a recovery may resume, replay, or must not double. */
interface ReadProgress {
  /** Whether a second read already happened; the reader gets one. */
  readonly resumed: boolean
  /** Whether a read put anything but a status into the transcript. */
  readonly applied: boolean
  readonly answerDraft: string
  readonly lastEventId: string | undefined
}

/** Waits, or returns early when the reader is stopped. */
const pause = (ms: number, signal: AbortSignal): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    if (signal.aborted) {
      resume(Effect.void)
      return
    }
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resume(Effect.void)
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener("abort", done, { once: true })
    return Effect.sync(done)
  })

/** What the session hands the reader: the transcript transitions a read can make. */
export interface RunReaderDeps {
  readonly client: CursorClient["Service"]
  /** How often a followed run's record is read. Tests shorten it. */
  readonly followEveryMs?: number
  /** The wait before a stream that gave up before any content is read again. Tests shorten it. */
  readonly retryStreamAfterMs?: number
  /** The agent Cursor no longer holds is dropped, so the next send creates a fresh one. */
  readonly dropAgent: Effect.Effect<void>
  readonly appendError: (
    text: string,
    active?: ActiveRun,
    turnId?: number,
    affectTurn?: boolean
  ) => Effect.Effect<void>
  readonly applyEvent: (
    active: ActiveRun,
    turnId: number,
    user: UserStep | undefined,
    answerDraft: string,
    event: CursorEvent
  ) => Effect.Effect<void>
  readonly applyTerminal: (
    active: ActiveRun,
    turnId: number,
    user: UserStep | undefined,
    transition: CursorTurnEvent
  ) => Effect.Effect<void>
}

export const makeRunReader = (deps: RunReaderDeps) => {
  const { client, dropAgent, appendError, applyEvent, applyTerminal } = deps
  const followEveryMs = deps.followEveryMs ?? FOLLOW_EVERY_MS
  const retryStreamAfterMs = deps.retryStreamAfterMs ?? RETRY_STREAM_AFTER_MS

  const lookUpRun = (apiKey: string, active: ActiveRun, signal: AbortSignal) =>
    client
      .getRun({ apiKey, agentId: active.agentId, runId: active.runId, signal })
      .pipe(
        Effect.map((runInfo) => ({ kind: "run" as const, runInfo })),
        Effect.catch((failure: CursorFailure) => Effect.succeed({ kind: "failure" as const, failure }))
      )

  /**
   * What a refused Get A Run means for the run. Only the codes that name the agent drop
   * it. A bare 404 or 410 is the run's record, not the agent: settling only the run keeps
   * the agent's context, and a truly gone agent is caught by the next send's createRun.
   * Any other refusal means Cursor cannot say what the run did.
   */
  const settleGone = Effect.fn("CursorReader.settleGone")(function* (
    failure: CursorFailure,
    active: ActiveRun,
    turnId: number,
    quiet: boolean
  ): Effect.fn.Return<boolean, never> {
    const agentGone =
      failure._tag === "CursorApiError" &&
      (failure.code === "agent_not_found" || failure.code === "agent_archived")
    if (agentGone) {
      yield* dropAgent
      if (!quiet) yield* appendError(CURSOR_AGENT_GONE, active, turnId)
      return true
    }
    if (failure._tag === "CursorApiError" && (failure.status === 404 || failure.status === 410)) {
      if (!quiet) yield* appendError(CURSOR_RUN_GONE, active, turnId)
      return true
    }
    return false
  })

  /** Folds a run's real ending from its record into the turn. */
  const settleFromRecord = Effect.fn("CursorReader.settleFromRecord")(function* (
    runInfo: { readonly status: CursorRunStatus; readonly result?: string },
    active: ActiveRun,
    turnId: number,
    user: UserStep | undefined,
    quiet: boolean,
    answerDraft: string,
    detail: string
  ) {
    const transition = terminalTurnEvent(runInfo.status, cursorFinalText(runInfo.result, answerDraft))
    if (transition !== undefined) yield* applyTerminal(active, turnId, user, transition)
    if ((runInfo.status === "ERROR" || runInfo.status === "EXPIRED") && !quiet) {
      yield* appendError(detail, active, turnId, false)
    }
  })

  /**
   * Follows a live run Morph cannot read through its record until Cursor says it ended,
   * or the reader is stopped. The turn, and the tool gate with it, stay the run's for
   * the whole of it. A record Cursor cannot give for a while is asked again; one it
   * cannot give at all leaves the run stored, so Stop can still reach it.
   */
  const followRun = Effect.fn("CursorReader.followRun")(function* (
    apiKey: string,
    active: ActiveRun,
    turnId: number,
    user: UserStep | undefined,
    quiet: boolean,
    signal: AbortSignal,
    answerDraft: string,
    /** What the stream said when it broke, for a run that then ended in error. */
    detail: string
  ): Effect.fn.Return<{ readonly keepRun: boolean }, never> {
    let failures = 0
    for (;;) {
      yield* pause(followEveryMs, signal)
      if (signal.aborted) return { keepRun: false }
      const lookedUp = yield* lookUpRun(apiKey, active, signal)
      if (signal.aborted) return { keepRun: false }
      if (lookedUp.kind === "failure") {
        if (yield* settleGone(lookedUp.failure, active, turnId, quiet)) return { keepRun: false }
        failures += 1
        if (failures < FOLLOW_FAILURES) continue
        if (!quiet) yield* appendError(lookedUp.failure.message, active, turnId)
        return { keepRun: true }
      }
      failures = 0
      if (!isTerminal(lookedUp.runInfo.status)) continue
      yield* settleFromRecord(lookedUp.runInfo, active, turnId, user, quiet, answerDraft, detail)
      return { keepRun: false }
    }
  })

  const recoverRead = Effect.fn("CursorReader.recoverRead")(function* (
    apiKey: string,
    active: ActiveRun,
    turnId: number,
    user: UserStep | undefined,
    /** A rejoined run must not turn a stale record into an error the reader sees. */
    quiet: boolean,
    signal: AbortSignal,
    /** What the stream said when it broke: Cursor's refusal, its error event, or a bare end. */
    detail: string,
    progress: ReadProgress
  ): Effect.fn.Return<ReadVerdict, never> {
    const { resumed, applied, answerDraft, lastEventId } = progress
    const lookedUp = yield* lookUpRun(apiKey, active, signal)
    // A Stop that landed while Cursor answered settles the run, never keeps it, and adds
    // no error step to a turn the reader ended.
    if (signal.aborted) return { action: "done", keepRun: false }
    if (lookedUp.kind === "failure") {
      if (yield* settleGone(lookedUp.failure, active, turnId, quiet)) return { action: "done", keepRun: false }
      // Cursor cannot say what the run did. Keep it, so Stop can still reach it.
      if (!quiet) yield* appendError(detail, active, turnId)
      return { action: "done", keepRun: true }
    }
    const runInfo = lookedUp.runInfo
    if (!isTerminal(runInfo.status)) {
      // The run outlived its stream. One more read picks it up: from the last event id
      // when there is one, or from the top when nothing was applied yet, since that
      // replay doubles nothing. Without either, the replay would double text the
      // transcript already holds.
      if (!resumed && lastEventId !== undefined) return { action: "reattach" }
      if (!resumed && !applied) {
        yield* pause(retryStreamAfterMs, signal)
        return signal.aborted ? { action: "done", keepRun: false } : { action: "reattach" }
      }
      // A Get A Run answer that just proved the run live is current truth, never a
      // stale record, so this one is said even on a quiet rejoin. It is a notice, not
      // the turn's end: the turn stays live for the tool calls and the result to come.
      yield* appendError(streamUnreadable(detail), active, turnId, false)
      return { action: "follow" }
    }
    // The run settled while its stream was broken. Fold its real ending, not the break.
    yield* settleFromRecord(runInfo, active, turnId, user, quiet, answerDraft, detail)
    return { action: "done", keepRun: false }
  })

  /**
   * Reads one run's stream to its end, recovering from a break through the run's own
   * record. The end says whether the run stays stored: a run Cursor still holds but
   * Morph cannot read is kept, so Stop and the next send can still reach it.
   */
  const readRun = Effect.fnUntraced(function* (
    apiKey: string,
    active: ActiveRun,
    turnId: number,
    user: UserStep | undefined,
    quiet: boolean,
    signal: AbortSignal
  ) {
    let lastEventId: string | undefined
    let answerDraft = ""
    let resumed = false
    let applied = false
    for (;;) {
      let terminal = false
      let streamError: string | undefined
      const read = yield* Stream.runForEach(
        Stream.takeUntil(
          withoutOpeningSnapshot(
            client.streamRun({
              apiKey,
              agentId: active.agentId,
              runId: active.runId,
              ...(lastEventId === undefined ? {} : { lastEventId }),
              signal
            })
          ),
          endsRun
        ),
        (event) =>
          Effect.gen(function* () {
            if (event.id !== undefined) lastEventId = event.id
            // An error event is the stream giving up, not the run ending. The run's own
            // record decides what it meant, so it is recovered, never appended raw.
            if (event._tag === "error") {
              streamError = event.message
              return
            }
            if (endsRun(event)) terminal = true
            if (event._tag === "assistant") answerDraft += event.text
            if (event._tag !== "status") applied = true
            yield* applyEvent(active, turnId, user, answerDraft, event)
          })
      ).pipe(
        Effect.map(() => ({ kind: "ended" as const })),
        Effect.catch((failure: CursorFailure) => Effect.succeed({ kind: "failed" as const, failure }))
      )
      // A read the reader stopped ended on purpose: Stop and scope close settle it.
      if (signal.aborted) return { keepRun: false }
      if (read.kind === "ended" && terminal) return { keepRun: false }
      const detail = read.kind === "failed" ? read.failure.message : (streamError ?? NO_TERMINAL_STATUS)
      const verdict = yield* recoverRead(
        apiKey,
        active,
        turnId,
        user,
        quiet,
        signal,
        detail,
        { resumed, applied, answerDraft, lastEventId }
      )
      if (verdict.action === "done") return { keepRun: verdict.keepRun }
      if (verdict.action === "follow") {
        return yield* followRun(apiKey, active, turnId, user, quiet, signal, answerDraft, detail)
      }
      resumed = true
    }
  })

  return { readRun }
}
