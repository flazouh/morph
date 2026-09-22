import { Effect, Layer } from "effect"
import { KeyValueStore } from "effect/unstable/persistence"
import { agentOf, compaction, reply, toolList } from "@clavia/tardigrade"
import type { Event } from "@clavia/tardigrade/core/event"
import { createHost, type Host } from "@clavia/tardigrade/host/host"
import { messageReceived } from "@clavia/tardigrade/core/message"
import { infer } from "@clavia/tardigrade/model"
import { turnCompleted } from "@clavia/tardigrade/events"
import type { Step } from "../session/contract"
import type { Skill } from "../skills/contract"
import type { Design } from "./design"
import type { AppliedPages } from "./applied"
import type { World } from "./world"
import { Shot, SHOT_NOTE, withShots, type Shots } from "./eyes"
import { withUsageAccounting } from "./spend"
import { applyReasoning, withReasoning } from "./thinking"
import type { PagePublisher } from "./page-publish-tools"
import { appliedFrom, SYSTEM, toolsFor, type CrewToolContext, type ForkToolContext, type Publishable } from "./tools"
import { pathOf } from "../bridge/scope"
import { composeSkills } from "./skills"
import { createQuestionController } from "./question"

export const LANE = "main"

const ADDRESS = `mem:${LANE}`
const STOP_REASON = "reader stopped turn"
const STOP_OUTPUT = "Stopped by the reader."

export interface RunConfig {
  readonly url: string
  readonly model: { readonly baseUrl: string; readonly apiKey: string; readonly model: string }
  readonly world: Layer.Layer<World>
  readonly seed: ReadonlyArray<Event>
  /** The site's design when the session opened, so the model starts from it. */
  readonly design: Design | undefined
  /** Design guidance enabled when this run was built. */
  readonly skills?: ReadonlyArray<Skill>
  /** The installed marketplace release this chat can change through an anonymous local draft. */
  readonly fork?: ForkToolContext
  /** Where the page's own redesign publishes to, when the page runs no installed Morph. */
  readonly publisher?: PagePublisher
  /** Collaborative runtime mounted for this bot. */
  readonly crew?: CrewToolContext
  /** The model binding's transport. Tests script it; the panel leaves it to the browser. */
  readonly fetch?: typeof fetch
}

export interface Run {
  /** Deliver one message and drive the graph until it rests. */
  readonly turn: (text: string) => Promise<void>
  /** Stop the active turn and keep all work that already settled. */
  readonly stop: () => Promise<void>
  readonly log: () => ReadonlyArray<Event>
  /** Thinking tokens from the in-flight model call. Empty between turns until the next one starts. */
  readonly thinking: () => string
  /** Answer tokens from the in-flight model call. Empty until that call starts writing. */
  readonly answer: () => string
  /** Answer a pending ask_user call. False means the call or option ids are not valid. */
  readonly answerQuestion: (callId: string, optionIds: ReadonlyArray<string>) => boolean
  /** What the page wears now, read from the log's successful applies. */
  readonly applied: () => AppliedPages
}

/**
 * One page's agent: the harness's runtime with our tools mounted, on the in-memory
 * host, remembered by whoever calls `log()` after each turn.
 */
