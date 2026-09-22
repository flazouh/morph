import { describe, expect, test } from "bun:test"
import { Window } from "happy-dom"
import { ask, forgetAnswers, type Answer, type Data, type Kind } from "./bridge/messaging"
import { startInspectorContent } from "./inspector/content-startup"
import { INSPECTOR_SHEET_ID } from "./inspector/css"
import {
  createInspectorHandler,
  type InspectorAsk,
  type InspectorAnswer,
  type InspectorScripting
} from "./inspector/messages"
import type { ChangeRecord, SourceLocation } from "./inspector/model"
import type { InspectorStore } from "./inspector/session-store"
import { probeSource, type SourceProbe } from "./inspector/source"
import {
  createSourceResolver,
  type SourceFetch
} from "./inspector/source-resolver"

const page = "https://app.test/settings"
const active: ChangeRecord = {
  url: page,
  tailwind: false,
  changes: [
    {
      selector: "#save",
      property: "padding",
      before: "8px",
      after: "16px"
    }
  ],
  sources: {}
}

const fakeStore = () => {
  const calls: string[] = []
  let saved: ChangeRecord | null = active
  const store: InspectorStore = {
    load: async (tabId, key) => {
      calls.push(`load:${tabId}:${key}`)
      return saved
    },
    save: async (tabId, key, record) => {
      calls.push(`save:${tabId}:${key}`)
      saved = record
    },
    clear: async (tabId) => {
      calls.push(`clear:${tabId}`)
      saved = null
    }
  }
  return { store, calls }
}

const scripting = (result: SourceProbe, calls: unknown[]): InspectorScripting => ({
  executeScript: async (details) => {
    calls.push(details)
    return [{ result }]
  }
})

const noFetch: SourceFetch = async () => {
  throw new Error("unexpected fetch")
}

const sourcePrecision = (
  answer: InspectorAnswer
): SourceLocation["precision"] | null =>
  answer.type === "inspectorSourceResolved"
    ? answer.source?.precision ?? null
    : null

