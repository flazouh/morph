import { Clock, Deferred, Effect, Fiber, Layer, Option, Ref, Schedule, Scope, Semaphore } from "effect"
import { Designs } from "../agent/designs"
import { CREW_ROLES } from "../agent/crew/roles"
import { siteKey } from "../agent/page"
import { hasApplied } from "../agent/applied"
import { NO_CURSOR_SPEND, sameSpend, type Spend } from "../agent/spend"
import { appliedFrom, SYSTEM, type PagePublishContext } from "../agent/tools"
import { pathOf } from "../bridge/scope"
import type { PagePublisher } from "../agent/page-publish-tools"
import type { World } from "../agent/world"
import {
  ExtensionRelay,
  RelayLink,
  RelayThreadOwnership,
  type RelayIdentity,
  type RelayThreadOwnedError
} from "../relay/extension"
import type {
  RunState,
  Session,
  Settings,
  Step,
  ToolStep,
  TurnView,
  UserStep
} from "../session/contract"
import {
  CursorClient,
  isAgentBusy,
  isAgentGone,
  isRunNotCancellable,
  isTerminal,
  type CursorEvent,
  type CursorFailure,
  type CursorMcpServer
} from "./api"
import { delegationCallId, delegationStep } from "./delegation"
import { makeRunOwnership } from "./ownership"
import { makeRunReader } from "./read"
import {
  CursorStore,
  type ActiveRun,
  type CursorThreadRead,
  type CursorThreadState,
  type SessionState
} from "./state"
import {
  cursorFinalText,
  initialCursorTurn,
  isCursorTurnActive,
  normalizeCursorTranscript,
  reduceCursorTurn,
  terminalTurnEvent,
  type CursorTurnEvent
} from "./turn"

/**
 * The Session over a Cursor cloud agent.
 *
 * One thread owns one agent. A send creates the agent (first time) or a run on it, then
 * reads that run's SSE stream: text becomes assistant steps, status drives the run state.
 * Tool steps never come from the stream. They come from the extension's own tool server,
 * so `applied` reads the same results it reads under OpenRouter.
 *
 * This runs in the MV3 service worker. The panel reaches it through the background
 * Session proxy, so closing the panel iframe never stops a run.
 */

export const CURSOR_KEY_MISSING = "Add your Cursor API key in settings first."
export const RELAY_UNREACHABLE = "Morph could not reach its relay service. Try again in a moment."
export const RUN_BUSY_NOT_SENT =
  "That message was not sent: a run is already on record at Cursor. Morph reattached to its stream."

/** The MCP server name the cloud agent sees. One server, this thread's relay bridge. */
export const MCP_SERVER_NAME = "morph"

const RELAY_READY_MS = 10_000

export interface CursorSessionOptions {
  readonly url: string
  readonly threadId: string
  /** The tab this thread acts on. One tab owns an active site thread. */
  readonly tabId: number
  readonly relayUrl: string
  readonly settings: () => Promise<Settings>
  readonly world: Layer.Layer<World>
  /** Called on reset, after the steps are dropped: undo what the page still wears. */
  readonly forget: () => Promise<void>
  readonly forgetSite: () => Promise<void>
  /** Where the page's own redesign publishes to. Absent when the page runs an installed Morph. */
  readonly publisher?: PagePublisher
  /** How long a send waits for the relay bridge before it gives up. */
  readonly relayReadyMs?: number
  readonly reconnectBaseDelayMs?: number
  /** How often an open run pings the relay, which keeps the service worker alive. */
  readonly heartbeatMs?: number
  /** How often a run whose stream Morph lost is followed through its record. */
  readonly followEveryMs?: number
  /** The wait before a stream that gave up before any content is read again. Tests shorten it. */
  readonly retryStreamAfterMs?: number
  /** The wait between creates while Cursor still calls the agent busy over a run that ended. */
  readonly busyRetryMs?: number
}

/**
 * How many times a create is asked again while Cursor calls the agent busy over a run it
 * already ended. Seen live on 2026-09-13: a cancel settles at Cursor a few hundred ms after
 * its answer, and a create in that window is refused.
 */
const BUSY_RETRIES = 6
const BUSY_RETRY_MS = 500

/**
 * The transcript could not be read, so the reader is told rather than shown an empty
 * thread. The steps are still where they were: the store refuses to write over a history
 * it could not read, and the next opening of this thread reads it again.
 */