export const createRun = (config: RunConfig): Run => {
  // Tools reach the page and the repo through `config.world`, supplied here so the actor's
  // own requirements stay the runtime's (`AgentR`) and the host binds only those.
  // The screenshots the model took, by call id: too big for the log, attached on the wire (eyes.ts).
  const shots: Shots = new Map()
  let thinking = ""
  let answer = ""
  let turnAbort: AbortController | undefined
  let inFlight: Promise<void> | undefined
  const questions = createQuestionController()
  const applied = (): AppliedPages => appliedFrom(stepsOf(host.read(LANE)), pathOf(config.url))
  const publish = config.publisher === undefined ? undefined : { publisher: config.publisher, applied }
  const publishable: Publishable | undefined =
    config.fork !== undefined ? { kind: "fork", parent: config.fork.parent } : publish !== undefined ? { kind: "page" } : undefined
  const tools = toolsFor({ url: config.url }, { fork: config.fork, publish, questions, crew: config.crew }).map((tool) => ({
    spec: tool.spec,
    run: (input: unknown, context: { readonly callId: string; readonly turn?: string }) => {
      return Effect.map(Effect.provide(tool.run(input, context), config.world), (result) => {
        if (!(result instanceof Shot)) return result
        shots.set(context.callId, result.image)
        return SHOT_NOTE
      })
    }
  }))
  const crewGuidance =
    config.crew === undefined
      ? ""
      : `You are crew bot ${config.crew.agentId}.${config.crew.parentId === undefined ? "" : ` Your parent bot is ${config.crew.parentId}.`} Use these IDs with send_agent.`
  const actor = agentOf([
    toolList(
      tools,
      SYSTEM(
        config.url,
        config.design,
        [crewGuidance, composeSkills(config.skills ?? [])].filter((part) => part !== "").join("\n\n"),
        publishable
      )
    ),
    reply,
    compaction
  ])
  const host: Host = createHost({
    actorFor: (lane) => (lane === LANE ? actor : undefined),
    layersFor: () =>
      Layer.mergeAll(
        infer({
          ...config.model,
          // One rung, wide: a skin is a small project plus the model's reasoning, and a
          // response cut at the ceiling is a died attempt that is paid for and run again.
          maxOutputTokens: 64_000,
          maxTokensLadder: [64_000],
          // The wall times guard a hung stream, not a long one. A reasoning model writing a
          // multi-file skin over a big page streams for minutes without a pause; killing it
          // at three minutes made the panel retry the same call, and pay for it, until the
          // give-up count (K3 on Reddit: four attempts, twelve minutes of "Thinking").
          stream: { totalMs: 900_000, firstChunkMs: 60_000, idleMs: 90_000 },
          fetch: (async (input, init) => {
            answer = ""
            const stopSignal = turnAbort?.signal
            if (stopSignal?.aborted) throw new DOMException(STOP_REASON, "AbortError")
            const signal =
              stopSignal === undefined
                ? init?.signal
                : init?.signal
                  ? AbortSignal.any([init.signal, stopSignal])
                  : stopSignal
            return withReasoning(
              withUsageAccounting(withShots(config.fetch ?? fetch, shots)),
              (delta) => {
                thinking = applyReasoning(thinking, delta)
              },
              (delta) => {
                answer = applyReasoning(answer, delta)
              }
            )(input, { ...init, signal })
          }) as typeof fetch
        }),
        // The spill store for oversized tool results. Memory is enough: a spilled value is read
        // back within the same turn, and the panel outlives the turn.
        KeyValueStore.layerMemory
      )
  })
  if (config.seed.length > 0) host.seed(LANE, config.seed)
  // One turn at a time: two deliveries must not drive the same lane together.
  return {
    turn: async (text) => {
      if (inFlight !== undefined) throw new Error("a turn is already running; wait for it to finish")
      turnAbort = new AbortController()
      thinking = ""
      answer = ""
      // The id is the log's dedup key: a run seeded from an older log must never mint an id
      // that log already holds, so it is random rather than counted.
      const turnId = `m-${crypto.randomUUID()}`
      questions.beginTurn()
      host.deliver(ADDRESS, messageReceived({ id: turnId, text, at: Date.now() }))
      inFlight = host.drive()
      try {
        await inFlight
      } catch (error) {
        if (turnAbort.signal.reason !== STOP_REASON) throw error
        host.seed(LANE, [turnCompleted({ output: STOP_OUTPUT, turn: turnId, at: Date.now() })])
      } finally {
        inFlight = undefined
        turnAbort = undefined
      }
    },
    stop: async () => {
      if (inFlight === undefined) return
      turnAbort?.abort(STOP_REASON)
      questions.cancelAll()
      await inFlight.catch(() => undefined)
    },
    log: () => host.read(LANE),
    thinking: () => thinking,
    answer: () => answer,
    answerQuestion: questions.answer,
    applied
  }
}

/**
 * The panel's view of the log: what the reader said, what the model said, each tool call
 * with its answer once it has one, and any turn that died. Working commentary
 * (`TextReturned`) and the final answer (`TurnCompleted.output`) both read as assistant
 * text; the two never repeat because the runtime journals one or the other for a step.
 */
export const stepsOf = (log: ReadonlyArray<Event>): ReadonlyArray<Step> => {
  const steps: Array<Step> = []
  const calls = new Map<string, number>()
  // The runtime marks each attempt with `ModelCalled` before it runs; two in a row with
  // nothing between them mean the first died (timed out, cut, or thrown) and this is the
  // retry. The reader sees that, rather than one "Thinking" that lasts the sum of them.
  let pending: { readonly at: number; readonly attempt: number } | undefined
  for (const raw of log) {
    const e = raw as Record<string, unknown> & { type: string; at?: number }
    const at = typeof e.at === "number" ? e.at : 0
    if (e.type === "ModelCalled") {
      const attempt = pending === undefined ? 1 : pending.attempt + 1
      if (pending !== undefined) steps.push({ kind: "error", text: diedAttempt(at - pending.at, attempt), at })
      pending = { at, attempt }
      continue
    }
    pending = undefined
    switch (e.type) {
      case "MessageReceived":
        steps.push({ kind: "user", text: String(e.text), at })
        break
      case "TextReturned":
        if (String(e.text).trim() !== "") steps.push({ kind: "thinking", text: String(e.text), at })
        break
      case "TurnCompleted": {
        const text = String(e.output ?? "").trim()
        const last = steps[steps.length - 1]
        if (text !== "" && text !== STOP_OUTPUT && !(last?.kind === "assistant" && last.text === text)) {
          steps.push({ kind: "assistant", text, at })
        }
        break
      }
      case "TurnFailed":
        steps.push({ kind: "error", text: String(e.error), at })
        break
      case "ToolCalled":
        calls.set(String(e.callId), steps.length)
        steps.push({ kind: "tool", callId: String(e.callId), name: String(e.name), input: e.arguments, at })
        break
      case "ToolReturned": {
        const index = calls.get(String(e.callId))
        const step = index === undefined ? undefined : steps[index]
        if (index !== undefined && step?.kind === "tool") steps[index] = { ...step, result: e.result }
        break
      }
      default:
        break
    }
  }
  return steps
}

const diedAttempt = (ms: number, attempt: number): string =>
  `The model's attempt died after ${Math.round(ms / 1000)}s (cut off or timed out). Trying again (attempt ${attempt}).`
