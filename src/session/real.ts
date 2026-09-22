import { Context, Effect, Layer } from "effect"
import type { Event } from "@clavia/tardigrade/core/event"
import { Designs } from "../agent/designs"
import type { LogStore } from "../agent/log"
import { pageKey, siteKey } from "../agent/page"
import { hasApplied } from "../agent/applied"
import { createRun, stepsOf, type Run } from "../agent/run"
import { foldThinking } from "../agent/thinking"
import { spendOf, type Spend } from "../agent/spend"
import { appliedFrom } from "../agent/tools"
import { pathOf } from "../bridge/scope"
import { skillFingerprint } from "../agent/skills"
import type { Skill } from "../skills/contract"
import type { World } from "../agent/world"
import type { ForkToolContext } from "../agent/tools"
import type { CrewToolContext } from "../agent/tools"
import type { PagePublisher } from "../agent/page-publish-tools"
import {
  IDLE_TURN,
  sameTurnView,
  type RunState,
  type Session,
  type Settings,
  type Step,
  type ToolStep,
  type TurnView
} from "./contract"

export const OPENROUTER = "https://openrouter.ai/api/v1"
const runEffect = Effect.runPromiseWith(Context.empty())

export interface RealSessionOptions {
  readonly url: string
  /** Uses the old page key when omitted, so existing callers and stored logs keep working. */
  readonly threadId?: string
  readonly settings: () => Promise<Settings>
  /** Enabled design guidance. Read before each turn so settings changes apply next. */
  readonly skills?: Effect.Effect<ReadonlyArray<Skill>, unknown>
  readonly world: Layer.Layer<World>
  readonly fork?: ForkToolContext
  /** Where the page's own redesign publishes to, when the page runs no installed Morph. */
  readonly publisher?: PagePublisher
  readonly crew?: CrewToolContext
  readonly logs: LogStore
  /** Called on reset, after the log is dropped: undo what the page still wears. */
  readonly forget: () => Promise<void>
  /** Take the site's token design off. */
  readonly forgetSite: () => Promise<void>
  /** The model binding's transport. Tests script it; the panel leaves it to the browser. */
  readonly fetch?: typeof fetch
}

const isPendingTool = (step: Step): step is ToolStep =>
  step.kind === "tool" && step.result === undefined

/**
 * The session over a real run. The log is the state: the steps and whether the page wears
 * something are both read from it, and the store keeps it between panel openings.
 */