export const HISTORY_UNREADABLE =
  "Morph could not read this thread's earlier steps. They are still saved."

const stateOf = (record: CursorThreadRead): SessionState => ({
  agentId: record.agentId,
  steps:
    record.stepsUnread === true
      ? [{ kind: "error", text: HISTORY_UNREADABLE, at: Date.now() }]
      : normalizeCursorTranscript(record.steps),
  identity: record.identity,
  activeRun: record.activeRun,
  spend: record.spend ?? NO_CURSOR_SPEND,
  turn: initialCursorTurn,
  turnId: 0,
  toolTurns: new Map()
})

const recordOf = (state: SessionState): CursorThreadState => ({
  ...(state.agentId === undefined ? {} : { agentId: state.agentId }),
  steps: state.steps,
  ...(state.identity === undefined ? {} : { identity: state.identity }),
  ...(state.activeRun === undefined ? {} : { activeRun: state.activeRun }),
  spend: state.spend
})

/** The same record twice means nothing worth writing changed. */
const samePersisted = (a: SessionState, b: SessionState): boolean =>
  a.agentId === b.agentId &&
  a.steps === b.steps &&
  a.identity === b.identity &&
  a.activeRun === b.activeRun &&
  a.spend === b.spend

const activityStep = (turn: TurnView): Step | undefined =>
  turn.activityText === ""
    ? undefined
    : { kind: "thinking", text: turn.activityText, at: turn.startedAt }

/** Fold live activity into history without ever turning it into an answer. */
const settleActivity = (state: SessionState): SessionState => {
  const activity = activityStep(state.turn)
  if (activity === undefined) return state
  return {
    ...state,
    steps: [...state.steps, activity],
    turn: { ...state.turn, activityText: "", answerDraft: "" }
  }
}

/** Fold a terminal turn into history. Only `finalAnswer` becomes an assistant step. */
const settleTurn = (state: SessionState): SessionState => {
  const activityText =
    state.turn.phase === "complete" &&
    state.turn.answerDraft !== "" &&
    state.turn.activityText.endsWith(state.turn.answerDraft)
      ? state.turn.activityText.slice(0, -state.turn.answerDraft.length)
      : state.turn.activityText
  const settled = settleActivity({
    ...state,
    turn: { ...state.turn, activityText }
  })
  if (settled.turn.phase !== "complete" || settled.turn.finalAnswer === "") return settled
  return {
    ...settled,
    steps: [
      ...settled.steps,
      { kind: "assistant", text: settled.turn.finalAnswer, at: Date.now() }
    ]
  }
}

/**
 * Drops one thread's Cursor state without opening a session for it. The reader closed a
 * thread the service worker never held, or held and forgot. A refused archive stays here.
 */
export const forgetCursorThread = Effect.fn("forgetCursorThread")(function* (
  threadId: string,
  apiKey: string
): Effect.fn.Return<void, never, CursorClient | CursorStore> {
  const store = yield* CursorStore
  const client = yield* CursorClient
  const stored = yield* store.read(threadId)
  const key = apiKey.trim()
  if (stored.agentId !== undefined && key !== "") {
    yield* Effect.ignore(client.archiveAgent({ apiKey: key, agentId: stored.agentId }))
  }
  yield* store.drop(threadId)
})

