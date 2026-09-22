import { Context, Effect, Layer } from "effect"
import { ask, unanswered } from "../bridge/messaging"
import { chromeTabSend, withChatHidden } from "../overlay/tab"
import type { DesignReport, PageAnswer, PageAsk, PageOutline, StyledNode } from "../bridge/messages"
import type { ToolErrorCode } from "./tool-names"
import { designScript, readyScript, stylesScript } from "../bridge/loader"
import { kitSources, sourcesOf, type Payload } from "../bridge/persisted"
import { registrations } from "../bridge/registrations"
import { pageKey, patternOf, scopeOf, siteKey } from "../bridge/scope"
import { USER_SCRIPTS_OFF, userScriptsAvailable } from "../bridge/user-scripts"
import { SHEETS } from "../kit/tokens"
import { shrink } from "./eyes"

/**
 * The page as the agent sees it: four reads and four writes, and nothing about tabs,
 * content scripts or `chrome.userScripts`. Tools speak to this. The chrome binding is
 * below; tests bind a fake.
 */
export class Page extends Context.Service<
  Page,
  {
    readonly read: (selector: string | undefined, maxNodes: number) => Effect.Effect<PageOutline, PageFailure>
    readonly styles: (selector: string, limit: number) => Effect.Effect<ReadonlyArray<StyledNode>, PageFailure>
    readonly text: (selector: string, limit: number) => Effect.Effect<ReadonlyArray<string>, PageFailure>
    /** The design tokens as the page resolves them now. */
    readonly tokens: () => Effect.Effect<DesignReport, PageFailure>
    /** Replace the page's redesign stylesheet with `css`. Persists across reloads when `persist`. */
    readonly style: (css: string, persist: boolean) => Effect.Effect<void, PageFailure>
    /** Replace the site's design stylesheet (token overrides) with `css`, on every page of the host when `persist`. */
    readonly design: (css: string, persist: boolean) => Effect.Effect<void, PageFailure>
    /** Run `js` on the page now. Persists across reloads when `persist`. */
    readonly run: (js: string, persist: boolean) => Effect.Effect<unknown, PageFailure>
    /** Put a compiled skin on the page now, the kit in front of it, and re-run it on load. Its own slot, apart from `run`. */
    readonly skin: (js: string) => Effect.Effect<void, PageFailure>
    /** Put the component kit (`window.__beui`) on the page now. */
    readonly kit: () => Effect.Effect<void, PageFailure>
    /** Forget every persisted script and style for this page. The site's design stays. */
    readonly forget: () => Effect.Effect<void, PageFailure>
    /** Forget every persisted look for this site and undo the current page now. */
    readonly forgetSite: () => Effect.Effect<void, PageFailure>
    /** A picture of the page as the reader sees it now: a JPEG data URL, scaled to `LOOK_WIDTH` (eyes.ts). */
    readonly look: () => Effect.Effect<string, PageFailure>
  }
>()("redesign/Page") {}

export class PageFailure extends Error {
  readonly _tag = "PageFailure"
  constructor(
    message: string,
    /** Set when the panel has something to do about this failure beyond drawing it. */
    readonly code?: ToolErrorCode
  ) {
    super(message)
  }
}

const fail = (e: unknown): PageFailure =>
  e instanceof PageFailure ? e : new PageFailure(e instanceof Error ? e.message : String(e))

/** A page's identity for the log, the registrations and the repo: origin and path, no query. */
export { pageKey, pathOf, patternOf, siteKey } from "../bridge/scope"

/**
 * What `forget` removes for a page: its style and script, plus the ids two earlier builds
 * of this extension registered per page (a separate kit, a per-page design). The legacy
 * pair can go once no installed page carries them; a reset clears them.
 */
const forgottenIds = (url: string): ReadonlyArray<string> => [
  scopeOf(url, "style").id,
  scopeOf(url, "script").id,
  scopeOf(url, "skin").id,
  scopeOf(url, "declarative").id,
  `redesign:kit:${pageKey(url)}`,
  `redesign:design:${pageKey(url)}`
]

/**
 * Undoes on the page in front of the reader what forget undoes for the next load: the skin
 * comes off, and the page's own stylesheet goes. The site's design stays, as its
 * registration does. A page without the kit has no skin to take off.
 */
const UNDRESS = `window.__redesignDeclarativeUndo?.(); window.__beui?.unskin?.(); document.getElementById(${JSON.stringify(SHEETS.styles)})?.remove()`
const UNDRESS_SITE = `${UNDRESS}; document.getElementById(${JSON.stringify(SHEETS.design)})?.remove()`

