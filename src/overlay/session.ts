import type { OverlayAsk } from "./messages"
import { sendOrInject, type TabPort } from "./tab"

export interface ChatMemory {
  readonly has: (tabId: number) => Promise<boolean>
  readonly set: (tabId: number, open: boolean) => Promise<void>
}

export interface ChatTabs {
  readonly toggle: (tab: { readonly id?: number; readonly url?: string }) => Promise<void>
  readonly restore: (tabId: number) => Promise<boolean>
  readonly close: (tabId: number) => Promise<void>
}

const isWebsite = (url: string): boolean => /^https?:/.test(url)

export const chatTabs = (memory: ChatMemory, port: TabPort): ChatTabs => {
  const queues = new Map<number, Promise<void>>()
  const serialized = <A>(tabId: number, run: () => Promise<A>): Promise<A> => {
    const previous = queues.get(tabId) ?? Promise.resolve()
    const result = previous.then(run, run)
    const settled = result.then(
      () => {},
      () => {}
    )
    queues.set(tabId, settled)
    void settled.then(() => {
      if (queues.get(tabId) === settled) queues.delete(tabId)
    })
    return result
  }

  const show = async (tabId: number, message: OverlayAsk): Promise<void> => {
    await sendOrInject(tabId, message, port)
  }

  return {
    toggle: (tab) => {
      if (tab.id === undefined || tab.url === undefined || !isWebsite(tab.url)) return Promise.resolve()
      const tabId = tab.id
      return serialized(tabId, async () => {
        const open = !(await memory.has(tabId))
        await show(tabId, { type: open ? "openChat" : "closeChat" })
        await memory.set(tabId, open)
      })
    },
    restore: (tabId) =>
      serialized(tabId, async () => {
        if (!(await memory.has(tabId))) return false
        await show(tabId, { type: "openChat" })
        return true
      }),
    close: (tabId) =>
      serialized(tabId, async () => {
        await memory.set(tabId, false)
      })
  }
}