export const makeCursorSession = Effect.fn("makeCursorSession")(function* (
  options: CursorSessionOptions
): Effect.fn.Return<
  Session,
  RelayThreadOwnedError,
  CursorClient | CursorStore | RelayLink | RelayThreadOwnership | Scope.Scope
> {
  const client = yield* CursorClient
  const store = yield* CursorStore
  const scope = yield* Effect.scope
  const stored = yield* store.read(options.threadId)
  const state = yield* Ref.make(stateOf(stored))
  /** Resolves on the first relay registration. A later send never waits on it again. */
  const bridge = yield* Deferred.make<RelayIdentity>()
  /**
   * One send starts at a time. Two sends that overlap would both read no active run, and
   * both would create one: two agents, or a second run over the first run's tool gate.
   * The gate is held for the start of a turn only, never for the run it reads.
   */
  const starting = yield* Semaphore.make(1)

  const listeners = new Set<() => void>()
  let latest = yield* Ref.get(state)
  let view: { readonly source: SessionState; readonly steps: ReadonlyArray<Step> } | undefined

  const notify = (): void => {
    for (const listener of listeners) {
      try {
        listener()
      } catch {
        // A broken panel subscriber cannot stop run cleanup or persisted state writes.
      }
    }
  }
  const pendingStarts = new Set<AbortController>()
  /** The run Stop last asked Cursor to cancel. Busy over it is lag, never a run to adopt. */
  let lastStopped: string | undefined

  const worldLayer = options.world

  const publish = Effect.fn("CursorSession.publish")(function* () {
    const current = yield* Ref.get(state)
    const previous = latest
    latest = current
    notify()
    if (samePersisted(previous, current)) return
    yield* store.write(options.threadId, recordOf(current))
  })

  const change = Effect.fn("CursorSession.change")(function* (
    next: (current: SessionState) => SessionState
  ) {
    yield* Ref.update(state, next)
    yield* publish()
  })

  /** The agent Cursor no longer holds is dropped, so the next send creates a fresh one. */
  const dropAgent = change((current) => ({ ...current, agentId: undefined }))

  const isCurrentRun = (
    current: SessionState,
    active: ActiveRun,
    turnId: number
  ): boolean =>
    current.turnId === turnId &&
    current.activeRun?.agentId === active.agentId &&
    current.activeRun.runId === active.runId

  /** The turn transition a mid-run stream event means; terminal frames are handled apart. */
  const progressOf = (event: CursorEvent): CursorTurnEvent | undefined => {
    switch (event._tag) {
      case "assistant":
      case "thinking":
        return event
      case "toolCall":
        return event.running ? { _tag: "toolAnnounced" } : { _tag: "boundary" }
      default:
        return undefined
    }
  }

  const insertTurnAnswer = (
    current: SessionState,
    user: UserStep | undefined,
    text: string,
    at: number
  ): SessionState => {
    if (user === undefined) return current
    const start = current.steps.indexOf(user)
    if (start < 0) return current
    const end = current.steps.findIndex(
      (step, index) => index > start && step.kind === "user"
    )
    const limit = end < 0 ? current.steps.length : end
    if (
      current.steps
        .slice(start + 1, limit)
        .some((step) => step.kind === "assistant")
    ) return current
    const steps = [...current.steps]
    steps.splice(limit, 0, { kind: "assistant", text, at })
    return { ...current, steps }
  }

  const appendError = Effect.fn("CursorSession.appendError")(function* (
    text: string,
    active?: ActiveRun,
    turnId?: number,
    affectTurn = true
  ) {
    const at = yield* Clock.currentTimeMillis
    yield* change((current) => {
      if (
        active !== undefined &&
        turnId !== undefined &&
        !isCurrentRun(current, active, turnId)
      ) return current
      if (!affectTurn) {
        return { ...current, steps: [...current.steps, { kind: "error", text, at }] }
      }
      const failed = settleActivity({
        ...current,
        turn: reduceCursorTurn(current.turn, { _tag: "fail" })
      })
      return {
        ...failed,
        steps: [...failed.steps, { kind: "error", text, at }]
      }
    })
  })

  const startTool = (tool: ToolStep) => change((current) => {
    if (!isCursorTurnActive(current.turn)) return current
    const settled = settleActivity(current)
    return {
      ...settled,
      steps: [...settled.steps, tool],
      turn: reduceCursorTurn(settled.turn, { _tag: "toolStarted", tool }),
      toolTurns: new Map(settled.toolTurns).set(tool.callId, settled.turnId)
    }
  })

  const finishTool = (tool: ToolStep) => change((current) => {
    const toolTurn = current.toolTurns.get(tool.callId)
    const toolTurns = new Map(current.toolTurns)
    toolTurns.delete(tool.callId)
    const ownsPhase =
      toolTurn === current.turnId &&
      current.turn.activeTool?.callId === tool.callId &&
      isCursorTurnActive(current.turn)
    return {
      ...current,
      steps: current.steps.map((step) =>
      step.kind === "tool" && step.callId === tool.callId ? tool : step
      ),
      turn: ownsPhase
        ? reduceCursorTurn(current.turn, { _tag: "toolFinished", tool })
        : current.turn,
      toolTurns
    }
  })

  const refreshSpend = Effect.fn("CursorSession.refreshSpend")(function* (
    apiKey: string,
    agentId: string,
    signal: AbortSignal
  ) {
    const usage = yield* Effect.option(client.getAgentUsage({ apiKey, agentId, signal }))
    if (Option.isNone(usage)) return
    const next: Spend = {
      provider: "cursor",
      usd: 0,
      promptTokens: usage.value.inputTokens,
      completionTokens: usage.value.outputTokens,
      cacheReadTokens: usage.value.cacheReadTokens,
      cacheWriteTokens: usage.value.cacheWriteTokens,
      totalTokens: usage.value.totalTokens,
      priced: 0
    }
    const changed = yield* Ref.modify(state, (current) =>
      sameSpend(current.spend, next)
        ? ([false, current] as const)
        : ([true, { ...current, spend: next }] as const)
    )
    if (changed) yield* publish()
  })

  const publisher = options.publisher
  const publishContext: PagePublishContext | undefined =
    publisher === undefined ? undefined : { publisher, applied: () => appliedFrom(latest.steps, pathOf(options.url)) }
  const relay = yield* ExtensionRelay.make({
    relayUrl: options.relayUrl,
    threadId: options.threadId,
    tabId: options.tabId,
    pageUrl: options.url,
    world: worldLayer,
    ...(publishContext === undefined ? {} : { publish: publishContext }),
    ...(stored.identity === undefined ? {} : { identity: stored.identity }),
    ...(options.reconnectBaseDelayMs === undefined
      ? {}
      : { reconnectBaseDelayMs: options.reconnectBaseDelayMs }),
    ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
    onToolStart: startTool,
    onStep: finishTool,
    onIdentity: (identity) =>
      Effect.andThen(
        change((current) => ({ ...current, identity })),
        Deferred.succeed(bridge, identity)
      )
  })

  /** Which run this session owns, and everything owning one means. See `ownership.ts`. */
  const owned = yield* makeRunOwnership(relay)

  /**
   * The live run belongs to this scope. Closing the scope ends the read by construction,
   * so a caller that forgets to stop still cannot leave an SSE body open. It is added
   * after the relay, so it runs before the relay tears its socket down.
   *
   * The turn fiber is a daemon on purpose: a scoped fiber would be interrupted first, and
   * an interrupt cannot end a read that is waiting on a body. The abort can.
   */
  yield* Effect.addFinalizer(() => owned.endReads)

  /**
   * The relay bridge this thread's cloud agent will call back through, read again before
   * every Cursor create. A stored identity is a reconnect hint, not proof: only the
   * registration on the socket Morph holds right now counts.
   *
   * The first send waits for that first registration. Once a bridge has registered, a send
   * that finds the socket down fails at once: waiting would hand Cursor a dead bridge.
   */
  const bridgeReady = Effect.fn("CursorSession.bridgeReady")(function* () {
    const current = yield* relay.connected()
    if (current !== undefined) return current
    if (yield* Deferred.isDone(bridge)) return undefined
    const ready = yield* Effect.timeoutOption(
      Deferred.await(bridge),
      options.relayReadyMs ?? RELAY_READY_MS
    )
    // The wait ends on the first registration. Read the live bridge again: a socket that
    // dropped while the send waited is not a bridge Cursor can call back through.
    return Option.isNone(ready) ? undefined : yield* relay.connected()
  })

  const mcpFor = (identity: RelayIdentity): ReadonlyArray<CursorMcpServer> => [
    {
      name: MCP_SERVER_NAME,
      type: "http",
      url: identity.mcpUrl,
      headers: { Authorization: `Bearer ${identity.token}` }
    }
  ]

  const pageLine = `The reader is on ${options.url}.`

  const firstPrompt = Effect.fn("CursorSession.firstPrompt")(function* (text: string) {
    const design = yield* Effect.flatMap(Designs, (designs) => designs.get(siteKey(options.url))).pipe(
      Effect.provide(worldLayer),
      Effect.catchCause(() => Effect.succeed(undefined))
    )
    const publishable = publishContext === undefined ? undefined : ({ kind: "page" } as const)
    return `${SYSTEM(options.url, design, "", publishable)}\n\n${pageLine}\n\n${text}`
  })

  const applyTerminal = Effect.fn("CursorSession.applyTerminal")(function* (
    active: ActiveRun,
    turnId: number,
    user: UserStep | undefined,
    transition: CursorTurnEvent
  ) {
    const at = yield* Clock.currentTimeMillis
    yield* change((current) =>
      isCurrentRun(current, active, turnId)
        ? { ...current, turn: reduceCursorTurn(current.turn, transition) }
        : transition._tag === "complete" &&
            transition.text !== undefined &&
            transition.text !== ""
          ? insertTurnAnswer(current, user, transition.text, at)
          : current
    )
  })

  const applyEvent = Effect.fn("CursorSession.applyEvent")(function* (
    active: ActiveRun,
    turnId: number,
    user: UserStep | undefined,
    answerDraft: string,
    event: CursorEvent
  ) {
    const progress = progressOf(event)
    if (progress !== undefined) {
      return yield* change((current) =>
        isCurrentRun(current, active, turnId)
          ? { ...current, turn: reduceCursorTurn(current.turn, progress) }
          : current
      )
    }
    if (event._tag === "subagent") {
      const current = yield* Ref.get(state)
      if (!isCurrentRun(current, active, turnId)) return
      const at = yield* Clock.currentTimeMillis
      const callId = delegationCallId(event.callId)
      const previous = current.steps.find((step): step is ToolStep => step.kind === "tool" && step.callId === callId)
      const step = delegationStep(event, at, previous)
      return yield* event.running ? startTool(step) : finishTool(step)
    }
    if (event._tag === "result") {
      const transition = terminalTurnEvent(event.status, cursorFinalText(event.text, answerDraft))
      if (transition !== undefined) {
        yield* applyTerminal(active, turnId, user, transition)
      }
      return
    }
    if (event._tag === "status") {
      const transition = terminalTurnEvent(event.status, answerDraft)
      if (transition === undefined) return
      return yield* applyTerminal(active, turnId, user, transition)
    }
  })

  /** The run reader: streams, breaks, and recoveries live in `read.ts`. */
  const reader = makeRunReader({
    client,
    dropAgent,
    appendError,
    applyEvent,
    applyTerminal,
    ...(options.followEveryMs === undefined ? {} : { followEveryMs: options.followEveryMs }),
    ...(options.retryStreamAfterMs === undefined ? {} : { retryStreamAfterMs: options.retryStreamAfterMs })
  })

  /**
   * Claim the run, restart the turn on it, and fork its reader: the tail every run start
   * shares. `holdsGate` when the caller already opened the tool gate for this run.
   */
  const startReading = Effect.fn("CursorSession.startReading")(function* (
    apiKey: string,
    active: ActiveRun,
    start: {
      readonly quiet: boolean
      readonly turnId: number
      readonly user: UserStep | undefined
      readonly startedAt: number
      readonly holdsGate: boolean
    }
  ) {
    const claimed = yield* (start.holdsGate ? owned.claimHoldingGate(active) : owned.claim(active))
    yield* change((current) => ({
      ...current,
      agentId: active.agentId,
      activeRun: active,
      turn: reduceCursorTurn(initialCursorTurn, { _tag: "start", at: start.startedAt }),
      turnId: start.turnId
    }))
    const fiber = yield* Effect.forkDetach(
      runTurn(apiKey, active, start.quiet, claimed.reader.signal, claimed.turn, start.turnId, start.user)
    )
    yield* owned.attachReader(claimed.turn, fiber)
    return fiber
  })

  const runTurn = Effect.fnUntraced(function* (
    apiKey: string,
    active: ActiveRun,
    quiet: boolean,
    signal: AbortSignal,
    ownershipTurn: number,
    turnId: number,
    user: UserStep | undefined
  ) {
    yield* Effect.gen(function* () {
      // False until the read says otherwise, so a defect still settles the run.
      let keepRun = false
      yield* reader.readRun(apiKey, active, turnId, user, quiet, signal).pipe(
        Effect.tap((ended) => Effect.sync(() => { keepRun = ended.keepRun })),
        Effect.ensuring(
          Effect.gen(function* () {
            // A later turn may already hold the run. Ending this turn must not end that one.
            if (!(yield* owned.releaseGate(ownershipTurn))) return
            yield* change((current) => {
              // A run a newer turn claimed is that turn's to settle, even when both
              // turns read the same run. Ending this one must not clear it.
              if (!isCurrentRun(current, active, turnId)) return current
              const terminal =
                signal.aborted && current.turn.phase !== "complete" && current.turn.phase !== "failed"
                  ? { ...current, turn: reduceCursorTurn(current.turn, { _tag: "stop" }) }
                  : current
              return { ...settleTurn(terminal), activeRun: keepRun ? current.activeRun : undefined }
            })
          })
        )
      )
      // Usage is secondary. The run, heartbeat and tool gate are already closed, and Stop
      // or scope close can abort this read through the run's reader signal.
      yield* refreshSpend(apiKey, active.agentId, signal)
    }).pipe(Effect.ensuring(owned.finish(ownershipTurn)))
  })

  /**
   * What a busy answer means for this agent. `live`: Cursor holds a run Morph lost track
   * of, and the reader should watch it. `settling`: the run Cursor names already ended, so
   * the busy answer is the lag after a cancel and the create is worth asking again. With
   * no run named, or an unreadable one, there is nothing to adopt; a gone agent is dropped,
   * so the next send starts fresh.
   */
  const busyRun = Effect.fn("CursorSession.busyRun")(function* (
    apiKey: string,
    agentId: string,
    signal: AbortSignal
  ): Effect.fn.Return<{ readonly kind: "live"; readonly run: ActiveRun } | { readonly kind: "settling" } | undefined, never> {
    const lookedUp = yield* client.getAgent({ apiKey, agentId, signal }).pipe(
      Effect.map((agent) => ({ kind: "agent" as const, agent })),
      Effect.catch((failure: CursorFailure) => Effect.succeed({ kind: "failure" as const, failure }))
    )
    if (lookedUp.kind === "failure") {
      if (isAgentGone(lookedUp.failure)) yield* dropAgent
      return undefined
    }
    const runId = lookedUp.agent.latestRunId
    if (runId === undefined) return undefined
    if (runId === lastStopped) return { kind: "settling" }
    const record = yield* client.getRun({ apiKey, agentId, runId, signal }).pipe(
      Effect.map((run) => run.status),
      Effect.catch(() => Effect.succeed(undefined))
    )
    if (record !== undefined && isTerminal(record)) return { kind: "settling" }
    return { kind: "live", run: { agentId, runId, startedAt: yield* Clock.currentTimeMillis } }
  })

  /** Start a run and hand back the fiber reading it, or nothing when nothing started. */
  const beginTurn = Effect.fn("CursorSession.beginTurn")(function* (text: string, signal: AbortSignal) {
    const startedAt = yield* Clock.currentTimeMillis
    const user: UserStep = { kind: "user", text, at: startedAt }
    const attempt = yield* Ref.modify(state, (current) => {
      const base = current.activeRun === undefined ? settleActivity(current) : current
      const nextTurnId = base.turnId + 1
      return [
        { turnId: nextTurnId, hadActive: base.activeRun !== undefined },
        {
          ...base,
          steps: [...base.steps, user],
          ...(base.activeRun === undefined
            ? {
                turn: reduceCursorTurn(initialCursorTurn, { _tag: "start", at: startedAt }),
                turnId: nextTurnId
              }
            : {})
        }
      ] as const
    })
    const { turnId, hadActive } = attempt
    yield* publish()
    if (signal.aborted) return undefined
    const settings = yield* Effect.promise(() => options.settings())
    const apiKey = settings.cursorKey.trim()
    if (apiKey === "") {
      yield* appendError(CURSOR_KEY_MISSING, undefined, undefined, !hadActive)
      return undefined
    }
    const current = yield* Ref.get(state)
    const agentId = current.agentId
    const model = settings.cursorModel.trim()

    /**
     * A stored run with no reader is one whose stream broke and stayed unreadable. A send
     * reattaches to it instead of asking Cursor for a parallel run, which Cursor would
     * refuse with `409 agent_busy`. The note says the message did not go through; the
     * run's stream, live or terminal, settles what the run did.
     */
    const storedRun = current.activeRun
    if (storedRun !== undefined && (yield* owned.holder) === undefined) {
      yield* appendError(RUN_BUSY_NOT_SENT, undefined, undefined, false)
      return yield* startReading(apiKey, storedRun, { quiet: false, turnId, user, startedAt, holdsGate: false })
    }

    const identity = yield* bridgeReady()
    if (identity === undefined) {
      yield* appendError(RELAY_UNREACHABLE, undefined, undefined, !hadActive)
      return undefined
    }
    if (signal.aborted) return undefined
    const mcpServers = mcpFor(identity)

    /**
     * A run already in flight owns the tool gate. A second send only asks Cursor, which
     * answers `409 agent_busy`: it must not close the gate the first run still uses.
     *
     * With no run in flight, the gate opens before the create, so the agent's first tool
     * call is accepted. No active run means the turn before it already released the gate:
     * a turn clears the active run only after it closed the gate.
     *
     * The crew roles ride on the create only: Cursor's run endpoint takes no
     * `customSubagents`, so a thread created before the roles existed keeps the built-in
     * subagents until the reader starts a new chat.
     */
    const owns = current.activeRun === undefined
    if (owns) yield* relay.openRun()
    const start =
      agentId === undefined
        ? Effect.map(
            Effect.flatMap(firstPrompt(text), (prompt) =>
              client.createAgent({
                apiKey,
                prompt,
                ...(model === "" ? {} : { model }),
                mcpServers,
                customSubagents: CREW_ROLES,
                signal
              })
            ),
            (created): ActiveRun => ({
              agentId: created.agentId,
              runId: created.runId,
              startedAt: Date.now()
            })
          )
        : Effect.map(
            client.createRun({
              apiKey,
              agentId,
              prompt: `${pageLine}\n\n${text}`,
              mcpServers,
              signal
            }),
            (created): ActiveRun => ({ agentId, runId: created.runId, startedAt: Date.now() })
          )

    /**
     * A busy answer over a run that already ended is the lag after a cancel (Stop, then
     * a steer's send), so the create is asked again a few times. Only the busy answers
     * that resolve to a settled run retry; any other refusal falls through at once.
     */
    const settling = (failure: CursorFailure): Effect.Effect<boolean> =>
      owns && agentId !== undefined && isAgentBusy(failure) && !signal.aborted
        ? Effect.map(busyRun(apiKey, agentId, signal), (busy) => busy?.kind === "settling")
        : Effect.succeed(false)
    const active = yield* start.pipe(
      Effect.retry({ while: settling, times: BUSY_RETRIES, schedule: Schedule.spaced(options.busyRetryMs ?? BUSY_RETRY_MS) }),
      Effect.catch(
        Effect.fnUntraced(function* (failure: CursorFailure) {
          if (signal.aborted) {
            if (owns) yield* relay.closeRun()
            return undefined
          }
          // An agent Cursor no longer holds is dropped here, so the next send creates one.
          if (isAgentGone(failure)) yield* dropAgent
          /**
           * A busy answer while Morph holds no run, once the retries are spent, means
           * Cursor kept a run Morph lost track of. Adopt it: the reader watches the run
           * Cursor actually has, the gate stays open for it, and the note says the
           * message did not go through.
           */
          if (owns && isAgentBusy(failure) && agentId !== undefined) {
            const busy = yield* busyRun(apiKey, agentId, signal)
            if (busy?.kind === "live") {
              yield* appendError(RUN_BUSY_NOT_SENT, undefined, undefined, false)
              return busy.run
            }
          }
          if (owns) yield* relay.closeRun()
          yield* appendError(failure.message, undefined, undefined, !hadActive)
          return undefined
        })
      )
    )
    if (active === undefined) return undefined
    if (signal.aborted) {
      if (owns) yield* relay.closeRun()
      yield* Effect.ignore(client.cancelRun({ apiKey, agentId: active.agentId, runId: active.runId }))
      return undefined
    }
    // This turn owns the run and the gate from here. A turn that ends after this moment
    // reads itself as the older one and ends nothing.
    return yield* startReading(apiKey, active, { quiet: false, turnId, user, startedAt, holdsGate: owns })
  })

  /**
   * Stop, in the order the reader feels it: the turn reads as stopped first, then the
   * reads end, then Cursor is asked to cancel. The cancel is a round trip the button must
   * not wait on (seen live on 2026-09-13 as a Stop that took seconds to show), but the
   * promise does wait, so a steer's next send is not refused as busy.
   */
  const stopTurn = Effect.fn("CursorSession.stopTurn")(function* () {
    for (const pending of pendingStarts) pending.abort()
    pendingStarts.clear()
    notify()
    yield* starting.withPermits(1)(Effect.void)
    // Only the run that still holds the gate is live at Cursor. Cancelling a run that
    // gave it back asks Cursor to stop something it finished: a conflict, not a stop.
    const holder = yield* owned.holder
    // A run whose reader broke stays stored with no turn holding it, so Stop reaches it
    // here. A finished one answers 409 run_not_cancellable, which is swallowed below.
    const orphan = holder === undefined ? (yield* Ref.get(state)).activeRun : undefined
    const target = holder?.run ?? orphan
    if (target !== undefined) lastStopped = target.runId
    yield* change((current) => {
      if (isCursorTurnActive(current.turn)) {
        return {
          ...settleActivity({
            ...current,
            turn: reduceCursorTurn(current.turn, { _tag: "stop" })
          }),
          activeRun: undefined,
          toolTurns: new Map()
        }
      }
      // An orphaned run has no turn left to clear it, so Stop clears it here.
      return orphan === undefined ? current : { ...current, activeRun: undefined }
    })
    yield* owned.endReads
    if (target === undefined) return
    const settings = yield* Effect.promise(() => options.settings())
    const apiKey = settings.cursorKey.trim()
    if (apiKey === "") return
    yield* client
      .cancelRun({ apiKey, agentId: target.agentId, runId: target.runId })
      .pipe(
        // Only the documented finished-run answer is swallowed. Everything else is news.
        Effect.catch((failure: CursorFailure) =>
          isRunNotCancellable(failure)
            ? Effect.void
            : appendError(failure.message)
        )
      )
  })

  const archiveAgent = Effect.fn("CursorSession.archiveAgent")(function* (agentId: string) {
    const settings = yield* Effect.promise(() => options.settings())
    const apiKey = settings.cursorKey.trim()
    if (apiKey === "") return
    // A refused archive is Morph's problem with Cursor, never a step the reader reads.
    yield* Effect.ignore(client.archiveAgent({ apiKey, agentId }))
  })

  const emptyThread = Effect.fn("CursorSession.emptyThread")(function* () {
    yield* stopTurn()
    const current = yield* Ref.get(state)
    if (current.agentId !== undefined) yield* archiveAgent(current.agentId)
    yield* store.drop(options.threadId)
    yield* Ref.set(state, {
      agentId: undefined,
      steps: [],
      identity: current.identity,
      activeRun: undefined,
      spend: NO_CURSOR_SPEND,
      turn: initialCursorTurn,
      turnId: current.turnId + 1,
      toolTurns: new Map()
    })
    latest = yield* Ref.get(state)
    notify()
  })

  const run = <A>(effect: Effect.Effect<A, never, Scope.Scope>): Promise<A> =>
    Effect.runPromise(Scope.provide(effect, scope))

  // A run that outlived the panel: rejoin its stream so a reopened thread keeps moving.
  if (stored.activeRun !== undefined) {
    const rejoin = Effect.fn("CursorSession.rejoin")(function* (active: ActiveRun) {
      const settings = yield* Effect.promise(() => options.settings())
      const apiKey = settings.cursorKey.trim()
      if (apiKey === "") {
        return yield* change((current) => ({ ...current, activeRun: undefined }))
      }
      const startedAt = yield* Clock.currentTimeMillis
      const allocated = yield* Ref.updateAndGet(state, (current) => ({
        ...current,
        turnId: current.turnId + 1
      }))
      const user = allocated.steps.findLast((step): step is UserStep => step.kind === "user")
      yield* startReading(apiKey, active, {
        quiet: true,
        turnId: allocated.turnId,
        user,
        startedAt,
        holdsGate: false
      })
    })
    yield* rejoin(stored.activeRun)
  }

  const steps = (): ReadonlyArray<Step> => {
    if (view === undefined || view.source !== latest) view = { source: latest, steps: latest.steps }
    return view.steps
  }

  return {
    threadId: options.threadId,
    url: options.url,
    steps,
    turn: () => latest.turn,
    state: (): RunState =>
      pendingStarts.size > 0 || latest.activeRun !== undefined
        ? "working"
        : hasApplied(appliedFrom(latest.steps, pathOf(options.url)))
          ? "applied"
          : "idle",
    spend: (): Spend => latest.spend,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    /**
     * The panel's click lands on the tool server's question controller through the host.
     * A stale call or option id is false, and the panel says so instead of locking a card.
     */
    answerQuestion: async (callId, optionIds) => relay.answerQuestion(callId, optionIds),
    send: async (text) => {
      const controller = new AbortController()
      pendingStarts.add(controller)
      notify()
      let fiber
      try {
        fiber = await run(starting.withPermits(1)(beginTurn(text, controller.signal)))
      } finally {
        pendingStarts.delete(controller)
        notify()
      }
      if (fiber === undefined) return
      await Effect.runPromise(Effect.asVoid(Fiber.await(fiber)))
    },
    stop: () => run(stopTurn()),
    reset: async () => {
      await run(emptyThread())
      await options.forget()
    },
    clear: () => run(emptyThread()),
    forgetPage: () => options.forget(),
    forgetSite: () => options.forgetSite()
  }
})
