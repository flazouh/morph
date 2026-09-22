import type { ReactNode } from "react"
import { flushSync } from "react-dom"
import { createRoot, type Root } from "react-dom/client"
import { catalog, render, type Props } from "./catalog"
import { COMPONENTS, type ComponentName } from "./docs"
import { HOST_ATTR } from "./host"
import { pageWebFetch } from "./web"
import { createSkin } from "./skin"
import { THEME_ATTR, themeKeeper } from "./theme"

export type { SkinBody } from "./skin-script"

/**
 * Mounting beUI components into a page that is not ours. Each mount gets a host element
 * with a shadow root, and the kit's stylesheet is adopted into that root, so the host
 * page's CSS cannot reach the component and the component's utilities cannot reach the
 * page. The tokens stay on the page's :root: custom properties inherit through the
 * shadow boundary, which is how one apply_styles rethemes every component. The page's
 * theme is copied onto each host, so the components' `dark:` rules flip with the palette.
 */

export type Mode = "replace" | "wrap" | "inside" | "append" | "before"

export interface MountOptions {
  readonly mode?: Mode
  readonly children?: string
}

/**
 * Under "wrap" the element becomes the host's light-DOM child and shows through this
 * slot, so the page's CSS keeps styling it while the component draws the surface around it.
 */
const SLOT = <slot />

interface Mounted {
  readonly root: Root
  /** What the component last rendered around; a re-mount without `children` keeps it. */
  children: ReactNode
}

export const createKit = (sheet: CSSStyleSheet, doc: Document = document) => {
  const mounted = new WeakMap<Element, Mounted>()
  /** The host that wraps an element, so the same wrap call twice re-renders instead of nesting. */
  const wrappers = new WeakMap<Element, Element>()
  const theme = themeKeeper(doc)

  const isName = (name: string): name is ComponentName => name in COMPONENTS

  const resolve = (target: Element | string): Element => {
    const el = typeof target === "string" ? doc.querySelector(target) : target
    if (el === null) throw new Error(`__beui: nothing matches ${JSON.stringify(target)}`)
    // A detached element has no place for the host to take; a script that builds its own
    // element must insert it before mounting, or the mount is lost with the element.
    if (!el.isConnected) throw new Error("__beui: the target is not in the document; insert it first, then mount")
    return el
  }

  const hostFor = (target: Element, name: ComponentName, mode: Mode): Element => {
    // A host is reused for the same component: the same call twice re-renders it.
    if (target.hasAttribute(HOST_ATTR)) {
      if (target.getAttribute(HOST_ATTR) !== name) throw new Error(`__beui: ${target.getAttribute(HOST_ATTR)} is mounted here; unmount it before mounting ${name}`)
      return target
    }
    const { tag, display } = catalog[name].box
    const host = doc.createElement(tag)
    host.setAttribute(HOST_ATTR, name)
    host.style.display = display
    switch (mode) {
      case "replace":
        target.replaceWith(host)
        break
      case "wrap":
        target.replaceWith(host)
        host.append(target)
        wrappers.set(target, host)
        break
      case "inside":
        target.replaceChildren(host)
        break
      case "append":
        target.append(host)
        break
      case "before":
        target.before(host)
        break
    }
    return host
  }

  const mount = (target: Element | string, name: string, props: Props = {}, options: MountOptions = {}): Element => {
    if (!isName(name)) throw new Error(`__beui: no component named ${name}; see __beui.list()`)
    const el = resolve(target)
    const mode = options.mode ?? catalog[name].mode ?? "replace"
    const host = hostFor((mode === "wrap" && wrappers.get(el)) || el, name, mode)
    const previous = mounted.get(host)
    const children: ReactNode =
      mode === "wrap" ? SLOT : options.children ?? previous?.children ?? (mode === "replace" ? el.textContent?.trim() ?? "" : "")
    host.setAttribute(THEME_ATTR, theme.refresh())
    let record = previous
    if (record === undefined) {
      const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" })
      shadow.adoptedStyleSheets = [sheet]
      record = { root: createRoot(shadow), children }
      mounted.set(host, record)
    }
    record.children = children
    // Committed before this returns: a script that mounts at DOMContentLoaded, behind the
    // loader's gate, has its components on the page when the gate comes off.
    flushSync(() => record.root.render(render(name, props, children)))
    return host
  }

  /** Removes the component and its host. A wrapped element steps back into the host's place. */
  const unmount = (target: Element | string): void => {
    const host = resolve(target)
    const record = mounted.get(host)
    if (record === undefined) return
    record.root.unmount()
    mounted.delete(host)
    for (const child of Array.from(host.children)) wrappers.delete(child)
    host.replaceWith(...Array.from(host.childNodes))
  }

  const list = (): ReadonlyArray<ComponentName> => Object.keys(COMPONENTS) as Array<ComponentName>

  const skins = createSkin({ sheet, doc, theme })
  // The web, through the extension: the page's own fetch is bound by its origin, the worker's is not.
  const fetch = pageWebFetch(doc.defaultView ?? window)

  return { mount, unmount, list, skin: skins.skin, unskin: skins.unskin, fetch }
}

export type Kit = ReturnType<typeof createKit>