describe("inspector background handler", () => {
  test("load, save, and discard use the sender tab and page", async () => {
    const { store, calls } = fakeStore()
    const handler = createInspectorHandler({
      store,
      scripting: scripting({ kind: "none" }, []),
      resolveSource: createSourceResolver(noFetch)
    })
    const sender = { tab: { id: 17, url: page } }

    await expect(handler({ type: "loadInspector" }, sender)).resolves.toEqual({
      type: "inspectorLoaded",
      record: active
    })
    await expect(handler({ type: "saveInspector", record: active }, sender)).resolves.toEqual({
      type: "inspectorSaved"
    })
    await expect(handler({ type: "clearInspector" }, sender)).resolves.toEqual({
      type: "inspectorCleared"
    })
    expect(calls).toEqual([
      `load:17:${page}`,
      `save:17:${page}`,
      "clear:17"
    ])
  })

  test("messages without a complete sender tab return a typed actionable error", async () => {
    const { store } = fakeStore()
    const handler = createInspectorHandler({
      store,
      scripting: scripting({ kind: "none" }, []),
      resolveSource: createSourceResolver(noFetch)
    })

    const error = {
      type: "inspectorError",
      message: "Open Morph in a website tab and try again."
    } as const
    await expect(handler({ type: "loadInspector" }, {})).resolves.toEqual(error)
    await expect(handler({ type: "loadInspector" }, { tab: { id: 17 } })).resolves.toEqual(error)
  })

  test("source probing runs in the page MAIN world", async () => {
    const calls: unknown[] = []
    const source: SourceLocation = {
      file: "/src/Card.tsx",
      line: 12,
      column: 5,
      component: "Card",
      precision: "authored"
    }
    const handler = createInspectorHandler({
      store: fakeStore().store,
      scripting: scripting({ kind: "resolved", source }, calls),
      resolveSource: createSourceResolver(noFetch)
    })

    await expect(
      handler({ type: "resolveInspectorSource", selector: "#card" }, { tab: { id: 17, url: page } })
    ).resolves.toEqual({ type: "inspectorSourceResolved", source })
    expect(calls).toEqual([
      {
        target: { tabId: 17 },
        world: "MAIN",
        func: probeSource,
        args: ["#card"]
      }
    ])
  })

  test("generated positions resolve through the script's final external source map and cache both URLs", async () => {
    const generated = {
      url: "https://app.test/assets/app.js",
      line: 1,
      column: 1,
      component: "Card"
    }
    const requested: string[] = []
    const responses: Record<string, string> = {
      [generated.url]: [
        "render()",
        "//# sourceMappingURL=old.js.map",
        "//# sourceMappingURL=app.js.map"
      ].join("\n"),
      "https://app.test/assets/app.js.map": JSON.stringify({
        version: 3,
        sources: ["../src/Card.tsx"],
        names: [],
        mappings: [[[0, 0, 11, 4]]]
      })
    }
    const handler = createInspectorHandler({
      store: fakeStore().store,
      scripting: scripting({ kind: "generated", source: generated }, []),
      resolveSource: createSourceResolver(async (url) => {
        requested.push(url)
        const body = responses[url]
        if (body === undefined) throw new Error("not found")
        return { ok: true, text: async () => body }
      })
    })
    const ask = { type: "resolveInspectorSource", selector: "#card" } as const
    const sender = { tab: { id: 17, url: page } }

    const [first, second] = await Promise.all([
      handler(ask, sender),
      handler(ask, sender)
    ])

    expect(first).toEqual({
      type: "inspectorSourceResolved",
      source: {
        file: "https://app.test/src/Card.tsx",
        line: 12,
        column: 5,
        component: "Card",
        precision: "authored"
      }
    })
    expect(second).toEqual(first)
    expect(requested).toEqual([
      "https://app.test/assets/app.js",
      "https://app.test/assets/app.js.map"
    ])
  })

  test("generated positions resolve through an indexed external source map", async () => {
    const generated = {
      url: "https://app.test/assets/app.js",
      line: 1,
      column: 1,
      component: "Card"
    }
    const requested: string[] = []
    const handler = createInspectorHandler({
      store: fakeStore().store,
      scripting: scripting({ kind: "generated", source: generated }, []),
      resolveSource: createSourceResolver(async (url) => {
        requested.push(url)
        return {
          ok: true,
          text: async () => url === generated.url
            ? "render()\n//# sourceMappingURL=app.js.map"
            : JSON.stringify({
                version: 3,
                sections: [{
                  offset: { line: 0, column: 0 },
                  map: {
                    version: 3,
                    sources: ["../src/Card.tsx"],
                    names: [],
                    mappings: [[[0, 0, 7, 2]]]
                  }
                }]
              })
        }
      })
    })

    await expect(
      handler(
        { type: "resolveInspectorSource", selector: "#card" },
        { tab: { id: 17, url: page } }
      )
    ).resolves.toMatchObject({
      type: "inspectorSourceResolved",
      source: {
        file: "https://app.test/src/Card.tsx",
        line: 8,
        column: 3,
        precision: "authored"
      }
    })
    expect(requested).toEqual([
      generated.url,
      "https://app.test/assets/app.js.map"
    ])
  })

  test("a failed script fetch is removed from the cache and the next call can resolve", async () => {
    const generated = {
      url: "https://app.test/assets/app.js",
      line: 1,
      column: 1,
      component: "Card"
    }
    const requested: string[] = []
    let scriptAttempts = 0
    const handler = createInspectorHandler({
      store: fakeStore().store,
      scripting: scripting({ kind: "generated", source: generated }, []),
      resolveSource: createSourceResolver(async (url) => {
        requested.push(url)
        if (url === generated.url && scriptAttempts++ === 0) throw new Error("dev server starting")
        return {
          ok: true,
          text: async () => url === generated.url
            ? "render()\n//# sourceMappingURL=app.js.map"
            : JSON.stringify({
                version: 3,
                sources: ["../src/Card.tsx"],
                names: [],
                mappings: [[[0, 0, 11, 4]]]
              })
        }
      })
    })
    const ask = { type: "resolveInspectorSource", selector: "#card" } as const
    const sender = { tab: { id: 17, url: page } }

    expect(sourcePrecision(await handler(ask, sender))).toBe("transformed")
    expect(sourcePrecision(await handler(ask, sender))).toBe("authored")
    expect(requested).toEqual([
      generated.url,
      generated.url,
      "https://app.test/assets/app.js.map"
    ])
  })

  test("a failed map fetch is removed from the cache and the next call can resolve", async () => {
    const generated = {
      url: "https://app.test/assets/app.js",
      line: 1,
      column: 1,
      component: "Card"
    }
    const mapUrl = "https://app.test/assets/app.js.map"
    const requested: string[] = []
    let mapAttempts = 0
    const handler = createInspectorHandler({
      store: fakeStore().store,
      scripting: scripting({ kind: "generated", source: generated }, []),
      resolveSource: createSourceResolver(async (url) => {
        requested.push(url)
        if (url === mapUrl && mapAttempts++ === 0) throw new Error("map rebuilding")
        return {
          ok: true,
          text: async () => url === generated.url
            ? "render()\n//# sourceMappingURL=app.js.map"
            : JSON.stringify({
                version: 3,
                sources: ["../src/Card.tsx"],
                names: [],
                mappings: [[[0, 0, 11, 4]]]
              })
        }
      })
    })
    const ask = { type: "resolveInspectorSource", selector: "#card" } as const
    const sender = { tab: { id: 17, url: page } }

    expect(sourcePrecision(await handler(ask, sender))).toBe("transformed")
    expect(sourcePrecision(await handler(ask, sender))).toBe("authored")
    expect(requested).toEqual([generated.url, mapUrl, mapUrl])
  })

  test("a failed map parse is removed from the cache and the next call can resolve", async () => {
    const generated = {
      url: "https://app.test/assets/app.js",
      line: 1,
      column: 1,
      component: "Card"
    }
    const mapUrl = "https://app.test/assets/app.js.map"
    const requested: string[] = []
    let mapAttempts = 0
    const handler = createInspectorHandler({
      store: fakeStore().store,
      scripting: scripting({ kind: "generated", source: generated }, []),
      resolveSource: createSourceResolver(async (url) => {
        requested.push(url)
        return {
          ok: true,
          text: async () => {
            if (url === generated.url) return "render()\n//# sourceMappingURL=app.js.map"
            if (mapAttempts++ === 0) return "{broken"
            return JSON.stringify({
              version: 3,
              sources: ["../src/Card.tsx"],
              names: [],
              mappings: [[[0, 0, 11, 4]]]
            })
          }
        }
      })
    })
    const ask = { type: "resolveInspectorSource", selector: "#card" } as const
    const sender = { tab: { id: 17, url: page } }

    expect(sourcePrecision(await handler(ask, sender))).toBe("transformed")
    expect(sourcePrecision(await handler(ask, sender))).toBe("authored")
    expect(requested).toEqual([generated.url, mapUrl, mapUrl])
  })

  test("stable script and map URLs refresh after cache expiry", async () => {
    const generated = {
      url: "https://app.test/assets/app.js",
      line: 1,
      column: 1,
      component: "Card"
    }
    const requested: string[] = []
    let now = 0
    const handler = createInspectorHandler({
      store: fakeStore().store,
      scripting: scripting({ kind: "generated", source: generated }, []),
      resolveSource: createSourceResolver(
        async (url) => {
          requested.push(url)
          return {
            ok: true,
            text: async () => url === generated.url
              ? "render()\n//# sourceMappingURL=app.js.map"
              : JSON.stringify({
                  version: 3,
                  sources: ["../src/Card.tsx"],
                  names: [],
                  mappings: [[[0, 0, 11, 4]]]
                })
          }
        },
        { now: () => now, ttlMs: 100 }
      )
    })
    const ask = { type: "resolveInspectorSource", selector: "#card" } as const
    const sender = { tab: { id: 17, url: page } }

    await handler(ask, sender)
    now = 99
    await handler(ask, sender)
    now = 101
    await handler(ask, sender)

    expect(requested).toEqual([
      generated.url,
      "https://app.test/assets/app.js.map",
      generated.url,
      "https://app.test/assets/app.js.map"
    ])
  })

  test("generated positions resolve through inline base64 maps", async () => {
    const map = btoa(JSON.stringify({
      version: 3,
      sources: ["../src/Card.tsx"],
      names: [],
      mappings: [[[0, 0, 11, 4]]]
    }))
    const generated = {
      url: "https://app.test/assets/app.js",
      line: 1,
      column: 1,
      component: "Card"
    }
    const requested: string[] = []
    const handler = createInspectorHandler({
      store: fakeStore().store,
      scripting: scripting({ kind: "generated", source: generated }, []),
      resolveSource: createSourceResolver(async (url) => {
        requested.push(url)
        return {
          ok: true,
          text: async () => `render()\n//# sourceMappingURL=data:application/json;base64,${map}`
        }
      })
    })

    const answer = await handler(
      { type: "resolveInspectorSource", selector: "#card" },
      { tab: { id: 17, url: page } }
    )

    expect(answer).toMatchObject({
      type: "inspectorSourceResolved",
      source: {
        file: "https://app.test/src/Card.tsx",
        line: 12,
        precision: "authored"
      }
    })
    expect(requested).toEqual([generated.url])
  })

  test("a root-relative generated script resolves against the sender page", async () => {
    const requested: string[] = []
    const handler = createInspectorHandler({
      store: fakeStore().store,
      scripting: scripting({
        kind: "generated",
        source: {
          url: "/assets/app.js",
          line: 1,
          column: 1,
          component: "Card"
        }
      }, []),
      resolveSource: createSourceResolver(async (url) => {
        requested.push(url)
        return {
          ok: true,
          text: async () => url.endsWith(".map")
            ? JSON.stringify({
                version: 3,
                sources: ["../src/Card.tsx"],
                names: [],
                mappings: [[[0, 0, 11, 4]]]
              })
            : "render()\n//# sourceMappingURL=app.js.map"
        }
      })
    })

    const answer = await handler(
      { type: "resolveInspectorSource", selector: "#card" },
      { tab: { id: 17, url: page } }
    )

    expect(answer).toMatchObject({
      source: {
        file: "https://app.test/src/Card.tsx",
        precision: "authored"
      }
    })
    expect(requested).toEqual([
      "https://app.test/assets/app.js",
      "https://app.test/assets/app.js.map"
    ])
  })

  test("every failed script or map step keeps the generated position transformed", async () => {
    const generated = {
      url: "https://app.test/assets/app.js",
      line: 44,
      column: 9,
      component: "Card"
    }
    const expected = {
      type: "inspectorSourceResolved",
      source: {
        file: generated.url,
        line: 44,
        column: 9,
        component: "Card",
        precision: "transformed"
      }
    } as const
    const failures: ReadonlyArray<SourceFetch> = [
      async () => {
        throw new Error("script offline")
      },
      async () => ({ ok: true, text: async () => "render()" }),
      async (url) => {
        if (url === generated.url) {
          return { ok: true, text: async () => "render()\n//# sourceMappingURL=app.js.map" }
        }
        throw new Error("map offline")
      },
      async () => ({
        ok: true,
        text: async () => "render()\n//# sourceMappingURL=data:application/json,%7Bbroken"
      }),
      async (url) => ({
        ok: true,
        text: async () => url === generated.url
          ? "render()\n//# sourceMappingURL=app.js.map"
          : JSON.stringify({ version: 3, sources: ["Card.tsx"], names: [], mappings: "" })
      })
    ]

    for (const fetch of failures) {
      const handler = createInspectorHandler({
        store: fakeStore().store,
        scripting: scripting({ kind: "generated", source: generated }, []),
        resolveSource: createSourceResolver(fetch)
      })
      await expect(
        handler({ type: "resolveInspectorSource", selector: "#card" }, { tab: { id: 17, url: page } })
      ).resolves.toEqual(expected)
    }
  })

})

