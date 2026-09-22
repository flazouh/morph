import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { fakeBrowser } from "@webext-core/fake-browser"
import { accepting, answer, forgetAnswers } from "../bridge/messaging"
import { isCrewAsk, isOverlayAsk } from "../overlay/messages"
import { runtimeThatAnswers, tabsThatAnswer } from "../bridge/test-fixtures"
import { designScript, readyScript, stylesScript } from "../bridge/loader"
import { forPage, sourcesOf } from "../bridge/persisted"
import { registrations } from "../bridge/registrations"
import type { DeclarativeView } from "../marketplace/view"
import { USER_SCRIPTS_OFF } from "../bridge/user-scripts"
import { chromePage, Page, PageFailure, pageKey, patternOf } from "./page"

/**
 * The write side of the page binding against a fake `chrome`: what gets executed, and
 * what gets registered to run again on the next load.
 */

interface FakeChrome {
  readonly executed: Array<chrome.userScripts.ScriptSource>
  readonly registered: Map<string, chrome.userScripts.RegisteredUserScript>
  readonly storage: Record<string, unknown>
  /** What the next `execute` answers with. */
  outcome: { result?: unknown; error?: string }
  /** Whether the tab is the one in front, and what a capture of its window gives. */
  active: boolean
  captured: Array<{ windowId: number; format?: string }>
  /** Overlay verbs the page binding sent while looking. */
  told: Array<unknown>
  failRegistrationId?: string
}

const install = (): FakeChrome => {
  const fake: FakeChrome = { executed: [], registered: new Map(), storage: {}, outcome: { result: 1 }, active: true, captured: [], told: [] }
  const userScripts = {
    execute: async (injection: { js: ReadonlyArray<chrome.userScripts.ScriptSource> }) => {
      fake.executed.push(...injection.js)
      return [fake.outcome]
    },
    getScripts: async (filter?: { ids?: ReadonlyArray<string> }) =>
      [...fake.registered.values()].filter((s) => filter?.ids === undefined || filter.ids.includes(s.id)),
    register: async (scripts: ReadonlyArray<chrome.userScripts.RegisteredUserScript>) => {
      if (scripts.some((script) => script.id === fake.failRegistrationId)) {
        delete fake.failRegistrationId
        throw new Error("registration failed")
      }
      for (const s of scripts) fake.registered.set(s.id, s)
    },
    update: async (scripts: ReadonlyArray<chrome.userScripts.RegisteredUserScript>) => {
      for (const s of scripts) fake.registered.set(s.id, s)
    },
    unregister: async (filter: { ids: ReadonlyArray<string> }) => {
      for (const id of filter.ids) fake.registered.delete(id)
    }
  }
  const local = {
    get: async (key: string) => ({ [key]: fake.storage[key] }),
    set: async (items: Record<string, unknown>) => {
      Object.assign(fake.storage, items)
    }
  }
  const tabs = {
    get: async (id: number) => ({ id, windowId: 3, active: fake.active }),
    captureVisibleTab: async (windowId: number, options?: { format?: string }) => {
      fake.captured.push({ windowId, ...(options?.format === undefined ? {} : { format: options.format }) })
      return "data:image/jpeg;base64,/9j/4AAQ"
    },
    ...tabsThatAnswer()
  }
  ;(globalThis as { chrome?: unknown }).chrome = {
    userScripts,
    storage: { local },
    tabs,
    runtime: { getURL: (path: string) => `chrome-extension://abc/${path}`, ...runtimeThatAnswers() }
  }
  // The content host's side: it hears the overlay and crew verbs the binding sends while looking.
  const told = (data: unknown): { readonly type: "ok" } => {
    fake.told.push(data)
    return { type: "ok" }
  }
  answer("overlay", accepting(isOverlayAsk), told)
  answer("crew", accepting(isCrewAsk), told)
  return fake
}