/** The binding for a real tab: reads through the content script, writes through user scripts. */
export const chromePage = (tab: { readonly id: number; readonly url: string }): Layer.Layer<Page> => {
  /**
   * A tab opened before the extension was installed, or before a reload of it, has no
   * content script. Chrome says so with "Receiving end does not exist", and the fix is
   * to put the script there now and ask again, once.
   */
  const send = async (message: PageAsk): Promise<PageAnswer> => {
    try {
      return await ask("page", message, { tabId: tab.id })
    } catch (e) {
      if (!unanswered(e)) throw e
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content-scripts/content.js"] })
      return await ask("page", message, { tabId: tab.id })
    }
  }

  const askPage = <A extends PageAnswer["type"]>(message: PageAsk, expect: A) =>
    Effect.tryPromise({
      try: async () => {
        const answer = await send(message)
        if (answer.type === "error") throw new Error(answer.message)
        if (answer.type !== expect) throw new Error(`asked ${expect}, got ${answer.type}`)
        return answer as Extract<PageAnswer, { type: A }>
      },
      catch: fail
    })

  /**
   * Run a script on the page now and, when `persist` carries a payload, on every later load.
   * A script that threw is not kept: a registration re-runs on every load of the URL, and
   * the model was told it failed. The two copies differ in one thing: the persisted one may
   * hide the page until it is ready; the one applied now, while the reader watches, does not.
   */
  const execute = (sources: readonly [chrome.userScripts.ScriptSource, ...chrome.userScripts.ScriptSource[]], persist: Payload | undefined) =>
    Effect.tryPromise({
      try: async () => {
        if (!(await userScriptsAvailable())) throw new PageFailure(USER_SCRIPTS_OFF, "userScriptsOff")
        const [result] = await chrome.userScripts.execute({
          target: { tabId: tab.id },
          js: [...sources],
          world: "MAIN"
        })
        if (result?.error !== undefined) throw new Error(String(result.error))
        if (persist !== undefined) await registrations.put({ ...scopeOf(tab.url, persist.kind), payload: persist })
        return result?.result
      },
      catch: fail
    })

  /** A stylesheet the page wears: replaced whole each time. */
  const wear = (kind: "design" | "style", css: string, persist: boolean) => {
    const code = kind === "design" ? designScript(SHEETS.design, css, SHEETS.palette) : stylesScript(SHEETS.styles, css, false)
    return Effect.asVoid(execute([{ code }], persist ? { kind, css } : undefined))
  }

  return Layer.succeed(Page, {
    read: (selector, maxNodes) =>
      Effect.map(askPage({ type: "readPage", ...(selector === undefined ? {} : { selector }), maxNodes }, "readPage"), (a) => a.page),
    styles: (selector, limit) => Effect.map(askPage({ type: "readStyles", selector, limit }, "readStyles"), (a) => a.nodes),
    text: (selector, limit) => Effect.map(askPage({ type: "readText", selector, limit }, "readText"), (a) => a.texts),
    tokens: () => Effect.map(askPage({ type: "readDesign" }, "readDesign"), (a) => a.design),
    design: (css, persist) => wear("design", css, persist),
    style: (css, persist) => wear("style", css, persist),
    run: (js, persist) => execute([{ code: readyScript(js, false) }], persist ? { kind: "script", js } : undefined),
    skin: (js) => Effect.asVoid(execute([...kitSources(), { code: readyScript(js, false) }], { kind: "skin", js })),
    kit: () => Effect.asVoid(execute(kitSources(), undefined)),
    look: () =>
      Effect.tryPromise({
        try: async () => {
          // captureVisibleTab takes the tab in front; the one under redesign has to be it.
          const current = await chrome.tabs.get(tab.id)
          if (!current.active) throw new Error("the page is not the visible tab; the reader has to have it in front to be looked at")
          return withChatHidden(tab.id, { send: chromeTabSend }, async () => {
            const shot = await chrome.tabs.captureVisibleTab(current.windowId, { format: "jpeg", quality: 80 })
            return shrink(shot)
          })
        },
        catch: fail
      }),
    forget: () =>
      Effect.tryPromise({
        try: async () => {
          if (!(await userScriptsAvailable())) return
          await registrations.remove(forgottenIds(tab.url))
          // The registrations were for the next load; the page in front of the reader still wears the code.
          await chrome.userScripts.execute({ target: { tabId: tab.id }, js: [{ code: UNDRESS }], world: "MAIN" })
        },
        catch: fail
      }),
    forgetSite: () =>
      Effect.tryPromise({
        try: async () => {
          if (!(await userScriptsAvailable())) return
          await registrations.removeSite(siteKey(tab.url))
          await chrome.userScripts.execute({ target: { tabId: tab.id }, js: [{ code: UNDRESS_SITE }], world: "MAIN" })
        },
        catch: fail
      })
  })
}
