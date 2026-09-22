import { describe, expect, test } from "bun:test"
import { chatTabs, type ChatMemory } from "./session"
import type { TabPort } from "./tab"

const record = () => {
  const open = new Set<number>()
  const sent: unknown[] = []
  const memory: ChatMemory = {
    has: async (tabId) => open.has(tabId),
    set: async (tabId, value) => {
      if (value) open.add(tabId)
      else open.delete(tabId)
    }
  }
  const port: TabPort = {
    send: async (tabId, message) => {
      sent.push({ tabId, message })
    },
    inject: async () => {}
  }
  return { tabs: chatTabs(memory, port), open, sent }
}

describe("chat state for browser tabs", () => {
  test("opening one tab does not open another tab", async () => {
    const { tabs, open, sent } = record()
    await tabs.toggle({ id: 7, url: "https://news.ycombinator.com/" })

    expect(open).toEqual(new Set([7]))
    expect(sent).toEqual([{ tabId: 7, message: { type: "openChat" } }])
    expect(await tabs.restore(8)).toBe(false)
  })

  test("a new document in an open tab restores the card", async () => {
    const { tabs, sent } = record()
    await tabs.toggle({ id: 7, url: "https://news.ycombinator.com/" })
    sent.length = 0

    expect(await tabs.restore(7)).toBe(true)
    expect(sent).toEqual([{ tabId: 7, message: { type: "openChat" } }])
  })

  test("toolbar toggle and panel close clear the remembered state", async () => {
    const { tabs, open, sent } = record()
    await tabs.toggle({ id: 7, url: "https://news.ycombinator.com/" })
    await tabs.toggle({ id: 7, url: "https://news.ycombinator.com/item?id=1" })

    expect(open.size).toBe(0)
    expect(sent.at(-1)).toEqual({ tabId: 7, message: { type: "closeChat" } })

    await tabs.toggle({ id: 7, url: "https://news.ycombinator.com/" })
    await tabs.close(7)
    expect(open.size).toBe(0)
    expect(await tabs.restore(7)).toBe(false)
  })

  test("two quick toolbar clicks run in order", async () => {
    const { tabs, open, sent } = record()
    const tab = { id: 7, url: "https://news.ycombinator.com/" }
    await Promise.all([tabs.toggle(tab), tabs.toggle(tab)])

    expect(open.size).toBe(0)
    expect(sent).toEqual([
      { tabId: 7, message: { type: "openChat" } },
      { tabId: 7, message: { type: "closeChat" } }
    ])
  })

  test("a blocked tab does not block another tab", async () => {
    let release = () => {}
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const sent: number[] = []
    const memory: ChatMemory = {
      has: async () => false,
      set: async () => {}
    }
    const port: TabPort = {
      send: async (tabId) => {
        sent.push(tabId)
        if (tabId === 1) await blocked
      },
      inject: async () => {}
    }
    const tabs = chatTabs(memory, port)
    const first = tabs.toggle({ id: 1, url: "https://example.com/" })
    await Promise.resolve()
    const second = tabs.toggle({ id: 2, url: "https://example.org/" })
    await Promise.resolve()
    await Promise.resolve()

    try {
      expect(sent).toEqual([1, 2])
    } finally {
      release()
      await Promise.all([first, second])
    }
  })
})
