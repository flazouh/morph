import { describe, expect, test } from "bun:test"
import { sendOrInject, withChatHidden, type TabPort } from "./tab"

const record = (): TabPort & { sent: unknown[]; injected: number[]; failFirst: boolean } => {
  const port = {
    sent: [] as unknown[],
    injected: [] as number[],
    failFirst: false,
    send: async (tabId: number, message: unknown) => {
      if (port.failFirst) {
        port.failFirst = false
        throw new Error("Receiving end does not exist")
      }
      port.sent.push({ tabId, message })
    },
    inject: async (tabId: number) => {
      port.injected.push(tabId)
    }
  }
  return port
}

describe("sendOrInject", () => {
  test("a tab is sent the requested card state", async () => {
    const port = record()
    await sendOrInject(7, { type: "openChat" }, port)
    expect(port.sent).toEqual([{ tabId: 7, message: { type: "openChat" } }])
    expect(port.injected).toEqual([])
  })

  test("a tab with no content script is injected once, then asked again", async () => {
    const port = record()
    port.failFirst = true
    await sendOrInject(7, { type: "openChat" }, port)
    expect(port.injected).toEqual([7])
    expect(port.sent).toEqual([{ tabId: 7, message: { type: "openChat" } }])
  })

  test("withChatHidden hides, runs the action, then shows even when the action throws", async () => {
    const port = record()
    const seen: string[] = []
    await withChatHidden(7, port, async () => {
      seen.push("ran")
    })
    expect(seen).toEqual(["ran"])
    expect(port.sent).toEqual([
      { tabId: 7, message: { type: "hideChat" } },
      { tabId: 7, message: { type: "hideCrewBots" } },
      { tabId: 7, message: { type: "showCrewBots" } },
      { tabId: 7, message: { type: "showChat" } }
    ])

    port.sent.length = 0
    await expect(
      withChatHidden(7, port, async () => {
        throw new Error("capture failed")
      })
    ).rejects.toThrow("capture failed")
    expect(port.sent).toEqual([
      { tabId: 7, message: { type: "hideChat" } },
      { tabId: 7, message: { type: "hideCrewBots" } },
      { tabId: 7, message: { type: "showCrewBots" } },
      { tabId: 7, message: { type: "showChat" } }
    ])
  })

  test("a send that fails for another reason is not papered over with an inject", async () => {
    const injected: number[] = []
    const port: TabPort = {
      send: async () => {
        throw new Error("the tab went away")
      },
      inject: async (tabId) => {
        injected.push(tabId)
      }
    }
    await expect(sendOrInject(7, { type: "openChat" }, port)).rejects.toThrow("the tab went away")
    expect(injected).toEqual([])
  })
})