describe("inspector content startup", () => {
  test("restores the active CSS and returns without sending chat lifecycle state", async () => {
    const document = new Window().document as unknown as Document
    const sent: InspectorAsk[] = []
    const send = async (ask: InspectorAsk): Promise<InspectorAnswer> => {
      sent.push(ask)
      return { type: "inspectorLoaded", record: active }
    }

    await startInspectorContent(document, send)

    expect(sent).toEqual([{ type: "loadInspector" }])
    expect(document.getElementById(INSPECTOR_SHEET_ID)?.textContent).toBe(
      "#save {\n  padding: 16px !important;\n}"
    )
  })

  test("returns without a stylesheet when no stored inspector exists", async () => {
    const document = new Window().document as unknown as Document
    const sent: InspectorAsk[] = []

    await startInspectorContent(document, async (ask) => {
      sent.push(ask)
      return { type: "inspectorLoaded", record: null }
    })

    expect(sent).toEqual([{ type: "loadInspector" }])
    expect(document.getElementById(INSPECTOR_SHEET_ID)).toBeNull()
  })
})

/**
 * `./background` builds its stores over `chrome.storage.session` at import time, and the
 * test runner imports a module once, so every worker test in this file shares one state
 * object rather than each one silently writing into the first test's closure.
 */
const workerState: Record<string, unknown> = {}

