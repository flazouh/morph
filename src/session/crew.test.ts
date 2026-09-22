import { describe, expect, test } from "bun:test"
import { NO_SPEND } from "../agent/spend"
import { IDLE_TURN, type Session, type Step } from "./contract"
import { createCrewSessions } from "./crew"
import { memoryThreads } from "./threads"

const sessionOf = (
  threadId: string,
  onSend: (text: string, steps: Step[]) => Promise<void> = async (text, steps) => {
    steps.push({ kind: "assistant", text: `finished ${text}`, at: 1 })
  },
  onStop: () => Promise<void> = async () => {}
): Session => {
  const steps: Step[] = []
  return {
    threadId,
    url: "https://example.com/page",
    send: (text) => onSend(text, steps),
    stop: onStop,
    answerQuestion: async () => false,
    steps: () => steps,
    turn: () => IDLE_TURN,
    state: () => "idle",
    spend: () => NO_SPEND,
    subscribe: () => () => {},
    reset: async () => {},
    clear: async () => {},
    forgetPage: async () => {},
    forgetSite: async () => {}
  }
}

describe("crew sessions", () => {
  test("a spawned bot gets a child chat, runs in it, and notifies its parent", async () => {
    const threads = memoryThreads(() => "child-thread")
    const state = await threads.state("https://example.com/page")
    const root = state.items[0]!
    const opened: string[] = []
    const openedOn: string[] = []
    const manager = createCrewSessions({
      threads,
      id: () => "child-agent",
      send: async () => {},
      open: async (threadId, page) => {
        opened.push(threadId)
        openedOn.push(page.url)
        return sessionOf(threadId)
      }
    })
    const prepared = manager.prepare({ id: 7, url: "https://example.com/page" }, state, root)

    const child = prepared.context!.runtime.spawn(root.id, "audit checkout", "Checkout", "#checkout")
    const result = await prepared.context!.runtime.awaitAgents([child.id])
    const next = await threads.state("https://example.com/page")
    const childThread = next.items.find((thread) => thread.agentId === child.id)

    expect(opened).toEqual(["child-thread"])
    expect(openedOn).toEqual(["https://example.com/page"])
    expect(childThread).toMatchObject({
      parentId: root.id,
      rootId: root.id,
      target: "#checkout",
      status: "done"
    })
    expect(result.outputs.get(child.id)).toBe("finished audit checkout")
  })

  test("sessions are cached per page and never reused after page navigation", async () => {
    const threads = memoryThreads()
    const firstState = await threads.state("https://example.com/one")
    const thread = firstState.items[0]!
    const manager = createCrewSessions({
      threads,
      send: async () => {},
      open: async (threadId) => sessionOf(threadId)
    })
    const first = sessionOf(thread.id)
    manager.remember("https://example.com/one", thread.id, first)

    expect(manager.prepare({ id: 7, url: "https://example.com/one" }, firstState, thread).cached).toBe(first)
    expect(manager.prepare({ id: 7, url: "https://example.com/two" }, firstState, thread).cached).toBeUndefined()
  })

  test("a persisted child without a live crew runs without crew tools", async () => {
    const threads = memoryThreads(() => "child-thread")
    const state = await threads.state("https://example.com/page")
    const root = state.items[0]!
    const child = await threads.createChild(state.site, root.id, {
      title: "Old bot",
      status: "done",
      agentId: "old-agent"
    })
    const current = await threads.state("https://example.com/page")
    const manager = createCrewSessions({
      threads,
      send: async () => {},
      open: async (threadId) => sessionOf(threadId)
    })

    expect(manager.prepare({ id: 7, url: "https://example.com/page" }, current, child).context).toBeUndefined()
  })

  test("stop ends every remembered session and clears page bots", async () => {
    const threads = memoryThreads()
    const state = await threads.state("https://example.com/page")
    const root = state.items[0]!
    let stopped = 0
    const sent: unknown[] = []
    const manager = createCrewSessions({
      threads,
      send: async (_tabId, message) => {
        sent.push(message)
      },
      open: async (threadId) => sessionOf(threadId)
    })
    manager.prepare({ id: 7, url: "https://example.com/page" }, state, root)
    manager.remember("https://example.com/page", root.id, sessionOf(root.id, undefined, async () => {
      stopped++
    }))

    await manager.stop()

    expect(stopped).toBe(1)
    expect(sent.at(-1)).toEqual({ type: "clearCrewBots" })
  })
})