export const realSession = async (options: RealSessionOptions): Promise<Session> => {
  const key = options.threadId ?? pageKey(options.url)
  const listeners = new Set<() => void>()
  const notify = () => {
    for (const l of listeners) l()
  }

  let log: ReadonlyArray<Event> = await options.logs.load(key)
  // Steps the log does not hold: failures of the run itself (a dead model call, a missing
  // key). They are drawn after the log's own steps and cleared when the next turn starts.
  let local: ReadonlyArray<Step> = []
  let working = false
  let run: Run | undefined
  let turn: TurnView = IDLE_TURN
  let bound: { readonly model: string; readonly key: string; readonly skills: string } | undefined

  const runFor = async (): Promise<Run> => {
    const [settings, skills] = await Promise.all([
      options.settings(),
      runEffect(options.skills ?? Effect.succeed<ReadonlyArray<Skill>>([]))
    ])
    if (settings.openRouterKey === "") throw new Error("Add your OpenRouter key in settings first.")
    const fingerprint = skillFingerprint(skills)
    if (
      run !== undefined &&
      bound?.model === settings.model &&
      bound?.key === settings.openRouterKey &&
      bound?.skills === fingerprint
    ) {
      return run
    }
    const world = options.world
    // The site's design is read once, here: the model's own write_design calls are in the log.
    const design = await runEffect(
      Effect.flatMap(Designs, (d) => d.get(siteKey(options.url))).pipe(Effect.provide(world))
    )
    run = createRun({
      url: options.url,
      model: { baseUrl: OPENROUTER, apiKey: settings.openRouterKey, model: settings.model },
      world,
      design,
      skills,
      ...(options.fork === undefined ? {} : { fork: options.fork }),
      ...(options.publisher === undefined ? {} : { publisher: options.publisher }),
      ...(options.crew === undefined ? {} : { crew: options.crew }),
      seed: log,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch })
    })
    bound = { model: settings.model, key: settings.openRouterKey, skills: fingerprint }
    return run
  }

  // Every tick writes the log, not only the end of the turn: a panel closed mid-turn
  // reopens on what had happened, instead of on nothing. Writes queue behind each other,
  // so two ticks never race on the store.
  let written = log.length
  let saving: Promise<void> = Promise.resolve()
  const persist = (): Promise<void> => {
    if (log.length === written) return saving
    written = log.length
    const snapshot = log
    saving = saving.then(() => options.logs.save(key, snapshot)).catch((e: unknown) => console.warn("[redesign] log not saved", e))
    return saving
  }
  const refresh = (from: Run) => {
    log = from.log()
    const runSteps = stepsOf(log)
    const activeTool = runSteps.findLast(isPendingTool)
    const thinking = from.thinking()
    const answerDraft = from.answer()
    const nextTurn: TurnView = {
      ...turn,
      phase:
        activeTool !== undefined
          ? "runningTool"
          : answerDraft !== ""
            ? "answering"
            : thinking !== ""
              ? "thinking"
              : "starting",
      activityText: [thinking, answerDraft].filter((text) => text !== "").join("\n"),
      answerDraft,
      activeTool
    }
    if (!sameTurnView(turn, nextTurn)) turn = nextTurn
    notify()
    void persist()
  }

  // Thinking tokens live on the run, not the log. Keep the last turn's text after it
  // settles so the activity can still show it.
  let heldThinking = ""
  let heldThinkingAt = 0

  // The panel reads `steps()` as an external-store snapshot, so the same log, the same
  // local steps, and the same thinking text must give the same array, or React re-renders forever.
  let view:
    | {
        readonly log: ReadonlyArray<Event>
        readonly local: ReadonlyArray<Step>
        readonly thinking: string
        readonly steps: ReadonlyArray<Step>
      }
    | undefined
  const steps = (): ReadonlyArray<Step> => {
    const thinking = (working ? run?.thinking() : undefined) ?? heldThinking
    if (
      view === undefined ||
      view.log !== log ||
      view.local !== local ||
      view.thinking !== thinking
    ) {
      const at = heldThinkingAt !== 0 ? heldThinkingAt : Date.now()
      view = {
        log,
        local,
        thinking,
        steps: foldThinking([...stepsOf(log), ...local], working ? "" : thinking, at)
      }
    }
    return view.steps
  }

  // Same rule as `steps()`: one log, one Spend object.
  let bill: { readonly log: ReadonlyArray<Event>; readonly spend: Spend } | undefined
  const spend = (): Spend => {
    if (bill === undefined || bill.log !== log) bill = { log, spend: spendOf(log) }
    return bill.spend
  }

  const state = (): RunState => (working ? "working" : hasApplied(appliedFrom(stepsOf(log), pathOf(options.url))) ? "applied" : "idle")
  const failed = (e: unknown): Step => ({ kind: "error", text: e instanceof Error ? e.message : String(e), at: Date.now() })
  let activeTurnDone: Promise<void> | undefined
  let finishActiveTurn: (() => void) | undefined
  let stopRequested = false

  return {
    threadId: key,
    send: async (text) => {
      const beforeUsd = spend().usd
      let current: Run
      try {
        current = await runFor()
      } catch (e) {
        local = [...local, { kind: "user", text, at: Date.now() }, failed(e)]
        notify()
        return
      }
      working = true
      stopRequested = false
      turn = { ...IDLE_TURN, phase: "starting", startedAt: Date.now() }
      activeTurnDone = new Promise<void>((resolve) => {
        finishActiveTurn = resolve
      })
      local = []
      heldThinking = ""
      heldThinkingAt = Date.now()
      const ticker = setInterval(() => refresh(current), 50)
      try {
        // deliver runs before turn's first await, so the reader's words are in the log now.
        const turn = current.turn(text)
        refresh(current)
        await turn
      } catch (e) {
        // The run died outside the log (the model binding threw, the page went away). The
        // log keeps an open turn; the next message starts a new one after it.
        local = [failed(e)]
      } finally {
        clearInterval(ticker)
        log = current.log()
        const addedUsd = spend().usd - beforeUsd
        if (addedUsd > 0 && options.crew !== undefined) {
          try {
            options.crew.runtime.recordSpend(options.crew.agentId, addedUsd)
          } catch {
            // A saved child chat can outlive its in-memory crew.
          }
        }
        heldThinking = current.thinking()
        const finalAnswer =
          stepsOf(log).findLast((step) => step.kind === "assistant")?.text ?? ""
        turn = {
          ...turn,
          phase: stopRequested
            ? "stopped"
            : local.some((step) => step.kind === "error")
              ? "failed"
              : "complete",
          activityText: "",
          answerDraft: "",
          finalAnswer,
          activeTool: undefined
        }
        try {
          await persist()
        } finally {
          working = false
          notify()
          finishActiveTurn?.()
          finishActiveTurn = undefined
          activeTurnDone = undefined
        }
      }
    },
    stop: async () => {
      const done = activeTurnDone
      stopRequested = done !== undefined
      await run?.stop()
      await done
    },
    answerQuestion: async (callId, optionIds) => run?.answerQuestion(callId, optionIds) ?? false,
    url: options.url,
    steps,
    turn: () => turn,
    state,
    spend,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    reset: async () => {
      await saving
      await options.logs.drop(key)
      await options.forget()
      log = []
      local = []
      heldThinking = ""
      heldThinkingAt = 0
      working = false
      turn = IDLE_TURN
      run = undefined
      bound = undefined
      written = 0
      notify()
    },
    clear: async () => {
      await saving
      await options.logs.drop(key)
      log = []
      local = []
      heldThinking = ""
      heldThinkingAt = 0
      working = false
      turn = IDLE_TURN
      run = undefined
      bound = undefined
      written = 0
      notify()
    },
    forgetPage: () => options.forget(),
    forgetSite: () => options.forgetSite()
  }
}