const TAB = { id: 7, url: "https://news.ycombinator.com/news?p=2" }
/** The fonts' URL, told to the page before the kit. */
const ASSETS = { code: 'window.__beuiAssets = "chrome-extension://abc/fonts/"' }
const page = chromePage(TAB)
const on = <A, E>(effect: Effect.Effect<A, E, Page>) => Effect.runPromise(Effect.provide(effect, page))

let fake: FakeChrome
beforeEach(() => {
  fake = install()
})
afterEach(() => {
  forgetAnswers()
  fakeBrowser.reset()
  delete (globalThis as { chrome?: unknown }).chrome
})

describe("pageKey", () => {
  test("origin and path, without the query or the hash", () => {
    expect(pageKey("https://news.ycombinator.com/news?p=2#x")).toBe("https://news.ycombinator.com/news")
    expect(pageKey("https://x.test/")).toBe("https://x.test/")
  })
})

describe("patternOf", () => {
  test("a site-root script matches the host so /?p=2 is included; other paths stay path-scoped", () => {
    expect(patternOf("https://news.ycombinator.com/", "script")).toBe("https://news.ycombinator.com/*")
    expect(patternOf("https://news.ycombinator.com/", "declarative")).toBe("https://news.ycombinator.com/*")
    expect(patternOf("https://news.ycombinator.com/?p=2", "script")).toBe("https://news.ycombinator.com/*")
    expect(patternOf("https://news.ycombinator.com/", "style")).toBe("https://news.ycombinator.com/")
    expect(patternOf("https://news.ycombinator.com/news?p=2", "script")).toBe("https://news.ycombinator.com/news*")
  })
})

describe("forPage", () => {
  test("the body runs on that path, including a query, and not on another path", () => {
    const body = forPage("https://news.ycombinator.com/", "return 1")
    const run = (pathname: string) =>
      Function("location", body)({ origin: "https://news.ycombinator.com", pathname })
    expect(run("/")).toBe(1)
    expect(run("/item")).toBeUndefined()
  })
})

describe("chromePage writes", () => {
  test("a write while the User Scripts switch is off fails with the switch's own code, not only prose", async () => {
    const chromeApi = (globalThis as { chrome: { userScripts: { getScripts: unknown } } }).chrome
    chromeApi.userScripts.getScripts = async () => {
      throw new Error("chrome.userScripts is unavailable")
    }
    const failure = await Effect.runPromise(
      Effect.provide(Effect.flip(Effect.flatMap(Page, (p) => p.style("body{}", false))), page)
    )
    expect(failure).toBeInstanceOf(PageFailure)
    expect(failure.code).toBe("userScriptsOff")
    expect(failure.message).toBe(USER_SCRIPTS_OFF)
    expect(fake.executed).toEqual([])
  })

  test("a persisted script on the site root matches the host and refuses other paths in the script itself", async () => {
    const root = chromePage({ id: 8, url: "https://news.ycombinator.com/" })
    await Effect.runPromise(Effect.provide(Effect.flatMap(Page, (p) => p.run("1", true)), root))
    const registered = fake.registered.get("redesign:script:https://news.ycombinator.com/")
    expect(registered).toMatchObject({ matches: ["https://news.ycombinator.com/*"] })
    expect(registered?.js?.[0]?.code).toContain(forPage("https://news.ycombinator.com/", "1"))
  })

  test("a persisted script runs now and is registered for the next load of the same path", async () => {
    await on(Effect.flatMap(Page, (p) => p.run("document.title = 'x'", true)))
    expect(fake.executed).toEqual([{ code: readyScript("document.title = 'x'", false) }])
    const registered = [...fake.registered.values()]
    expect(registered).toHaveLength(1)
    expect(registered[0]).toMatchObject({ id: "redesign:script:https://news.ycombinator.com/news", matches: ["https://news.ycombinator.com/news*"] })
    expect(fake.storage["registrations"]).toMatchObject({ "redesign:script:https://news.ycombinator.com/news": { id: "redesign:script:https://news.ycombinator.com/news" } })
  })

  test("a script that throws on the page is not registered, and the failure reaches the caller", async () => {
    fake.outcome = { error: "ReferenceError: nope" }
    const failure = await on(Effect.flip(Effect.flatMap(Page, (p) => p.run("nope()", true))))
    expect(failure.message).toBe("ReferenceError: nope")
    expect(fake.registered.size).toBe(0)
    expect(fake.storage["registrations"]).toBeUndefined()
  })

  test("a non-persisted script runs and leaves no registration", async () => {
    await on(Effect.flatMap(Page, (p) => p.run("1 + 1", false)))
    expect(fake.executed).toHaveLength(1)
    expect(fake.registered.size).toBe(0)
  })

  test("styles and script have separate registrations, and forget removes both", async () => {
    await on(Effect.flatMap(Page, (p) => p.style("body{background:#000}", true)))
    await on(Effect.flatMap(Page, (p) => p.run("void 0", true)))
    expect([...fake.registered.keys()].sort()).toEqual(["redesign:script:https://news.ycombinator.com/news", "redesign:style:https://news.ycombinator.com/news"])
    await on(Effect.flatMap(Page, (p) => p.forget()))
    expect(fake.registered.size).toBe(0)
    expect(fake.storage["registrations"]).toEqual({})
    // And the page in front of the reader takes its skin and its stylesheet off now, not at the next load.
    expect(fake.executed.at(-1)).toEqual({
      code: 'window.__redesignDeclarativeUndo?.(); window.__beui?.unskin?.(); document.getElementById("redesign-styles")?.remove()'
    })
  })
})