/** A worker with the storage and listener surface `startBackground` touches, and nothing else. */
const fakeWorker = (state: Record<string, unknown> = workerState) => {
  let removeTab: ((tabId: number) => void) | undefined
  let updateTab: ((tabId: number, change: { readonly url?: string; readonly status?: string }, tab: { readonly url?: string }) => void) | undefined
  const badges: Array<{ readonly tabId: number; readonly text: string }> = []
  let onMessage:
    | ((message: unknown, sender: unknown, sendResponse: (answer: unknown) => void) => boolean | undefined)
    | undefined
  let sender: unknown
  const addListener = () => {}
  ;(globalThis as { chrome?: unknown }).chrome = {
    action: {
      onClicked: { addListener },
      setBadgeBackgroundColor: async () => {},
      setBadgeText: async (badge: { tabId: number; text: string }) => {
        badges.push(badge)
      },
      setTitle: async () => {}
    },
    runtime: {
      getURL: (path: string) => `chrome-extension://morphid/${path}`,
      onInstalled: { addListener },
      onStartup: { addListener },
      onSuspend: { addListener },
      onMessage: {
        addListener: (listener: typeof onMessage) => {
          onMessage = listener
        },
        removeListener: () => {
          onMessage = undefined
        }
      },
      // The protocol's own sender, routed straight into the worker's listener as `sender`.
      sendMessage: (message: unknown, callback: (answer: unknown) => void) => {
        onMessage?.(message, sender, callback)
      }
    },
    scripting: { executeScript: async () => [] },
    storage: {
      session: {
        get: async (key: string) => ({ [key]: state[key] }),
        set: async (items: Record<string, unknown>) => {
          Object.assign(state, items)
        }
      }
    },
    tabs: {
      onRemoved: {
        addListener: (listener: (tabId: number) => void) => {
          removeTab = listener
        }
      },
      onUpdated: {
        addListener: (listener: typeof updateTab) => {
          updateTab = listener
        }
      }
    }
  }
  // A worker from an earlier test may still answer in this process; only one may.
  forgetAnswers()
  return {
    badges,
    removeTab: (tabId: number) => removeTab?.(tabId),
    updateTab: (tabId: number, url: string) => updateTab?.(tabId, { status: "complete" }, { url }),
    ask: <K extends Kind>(type: K, data: Data<K>, from: unknown): Promise<Answer<K>> => {
      sender = from
      return ask(type, data)
    }
  }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe("background tab cleanup", () => {
  test("tab removal clears chat, inspector, and panel session state together", async () => {
    const state: Record<string, unknown> = Object.assign(workerState, {
      "open-chat-tabs": [17],
      "inspector-records": {
        "17": { page, record: active }
      },
      "panel-sessions": { "17": "secret" }
    })
    const worker = fakeWorker(state)

    try {
      const { startBackground } = await import("./background")
      startBackground()
      worker.removeTab(17)
      await settle()

      expect(state["open-chat-tabs"]).toEqual([])
      expect(state["inspector-records"]).toEqual({})
      expect(state["panel-sessions"]).toEqual({})
    } finally {
      forgetAnswers()
      delete (globalThis as { chrome?: unknown }).chrome
    }
  })

  test("a page that loads marks that tab's icon, and a page Morph cannot touch clears it", async () => {
    const worker = fakeWorker()

    try {
      const { startBackground } = await import("./background")
      startBackground()
      worker.updateTab(5, "chrome://extensions")
      worker.updateTab(6, "https://example.com/")
      await settle()

      // The marketplace cannot answer in this worker, so both read as nothing to add. What
      // this proves is the wiring: the tab that loaded is the tab that gets told.
      expect(worker.badges).toEqual([
        { tabId: 5, text: "" },
        { tabId: 6, text: "" }
      ])
    } finally {
      forgetAnswers()
      delete (globalThis as { chrome?: unknown }).chrome
    }
  })
})

describe("background panel session attestation", () => {
  test("the worker answers a page host's registration and its own panel's check", async () => {
    const worker = fakeWorker()

    try {
      const { startBackground } = await import("./background")
      startBackground()

      await expect(
        worker.ask(
          "panelSession",
          { type: "registerPanelSession", nonce: "secret" },
          { tab: { id: 17 }, url: "https://app.test/settings" }
        )
      ).resolves.toEqual({ type: "panelSessionRegistered" })

      await expect(
        worker.ask(
          "panelSession",
          { type: "validatePanelSession", nonce: "secret" },
          { tab: { id: 17 }, url: "chrome-extension://morphid/panel.html#morph-nonce=secret" }
        )
      ).resolves.toEqual({ type: "panelSessionChecked", valid: true })

      // The hostile case: a page framed panel.html with a nonce nobody registered.
      await expect(
        worker.ask(
          "panelSession",
          { type: "validatePanelSession", nonce: "page-chosen" },
          { tab: { id: 17 }, url: "chrome-extension://morphid/panel.html#morph-nonce=page-chosen" }
        )
      ).resolves.toEqual({ type: "panelSessionChecked", valid: false })
    } finally {
      forgetAnswers()
      delete (globalThis as { chrome?: unknown }).chrome
    }
  })
})
