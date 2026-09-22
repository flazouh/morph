/**
 * The Cursor lifecycle, owned by the MV3 service worker.
 *
 * One live Session per thread lives here, not in the panel. A run keeps going while the
 * panel iframe is closed, replaced, or reloaded, and every panel that attaches sees the
 * same steps. The host knows nothing about `chrome.runtime`: it takes decoded asks and
 * hands back decoded answers, so the whole lifecycle is testable without a browser.
 */

import type { Session } from "../session/contract"
import type { CursorAnswer, CursorAsk, CursorUpdate, CursorView } from "./messages"

export interface LiveCursorSession {
  readonly session: Session
  /** Stops the run and releases the relay socket, the tool server and the SSE reader. */
  readonly close: () => Promise<void>
}

export interface OpenCursorThread {
  readonly threadId: string
  readonly url: string
  readonly tabId: number
}

export interface CursorHostOptions {
  readonly open: (input: OpenCursorThread) => Promise<LiveCursorSession>
  /** Archives and drops a thread the host holds no session for. */
  readonly forget: (threadId: string) => Promise<void>
  readonly publish: (update: CursorUpdate) => void
}

export interface CursorHost {
  readonly handle: (ask: CursorAsk) => Promise<CursorAnswer>
  /**
   * Releases every live session. The persisted state stays: this is not a thread close.
   *
   * The worker calls this when Chrome says it is about to unload it, so the relay sockets
   * close on the way out instead of being cut. Chrome does not promise to ask, so this is
   * the tidy path and never the only one: every thread is readable from its record.
   */
  readonly shutdown: () => Promise<void>
}

interface Held {
  readonly live: LiveCursorSession
  readonly url: string
  readonly unsubscribe: () => void
}

const viewOf = (threadId: string, session: Session): CursorView => ({
  type: "cursor/view",
  threadId,
  steps: session.steps(),
  turn: session.turn(),
  state: session.state(),
  spend: session.spend()
})

export const cursorHost = (options: CursorHostOptions): CursorHost => {
  const held = new Map<string, Held>()
  /** One opening per thread. Two panels attaching at once must not open two sessions. */
  const opening = new Map<string, Promise<Held>>()

  const release = async (threadId: string): Promise<void> => {
    const entry = held.get(threadId)
    if (entry === undefined) return
    held.delete(threadId)
    entry.unsubscribe()
    await entry.live.close()
  }

  const start = async (input: OpenCursorThread): Promise<Held> => {
    const live = await options.open(input)
    const unsubscribe = live.session.subscribe(() => {
      options.publish({ ...viewOf(input.threadId, live.session), type: "cursor/update" })
    })
    const entry: Held = { live, url: input.url, unsubscribe }
    held.set(input.threadId, entry)
    return entry
  }

  const attach = async (input: OpenCursorThread): Promise<Held> => {
    // Two panels attaching at once must join one session, not open a second one.
    const pending = opening.get(input.threadId)
    if (pending !== undefined) {
      const opened = await pending
      if (opened.url === input.url) return opened
    }
    const current = held.get(input.threadId)
    // A thread whose page moved is a different page to restyle, so its session is remade.
    if (current !== undefined && current.url === input.url) return current
    if (current !== undefined) await release(input.threadId)
    const started = start(input).finally(() => opening.delete(input.threadId))
    opening.set(input.threadId, started)
    return started
  }

  const act = async (
    threadId: string,
    action: (session: Session) => Promise<void>
  ): Promise<CursorAnswer> => {
    const entry = held.get(threadId)
    if (entry === undefined) return { type: "cursor/unknownThread", threadId }
    await action(entry.live.session)
    return viewOf(threadId, entry.live.session)
  }

  const answer = async (ask: CursorAsk): Promise<CursorAnswer> => {
    switch (ask.type) {
      case "cursor/attach": {
        const entry = await attach(ask)
        return viewOf(ask.threadId, entry.live.session)
      }
      case "cursor/send":
        return act(ask.threadId, (session) => session.send(ask.text))
      case "cursor/stop":
        return act(ask.threadId, (session) => session.stop())
      case "cursor/reset":
        return act(ask.threadId, (session) => session.reset())
      case "cursor/clear":
        return act(ask.threadId, (session) => session.clear())
      case "cursor/forgetPage":
        return act(ask.threadId, (session) => session.forgetPage())
      case "cursor/forgetSite":
        return act(ask.threadId, (session) => session.forgetSite())
      case "cursor/answer": {
        const entry = held.get(ask.threadId)
        if (entry === undefined) return { type: "cursor/unknownThread", threadId: ask.threadId }
        // The view follows on the push the answered call causes; this reply carries the verdict.
        const accepted = await entry.live.session.answerQuestion(ask.callId, ask.optionIds)
        return { type: "cursor/answered", threadId: ask.threadId, accepted }
      }
      case "cursor/release": {
        // The same release a replaced page gets. Everything live goes: the run, the tool
        // gate, the socket and the reader. What was persisted stays, and it is the whole
        // thread, so switching provider and switching back reads the same steps, the same
        // agent and the same spend. The thread is not closed, so no agent is archived.
        await release(ask.threadId)
        return { type: "cursor/done", threadId: ask.threadId }
      }
      case "cursor/close": {
        const entry = held.get(ask.threadId)
        // `clear` archives the agent and drops the record; without a session, `forget` does.
        if (entry !== undefined) await entry.live.session.clear()
        await release(ask.threadId)
        if (entry === undefined) await options.forget(ask.threadId)
        return { type: "cursor/done", threadId: ask.threadId }
      }
    }
  }

  /** A thread already open in another tab, a page that went away: news, not a dead panel. */
  const handle = (ask: CursorAsk): Promise<CursorAnswer> =>
    answer(ask).catch((error: unknown) => ({
      type: "cursor/failed" as const,
      threadId: ask.threadId,
      message: error instanceof Error ? error.message : String(error)
    }))

  return {
    handle,
    shutdown: async () => {
      await Promise.all([...held.keys()].map(release))
    }
  }
}