describe("chromePage skin", () => {
  test("a skin has its own registration, so a persisted script after it does not replace it", async () => {
    // Seen live on 2026-09-13: a persisted run_script that themed the nav bar overwrote the
    // whole skin's registration, and the redesign was gone at the next load.
    await on(Effect.flatMap(Page, (p) => p.skin("window.__beui.skin(function(){}, '', {})")))
    await on(Effect.flatMap(Page, (p) => p.run("void 0", true)))
    expect([...fake.registered.keys()].sort()).toEqual([
      "redesign:script:https://news.ycombinator.com/news",
      "redesign:skin:https://news.ycombinator.com/news"
    ])
    expect(fake.storage["registrations"]).toMatchObject({
      "redesign:skin:https://news.ycombinator.com/news": { payload: { kind: "skin", js: "window.__beui.skin(function(){}, '', {})" } }
    })
    // The kit goes in front of the skin now, the way it will at the next load.
    expect(fake.executed.slice(0, 3)).toEqual([ASSETS, { file: "kit.js" }, { code: readyScript("window.__beui.skin(function(){}, '', {})", false) }])
    await on(Effect.flatMap(Page, (p) => p.forget()))
    expect(fake.registered.size).toBe(0)
  })

  test("sourcesOf puts the kit in front of a skin", () => {
    expect(sourcesOf({ kind: "skin", js: "window.__beui.skin()" }, "https://news.ycombinator.com/news")).toEqual([
      ASSETS,
      { file: "kit.js" },
      { code: readyScript(forPage("https://news.ycombinator.com/news", "window.__beui.skin()"), true) }
    ])
  })
})

