import { NO_SPEND, type Spend } from "../agent/spend"
import { pageKey } from "../agent/page"
import { IDLE_TURN, type RunState, type Session, type Step, type TurnView } from "./contract"

/**
 * A session that pretends: it writes a plan, fakes two page tools, and ends `applied`.
 * For building the panel without a key, and for panel tests.
 */
export const fakeSession = (delayMs = 400): Session => {
  const url = "https://github.com/acme/app/pulls"
  let steps: ReadonlyArray<Step> = []
  let turn: TurnView = IDLE_TURN
  let state: RunState = "idle"
  let spend: Spend = NO_SPEND
  let activeTurn = 0
  const listeners = new Set<() => void>()
  const notify = () => {
    for (const l of listeners) l()
  }
  const push = (step: Step) => {
    steps = [...steps, step]
    notify()
  }
  const wait = () => new Promise<void>((r) => setTimeout(r, delayMs))

  return {
    threadId: pageKey(url),
    url,
    send: async (text) => {
      const generation = ++activeTurn
      push({ kind: "user", text, at: Date.now() })
      state = "working"
      turn = { ...IDLE_TURN, phase: "starting", startedAt: Date.now() }
      notify()
      await wait()
      if (generation !== activeTurn) return
      const todos = [
        { id: "1", title: "Inspect the page", status: "in-progress" },
        { id: "2", title: "Apply a dark canvas", status: "pending" }
      ]
      push({ kind: "tool", callId: "todos", name: "write_todos", input: { todos }, result: { ok: true, todos }, at: Date.now() })
      turn = {
        ...turn,
        phase: "thinking",
        activityText: "The page is a dense list. I will restyle it."
      }
      notify()
      await wait()
      if (generation !== activeTurn) return
      const callId = `c${steps.length}`
      const activeTool = { kind: "tool" as const, callId, name: "read_page", input: { selector: "body" }, at: Date.now() }
      turn = { ...turn, phase: "runningTool", activeTool }
      push(activeTool)
      await wait()
      if (generation !== activeTurn) return
      steps = steps.map((s) =>
        s.kind === "tool" && s.callId === callId ? { ...s, result: { nodes: 412, title: "Pull requests" } } : s
      )
      turn = { ...turn, phase: "starting", activeTool: undefined }
      notify()
      await wait()
      if (generation !== activeTurn) return
      push({ kind: "tool", callId: `${callId}b`, name: "apply_styles", input: { css: "body{background:#111}" }, result: { ok: true }, at: Date.now() })
      await wait()
      if (generation !== activeTurn) return
      push({ kind: "assistant", text: "Applied a dark canvas. Say what to change next.", at: Date.now() })
      turn = {
        ...turn,
        phase: "complete",
        activityText: "",
        answerDraft: "",
        finalAnswer: "Applied a dark canvas. Say what to change next.",
        activeTool: undefined
      }
      state = "applied"
      // Two model attempts, priced like a cheap model prices them.
      spend = {
        ...spend,
        usd: spend.usd + 0.0042,
        promptTokens: spend.promptTokens + 3100,
        completionTokens: spend.completionTokens + 420,
        priced: spend.priced + 2
      }
      notify()
    },
    stop: async () => {
      activeTurn += 1
      state = "idle"
      turn = { ...turn, phase: "stopped", answerDraft: "", activeTool: undefined }
      notify()
    },
    answerQuestion: async () => false,
    steps: () => steps,
    turn: () => turn,
    state: () => state,
    spend: () => spend,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    reset: async () => {
      steps = []
      state = "idle"
      turn = IDLE_TURN
      spend = NO_SPEND
      notify()
    },
    clear: async () => {
      steps = []
      state = "idle"
      turn = IDLE_TURN
      spend = NO_SPEND
      notify()
    },
    forgetPage: async () => {},
    forgetSite: async () => {}
  }
}
