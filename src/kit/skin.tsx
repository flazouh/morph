import { createElement, type ComponentType } from "react"
import { flushSync } from "react-dom"
import { createRoot, type Root } from "react-dom/client"
import { HOST_ATTR } from "./host"
import { requireModule } from "./modules"
import type { SkinBody, SkinExtras } from "./skin-script"
import { THEME_ATTR, type ThemeKeeper } from "./theme"

export type { SkinBody }

/**
 * A skin is the page's new shell: one component rendered into a shadow host of its own,
 * standing before the region it replaces. The region is hidden, not removed, so its links
 * and forms stay in the document for the skin to read. One skin per page: a second call
 * re-renders the first host.
 */

interface Loaded {
  readonly component: ComponentType
  readonly target: HTMLElement | null
}

interface Hidden {
  readonly el: HTMLElement
  /** The inline display the element had, put back when the skin lets it go. */
  readonly display: string
  readonly priority: string
}

interface Current {
  readonly host: HTMLElement
  readonly root: Root
  readonly sheet: CSSStyleSheet
  hidden: Hidden | undefined
}

export interface SkinOptions {
  readonly sheet: CSSStyleSheet
  readonly doc: Document
  readonly theme: ThemeKeeper
}

/**
 * The `hidden` attribute is only a user-agent `display: none`, and the author's
 * `display: flex` on a layout container beats it. An inline `!important` beats both.
 */
const hide = (el: HTMLElement): Hidden => {
  const record = { el, display: el.style.getPropertyValue("display"), priority: el.style.getPropertyPriority("display") }
  el.style.setProperty("display", "none", "important")
  return record
}

/**
 * Gives the region back, then tells the page the window resized. A page that sizes the
 * region with script (Gmail's nav) measured it at 0px while it was hidden and wrote that
 * inline; only a resize makes it measure again.
 */
const unhide = ({ el, display, priority }: Hidden): void => {
  if (display === "") el.style.removeProperty("display")
  else el.style.setProperty("display", display, priority)
  el.ownerDocument.defaultView?.dispatchEvent(new Event("resize"))
}

export const createSkin = ({ sheet, doc, theme }: SkinOptions) => {
  let current: Current | undefined

  const load = (body: SkinBody, extras: SkinExtras): Loaded => {
    const exports: Record<string, unknown> = {}
    const mod = { exports: exports as unknown }
    body((id) => requireModule(id, extras), exports, mod)
    // `module.exports = C` makes the component the module itself; `export default C` puts it under `default`.
    const out = mod.exports === exports ? exports : mod.exports
    const component = typeof out === "function" ? out : (out as Record<string, unknown>)["default"]
    if (typeof component !== "function") throw new Error("__beui.skin: the module needs a default export, the component the page renders")
    const selector = typeof out === "function" ? (out as unknown as Record<string, unknown>)["target"] : (out as Record<string, unknown>)["target"]
    const target = typeof selector === "string" ? doc.querySelector<HTMLElement>(selector) : null
    if (typeof selector === "string" && target === null) throw new Error(`__beui.skin: nothing matches target ${JSON.stringify(selector)}`)
    return { component: component as ComponentType, target }
  }

  const hostFor = (): Current => {
    if (current !== undefined) return current
    const host = doc.createElement("div")
    host.setAttribute(HOST_ATTR, "Skin")
    host.style.display = "block"
    const shadow = host.attachShadow({ mode: "open" })
    const own = new CSSStyleSheet()
    // The kit's sheet first, the skin's after: same layers, later sheet, so the skin's rules win.
    shadow.adoptedStyleSheets = [sheet, own]
    current = { host, root: createRoot(shadow), sheet: own, hidden: undefined }
    return current
  }

  /** Renders the skin, with its CSS beside the kit's and its extras in the modules, and hides the target it names. */
  const skin = (body: SkinBody, css: string, extras: SkinExtras = {}): Element => {
    const { component, target } = load(body, extras)
    const record = hostFor()
    record.sheet.replaceSync(css)
    if (record.hidden !== undefined && record.hidden.el !== target) {
      unhide(record.hidden)
      record.hidden = undefined
    }
    if (target === null) doc.body.prepend(record.host)
    else {
      target.before(record.host)
      if (record.hidden === undefined) record.hidden = hide(target)
    }
    record.host.setAttribute(THEME_ATTR, theme.refresh())
    // Committed before this returns: behind the loader's gate, the skin is on the page when the gate comes off.
    flushSync(() => record.root.render(createElement(component)))
    return record.host
  }

  /** Takes the skin off: the host goes, the region it stood in for shows again. */
  const unskin = (): void => {
    if (current === undefined) return
    current.root.unmount()
    current.host.remove()
    if (current.hidden !== undefined) unhide(current.hidden)
    current = undefined
  }

  return { skin, unskin }
}
