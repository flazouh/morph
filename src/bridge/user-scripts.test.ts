import { afterEach, describe, expect, test } from "bun:test"
import {
  decodeUserScriptsAsk,
  decodeUserScriptsStatus,
  userScriptsAvailable,
  userScriptsHandler,
  userScriptsSettingsUrl,
  type UserScriptsPorts
} from "./user-scripts"

const previousChrome = (globalThis as { chrome?: unknown }).chrome

const bindChrome = (userScripts: unknown) => {
  ;(globalThis as { chrome?: unknown }).chrome = { userScripts }
}

afterEach(() => {
  ;(globalThis as { chrome?: unknown }).chrome = previousChrome
})

describe("userScriptsAvailable", () => {
  test("a probe that answers means the switch is on", async () => {
    const asked: unknown[] = []
    bindChrome({
      getScripts: async (filter: unknown) => {
        asked.push(filter)
        return []
      }
    })
    expect(await userScriptsAvailable()).toBe(true)
    expect(asked).toEqual([{ ids: ["redesign:probe"] }])
  })

  test("a namespace Chrome never bound means off", async () => {
    bindChrome(undefined)
    expect(await userScriptsAvailable()).toBe(false)
  })

  test("a bound namespace whose call throws means off: the switch went off after this context started", async () => {
    bindChrome({
      getScripts: () => {
        throw new Error("userScripts is not allowed")
      }
    })
    expect(await userScriptsAvailable()).toBe(false)
  })

  test("a call that rejects means off", async () => {
    bindChrome({ getScripts: async () => Promise.reject(new Error("no")) })
    expect(await userScriptsAvailable()).toBe(false)
  })
})

describe("userScripts messages", () => {
  test("only the ask shape decodes", () => {
    expect(decodeUserScriptsAsk({ type: "userScripts/ask", ask: "status" })).toEqual({ type: "userScripts/ask", ask: "status" })
    expect(decodeUserScriptsAsk({ type: "userScripts/ask", ask: "format" })).toBeUndefined()
    expect(decodeUserScriptsAsk({ type: "cursor/send", ask: "status" })).toBeUndefined()
    expect(decodeUserScriptsAsk("status")).toBeUndefined()
    expect(decodeUserScriptsAsk(undefined)).toBeUndefined()
  })

  test("only the status shape decodes", () => {
    expect(decodeUserScriptsStatus({ type: "userScripts/status", enabled: true })).toEqual({ type: "userScripts/status", enabled: true })
    expect(decodeUserScriptsStatus({ type: "userScripts/status", enabled: "yes" })).toBeUndefined()
    expect(decodeUserScriptsStatus(undefined)).toBeUndefined()
  })
})

describe("userScriptsHandler", () => {
  const fakePorts = (enabled: boolean) => {
    const calls: string[] = []
    const ports: UserScriptsPorts = {
      available: async () => {
        calls.push("available")
        return enabled
      },
      openTab: async (url, beside) => {
        calls.push(
          beside === undefined
            ? `open ${url}`
            : `open ${url} beside tab ${beside.tabId} in window ${beside.windowId} at ${beside.index + 1}`
        )
      },
      reload: () => {
        calls.push("reload")
      },
      settingsUrl: userScriptsSettingsUrl("abc")
    }
    return { ports, calls }
  }

  test("status reads the switch and touches nothing", async () => {
    const { ports, calls } = fakePorts(false)
    expect(await userScriptsHandler(ports)({ type: "userScripts/ask", ask: "status" }, {})).toEqual({ type: "userScripts/status", enabled: false })
    expect(calls).toEqual(["available"])
  })

  test("openSettings opens Morph's details page, then reads the switch", async () => {
    const { ports, calls } = fakePorts(true)
    expect(await userScriptsHandler(ports)({ type: "userScripts/ask", ask: "openSettings" }, {})).toEqual({ type: "userScripts/status", enabled: true })
    expect(calls).toEqual(["open chrome://extensions/?id=abc", "available"])
  })

  test("openSettings opens the page beside the tab that asked, not in the last focused window", async () => {
    const { ports, calls } = fakePorts(false)
    await userScriptsHandler(ports)(
      { type: "userScripts/ask", ask: "openSettings" },
      { tab: { id: 7, windowId: 3, index: 2 } as chrome.tabs.Tab }
    )
    expect(calls[0]).toBe("open chrome://extensions/?id=abc beside tab 7 in window 3 at 3")
  })

  test("a sender without a tab id opens the page unanchored", async () => {
    const { ports, calls } = fakePorts(false)
    await userScriptsHandler(ports)(
      { type: "userScripts/ask", ask: "openSettings" },
      { tab: { windowId: 3, index: 2 } as chrome.tabs.Tab }
    )
    expect(calls[0]).toBe("open chrome://extensions/?id=abc")
  })

  test("reload restarts the extension", async () => {
    const { ports, calls } = fakePorts(false)
    await userScriptsHandler(ports)({ type: "userScripts/ask", ask: "reload" }, {})
    expect(calls[0]).toBe("reload")
  })
})
