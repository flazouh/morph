import { SHEETS } from "../kit/tokens"
import type { SandboxCapabilities } from "../marketplace/manifest"
import type { DeclarativeView } from "../marketplace/view"
import { designScript, readyScript, stylesScript } from "./loader"

/**
 * What a page wears, as remembered: the CSS or the JS itself, not the script built around
 * it. The script is rebuilt from this by the build that runs it, so a change to loader.ts
 * reaches every page redesigned before it, at the next replay.
 */
export type Payload =
  | { readonly kind: "design"; readonly css: string }
  | { readonly kind: "style"; readonly css: string }
  | { readonly kind: "script"; readonly js: string }
  /** A compiled skin, the kit call included. Its own slot, so a persisted script does not replace it. */
  | { readonly kind: "skin"; readonly js: string }
  | { readonly kind: "declarative"; readonly view: DeclarativeView }
  | {
      readonly kind: "sandbox"
      readonly js: string
      readonly css: string
      readonly capabilities: SandboxCapabilities
    }

export type Kind = Payload["kind"]

export interface Persisted {
  readonly id: string
  readonly matches: string
  readonly payload: Payload
}

/** A host-wide registration still only runs the body on this path (query ignored). */
export const forPage = (key: string, js: string): string =>
  `if (location.origin + location.pathname !== ${JSON.stringify(key)}) return;\n${js}`

const pageKeyOf = (id: string): string | undefined => {
  for (const kind of ["script", "skin", "declarative"]) {
    const prefix = `redesign:${kind}:`
    if (id.startsWith(prefix)) return id.slice(prefix.length)
  }
  return undefined
}

const declarativeScript = (view: DeclarativeView): string => `window.__redesignDeclarativeApply(${JSON.stringify(view)});`

export const KIT: chrome.userScripts.ScriptSource = { file: "kit.js" }

/**
 * Where the extension's fonts are, told to the page right before the kit: the kit runs
 * in the page's world, where there is no chrome.runtime to ask. Built when asked, since
 * the URL carries the extension's id.
 */
export const assets = (): chrome.userScripts.ScriptSource => ({ code: `window.__beuiAssets = ${JSON.stringify(chrome.runtime.getURL("fonts/"))}` })

/** The kit and what it needs before it, in order. */
export const kitSources = (): readonly [chrome.userScripts.ScriptSource, chrome.userScripts.ScriptSource] => [assets(), KIT]

/**
 * The sources a registration runs, in order. A script that speaks to the kit gets the kit
 * in front of it, so a page that never mounted anything never pays for the kit.
 */
export const sourcesOf = (payload: Payload, pageKey?: string): ReadonlyArray<chrome.userScripts.ScriptSource> => {
  switch (payload.kind) {
    case "design":
      return [{ code: designScript(SHEETS.design, payload.css, SHEETS.palette) }]
    case "style":
      return [{ code: stylesScript(SHEETS.styles, payload.css, true) }]
    case "script": {
      const js = pageKey === undefined ? payload.js : forPage(pageKey, payload.js)
      const ready = { code: readyScript(js, true) }
      return payload.js.includes("__beui") ? [...kitSources(), ready] : [ready]
    }
    case "skin": {
      const js = pageKey === undefined ? payload.js : forPage(pageKey, payload.js)
      return [...kitSources(), { code: readyScript(js, true) }]
    }
    case "declarative": {
      const js = declarativeScript(payload.view)
      return [{ file: "declarative.js" }, { code: readyScript(pageKey === undefined ? js : forPage(pageKey, js), true) }]
    }
    case "sandbox":
      return []
  }
}

/** The registration for a record, by the current build. */
export const scriptOf = (p: Persisted): chrome.userScripts.RegisteredUserScript => ({
  id: p.id,
  matches: [p.matches],
  js: [...sourcesOf(p.payload, pageKeyOf(p.id))],
  // Before the DOM is built, so the page is never seen in its old look (see loader.ts).
  runAt: "document_start",
  world: "MAIN"
})