describe("chromePage kit", () => {
  test("load_kit runs the extension file now and registers nothing", async () => {
    await on(Effect.flatMap(Page, (p) => p.kit()))
    expect(fake.executed).toEqual([ASSETS, { file: "kit.js" }])
    expect(fake.registered.size).toBe(0)
  })

  test("a script runs now in its own function without the gate, and on later loads at document_start behind it, with the kit in front when it speaks to it", async () => {
    await on(Effect.flatMap(Page, (p) => p.run("__beui.mount('.score', 'Badge')", true)))
    expect(fake.executed).toEqual([{ code: readyScript("__beui.mount('.score', 'Badge')", false) }])
    expect(fake.registered.get("redesign:script:https://news.ycombinator.com/news")).toMatchObject({
      js: [ASSETS, { file: "kit.js" }, { code: readyScript(forPage("https://news.ycombinator.com/news", "__beui.mount('.score', 'Badge')"), true) }],
      runAt: "document_start"
    })
    await on(Effect.flatMap(Page, (p) => p.run("document.title = 'x'", true)))
    expect(fake.registered.get("redesign:script:https://news.ycombinator.com/news")).toMatchObject({
      js: [{ code: readyScript(forPage("https://news.ycombinator.com/news", "document.title = 'x'"), true) }]
    })
    // The store holds the script itself, not the code built around it.
    expect((fake.storage.registrations as Record<string, unknown>)["redesign:script:https://news.ycombinator.com/news"]).toEqual({
      id: "redesign:script:https://news.ycombinator.com/news",
      matches: "https://news.ycombinator.com/news*",
      payload: { kind: "script", js: "document.title = 'x'" }
    })
  })

  test("styles applied now never gate; the persisted copy does", async () => {
    await on(Effect.flatMap(Page, (p) => p.style("a{}", true)))
    expect(fake.executed).toEqual([{ code: stylesScript("redesign-styles", "a{}", false) }])
    expect(fake.registered.get("redesign:style:https://news.ycombinator.com/news")?.js).toEqual([{ code: stylesScript("redesign-styles", "a{}", true) }])
  })

  test("replay rebuilds a stored payload with this build's loader, and replays a legacy record as it was", async () => {
    await on(Effect.flatMap(Page, (p) => p.style("a{}", true)))
    const legacy = { id: "redesign:style:https://old.example/", matches: ["https://old.example/*"], js: [{ code: "old" }], runAt: "document_idle" as const, world: "MAIN" as const }
    ;(fake.storage.registrations as Record<string, unknown>)[legacy.id] = legacy
    // Chrome dropped every registration, as it does on install.
    fake.registered.clear()
    expect(await registrations.replay()).toBe(2)
    expect(fake.registered.get("redesign:style:https://news.ycombinator.com/news")).toEqual({
      id: "redesign:style:https://news.ycombinator.com/news",
      matches: ["https://news.ycombinator.com/news*"],
      js: [{ code: stylesScript("redesign-styles", "a{}", true) }],
      runAt: "document_start",
      world: "MAIN"
    })
    expect(fake.registered.get(legacy.id)).toEqual(legacy)
  })

  test("replace swaps a registration set and its stored records together", async () => {
    const first = { id: "redesign:style:https://one.test/", matches: "https://one.test/*", payload: { kind: "style" as const, css: "a{}" } }
    const second = { id: "redesign:style:https://two.test/", matches: "https://two.test/*", payload: { kind: "style" as const, css: "b{}" } }
    const replacement = { id: "redesign:style:https://three.test/", matches: "https://three.test/*", payload: { kind: "style" as const, css: "c{}" } }
    await registrations.put(first)
    await registrations.put(second)

    await registrations.replace([first.id, second.id], [second, replacement])

    expect([...fake.registered.keys()].sort()).toEqual([replacement.id, second.id])
    expect(Object.keys(fake.storage.registrations as Record<string, unknown>).sort()).toEqual([replacement.id, second.id])
  })

  test("replace restores live and stored registrations when the swap fails", async () => {
    const first = { id: "redesign:style:https://one.test/", matches: "https://one.test/*", payload: { kind: "style" as const, css: "a{}" } }
    const replacement = { id: "redesign:style:https://two.test/", matches: "https://two.test/*", payload: { kind: "style" as const, css: "b{}" } }
    await registrations.put(first)
    fake.failRegistrationId = replacement.id

    await expect(registrations.replace([first.id], [replacement])).rejects.toThrow("registration failed")

    expect([...fake.registered.keys()]).toEqual([first.id])
    expect(Object.keys(fake.storage.registrations as Record<string, unknown>)).toEqual([first.id])
  })

  test("the design is the site's: one registration for the whole origin, and forget leaves it", async () => {
    await on(Effect.flatMap(Page, (p) => p.design(":root { --primary: red; }", true)))
    expect(fake.executed[0]?.code).toBe(designScript("redesign-design", ":root { --primary: red; }", "redesign-palette"))
    expect(fake.registered.get("redesign:design:https://news.ycombinator.com")).toMatchObject({ matches: ["https://news.ycombinator.com/*"], runAt: "document_start" })
    // Page things, one from an older version of this extension, and another page's: forget clears this page's only.
    await on(Effect.flatMap(Page, (p) => p.run("document.title = 'x'", true)))
    fake.registered.set("redesign:kit:https://news.ycombinator.com/news", { id: "redesign:kit:https://news.ycombinator.com/news", js: [{ file: "kit.js" }], matches: ["*"] })
    fake.registered.set("redesign:style:https://example.com/", { id: "redesign:style:https://example.com/", js: [{ code: "" }], matches: ["*"] })
    await on(Effect.flatMap(Page, (p) => p.forget()))
    expect([...fake.registered.keys()].sort()).toEqual(["redesign:design:https://news.ycombinator.com", "redesign:style:https://example.com/"])
  })

  test("forgetSite removes every look on the host and leaves other hosts alone", async () => {
    await on(Effect.flatMap(Page, (p) => p.design(":root { --primary: red; }", true)))
    await on(Effect.flatMap(Page, (p) => p.style("body{background:#000}", true)))
    await on(Effect.flatMap(Page, (p) => p.run("document.title = 'x'", true)))
    await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(Page, (p) => p.style("body{color:red}", true)),
        chromePage({ id: 8, url: "https://news.ycombinator.com/item?id=1" })
      )
    )
    await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(Page, (p) => p.style("body{color:blue}", true)),
        chromePage({ id: 9, url: "https://example.com/news" })
      )
    )

    await on(Effect.flatMap(Page, (p) => p.forgetSite()))
    expect([...fake.registered.keys()]).toEqual(["redesign:style:https://example.com/news"])
    expect(Object.keys(fake.storage.registrations as Record<string, unknown>)).toEqual(["redesign:style:https://example.com/news"])
    expect(fake.executed.at(-1)).toEqual({
      code: 'window.__redesignDeclarativeUndo?.(); window.__beui?.unskin?.(); document.getElementById("redesign-styles")?.remove(); document.getElementById("redesign-design")?.remove()'
    })
  })

  test("sourcesOf is the one rule for the kit", () => {
    expect(sourcesOf({ kind: "script", js: "window.__beui.list()" }, "https://news.ycombinator.com/news")).toEqual([
      ASSETS,
      { file: "kit.js" },
      { code: readyScript(forPage("https://news.ycombinator.com/news", "window.__beui.list()"), true) }
    ])
    expect(sourcesOf({ kind: "script", js: "1 + 1" }, "https://news.ycombinator.com/news")).toEqual([
      { code: readyScript(forPage("https://news.ycombinator.com/news", "1 + 1"), true) }
    ])
    const view: DeclarativeView = {
      schema: 1,
      target: "body",
      sources: [{ id: "page", selector: "body", many: true, fields: { title: { selector: "h1", read: "text" } } }],
      styles: { page: { display: "block" } },
      root: { tag: "main", className: "page" }
    }
    expect(sourcesOf({ kind: "declarative", view }, "https://news.ycombinator.com/news")).toEqual([
      { file: "declarative.js" },
      {
        code: readyScript(
          forPage("https://news.ycombinator.com/news", `window.__redesignDeclarativeApply(${JSON.stringify(view)});`),
          true
        )
      }
    ])
  })

  test("look captures the tab's window as a JPEG when the tab is in front, and refuses when it is not", async () => {
    const shot = await on(Effect.flatMap(Page, (p) => p.look()))
    expect(shot).toStartWith("data:image/jpeg;base64,")
    expect(fake.captured).toEqual([{ windowId: 3, format: "jpeg" }])
    expect(fake.told).toEqual([
      { type: "hideChat" },
      { type: "hideCrewBots" },
      { type: "showCrewBots" },
      { type: "showChat" }
    ])

    fake.active = false
    await expect(on(Effect.flatMap(Page, (p) => p.look()))).rejects.toThrow("not the visible tab")
    expect(fake.captured).toHaveLength(1)
  })
})
