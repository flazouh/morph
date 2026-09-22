/**
 * The Session the panel holds when the provider is Cursor.
 *
 * It owns no run and no socket. It asks the service worker, and it redraws when the
 * service worker pushes a new view. Closing or replacing the panel iframe therefore
 * cannot stop a run: nothing the run needs lives on this side.
 */

import { NO_CURSOR_SPEND, sameSpend, type Spend } from "../agent/spend"
import type { RunState, Session, Step, TurnView } from "../session/contract"
import {
  decodeCursorAnswer,
  decodeCursorUpdate,
  type CursorAsk,
  type CursorUpdate,
  type CursorView
} from "./messages"
import { initialCursorTurn } from "./turn"
import { answer, ask } from "../bridge/messaging"

export interface CursorPort {
  readonly ask: (ask: CursorAsk) => Promise<unknown>
  /** Every message pushed by the background. The caller filters by thread. */
  readonly listen: (onUpdate: (update: CursorUpdate) => void) => () => void
}

export interface CursorProxyInput {
  readonly threadId: string
  readonly url: string
  readonly tabId: number
}

export const BACKGROUND_SILENT = "Morph's background service did not answer. Reload the extension and try again."

const EMPTY: ReadonlyArray<Step> = []

export const cursorProxySession = async (
  port: CursorPort,
  input: CursorProxyInput
): Promise<Session> => {
  let steps: ReadonlyArray<Step> = EMPTY
  let turn: TurnView = initialCursorTurn
  let state: RunState = "idle"
  let spend: Spend = NO_CURSOR_SPEND
  const listeners = new Set<() => void>()

  const apply = (view: Pick<CursorView, "steps" | "turn" | "state" | "spend">): void => {
    steps = view.steps
    turn = { ...view.turn, activeTool: view.turn.activeTool }
    state = view.state
    if (!sameSpend(spend, view.spend)) spend = view.spend
    for (const listener of listeners) listener()
  }

  const fail = (text: string): void =>
    apply({
      steps: [...steps, { kind: "error", text, at: Date.now() }],
      turn: { ...turn, phase: "failed" },
      state: "idle",
      spend
    })

  const attach = async (): Promise<void> => {
    const answer = decodeCursorAnswer(
      await port.ask({ type: "cursor/attach", threadId: input.threadId, url: input.url, tabId: input.tabId })
    )
    // A thread the background refuses to open is an opening failure the panel draws.
    if (answer?.type === "cursor/failed") throw new Error(answer.message)
    if (answer?.type === "cursor/view") apply(answer)
  }

  await attach()

  const stopListening = port.listen((update) => {
    if (update.threadId === input.threadId) apply(update)
  })
  let disposed = false

  /**
   * A service worker may be stopped between two messages, and it wakes with no session in
   * hand. The panel attaches again and asks once more, so the reader never loses a send.
   */
  const ask = async (message: CursorAsk): Promise<void> => {
    try {
      const answer = decodeCursorAnswer(await port.ask(message))
      if (answer?.type === "cursor/view") return apply(answer)
      if (answer?.type === "cursor/failed") return fail(answer.message)
      if (answer?.type !== "cursor/unknownThread") return
      await attach()
      const retried = decodeCursorAnswer(await port.ask(message))
      if (retried?.type === "cursor/view") apply(retried)
      if (retried?.type === "cursor/failed") fail(retried.message)
    } catch {
      // The panel promises the caller that a send never rejects, so a service worker that
      // went away is drawn, not thrown. The next view from the background replaces it.
      fail(BACKGROUND_SILENT)
    }
  }

  return {
    threadId: input.threadId,
    url: input.url,
    steps: () => steps,
    turn: () => turn,
    state: () => state,
    spend: (): Spend => spend,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    /**
     * The run in the service worker holds the question, so its verdict is the one the card
     * acts on. A worker that went away, or one that no longer holds the thread, did not
     * take the answer: that is false, and the card offers the retry.
     */
    answerQuestion: async (callId, optionIds) => {
      try {
        const answer = decodeCursorAnswer(
          await port.ask({ type: "cursor/answer", threadId: input.threadId, callId, optionIds })
        )
        return answer?.type === "cursor/answered" && answer.accepted
      } catch {
        return false
      }
    },
    send: (text) => ask({ type: "cursor/send", threadId: input.threadId, text }),
    stop: () => ask({ type: "cursor/stop", threadId: input.threadId }),
    reset: () => ask({ type: "cursor/reset", threadId: input.threadId }),
    clear: () => ask({ type: "cursor/clear", threadId: input.threadId }),
    forgetPage: () => ask({ type: "cursor/forgetPage", threadId: input.threadId }),
    forgetSite: () => ask({ type: "cursor/forgetSite", threadId: input.threadId }),
    /**
     * Two things go here, and both are this proxy's own: the listener it added to the
     * shared channel, and the background session it asked the host to open. Without the
     * first, every panel a provider switch or a navigation replaced keeps decoding every
     * push for the rest of the page's life. Without the second, the Cursor socket, its
     * tool gate and its SSE reader stay up behind a panel that no longer draws them.
     */
    dispose: async () => {
      if (disposed) return
      disposed = true
      stopListening()
      listeners.clear()
      // A worker that went away has nothing to release, and the panel is going anyway.
      await port.ask({ type: "cursor/release", threadId: input.threadId }).catch(() => undefined)
    }
  }
}

/** The reader closed a thread: the background archives its agent and drops its record. */
export const closeCursorThread = async (port: CursorPort, threadId: string): Promise<void> => {
  await port.ask({ type: "cursor/close", threadId })
}

const pushes = new Set<(update: CursorUpdate) => void>()
let listening = false

/** The extension message channel. One `chrome.runtime` listener serves every proxy. */
export const chromeCursorPort: CursorPort = {
  ask: (message) => ask("cursor", message),
  listen: (onMessage) => {
    pushes.add(onMessage)
    if (!listening) {
      listening = true
      answer("cursorUpdate", decodeCursorUpdate, (update) => {
        for (const push of [...pushes]) push(update)
      })
    }
    return () => pushes.delete(onMessage)
  }
}
