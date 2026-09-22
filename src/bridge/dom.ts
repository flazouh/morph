import { TOKENS } from "../kit/tokens"
import type { DesignReport, PageOutline, StyledNode } from "./messages"

/**
 * Turning a live document into something a model can read in one go.
 *
 * The full DOM of a product page is tens of thousands of tokens of noise: SVG paths,
 * script bodies, tracking attributes. The outline keeps what a designer would look at:
 * the tag, an id, a few classes, the role, the text, in reading order, indented by
 * depth. Everything else is dropped, and the drop is said (`truncated`).
 */

const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "LINK", "META", "svg", "SVG", "PATH", "path"])
const KEPT_ATTRS = ["role", "aria-label", "href", "src", "type", "name", "placeholder", "alt", "title"] as const
const TEXT_MAX = 80
const CLASS_MAX = 4
const STYLESHEETS_MAX = 6

const shorten = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

const ownText = (el: Element): string =>
  Array.from(el.childNodes)
    .filter((n) => n.nodeType === 3) // Node.TEXT_NODE, without needing a global Node
    .map((n) => n.textContent ?? "")
    .join(" ")

const isHidden = (el: Element, view: Window): boolean => {
  const style = view.getComputedStyle(el)
  return style.display === "none" || style.visibility === "hidden"
}

const lineOf = (el: Element): string => {
  let line = el.tagName.toLowerCase()
  if (el.id !== "") line += `#${el.id}`
  const classes = Array.from(el.classList).slice(0, CLASS_MAX)
  if (classes.length > 0) line += `.${classes.join(".")}`
  const attrs = KEPT_ATTRS.flatMap((name) => {
    const value = el.getAttribute(name)
    return value === null || value === "" ? [] : [`${name}="${shorten(value, 60)}"`]
  })
  if (attrs.length > 0) line += `[${attrs.join(" ")}]`
  const text = shorten(ownText(el), TEXT_MAX)
  if (text !== "") line += ` "${text}"`
  return line
}

export const outlineOf = (
  root: Element,
  view: Window,
  maxNodes: number
): { readonly outline: string; readonly nodes: number; readonly truncated: boolean } => {
  const lines: Array<string> = []
  let nodes = 0
  let truncated = false
  const walk = (el: Element, depth: number): void => {
    if (truncated) return
    if (SKIP.has(el.tagName)) return
    if (isHidden(el, view)) return
    if (nodes >= maxNodes) {
      truncated = true
      return
    }
    nodes += 1
    lines.push(`${"  ".repeat(depth)}${lineOf(el)}`)
    for (const child of Array.from(el.children)) walk(child, depth + 1)
  }
  walk(root, 0)
  return { outline: lines.join("\n"), nodes, truncated }
}

export const readPage = (doc: Document, view: Window, selector: string | undefined, maxNodes: number): PageOutline => {
  const root = selector === undefined ? doc.body : doc.querySelector(selector)
  if (root === null) throw new Error(`nothing matches "${selector ?? "body"}"`)
  // A product page loads dozens of hashed module sheets; the first few say which design
  // system is in use, and the count says the rest.
  const hrefs = Array.from(doc.styleSheets).flatMap((sheet) => (sheet.href === null ? [] : [sheet.href]))
  const stylesheets = hrefs.length > STYLESHEETS_MAX ? [...hrefs.slice(0, STYLESHEETS_MAX), `… and ${hrefs.length - STYLESHEETS_MAX} more`] : hrefs
  return {
    url: doc.location.href,
    title: doc.title,
    viewport: { width: view.innerWidth, height: view.innerHeight },
    stylesheets,
    ...outlineOf(root, view, maxNodes)
  }
}

/**
 * The properties a redesign decides about. Reading all ~350 computed properties per node
 * is the same cost in tokens as the outline itself, for values nobody will change.
 */
const STYLE_PROPS = [
  "display",
  "position",
  "width",
  "height",
  "padding",
  "margin",
  "gap",
  "color",
  "background-color",
  "border",
  "border-radius",
  "font-family",
  "font-size",
  "font-weight",
  "line-height",
  "box-shadow"
] as const

const selectorFor = (el: Element): string => {
  if (el.id !== "") return `#${el.id}`
  const classes = Array.from(el.classList).slice(0, 2)
  const own = el.tagName.toLowerCase() + (classes.length > 0 ? `.${classes.join(".")}` : "")
  const parent = el.parentElement
  return parent === null || parent.tagName === "BODY" ? own : `${selectorFor(parent)} > ${own}`
}

export const readStyles = (doc: Document, view: Window, selector: string, limit: number): ReadonlyArray<StyledNode> =>
  Array.from(doc.querySelectorAll(selector))
    .slice(0, limit)
    .map((el) => {
      const computed = view.getComputedStyle(el)
      const rect = el.getBoundingClientRect()
      const styles: Record<string, string> = {}
      for (const prop of STYLE_PROPS) styles[prop] = computed.getPropertyValue(prop)
      return {
        selector: selectorFor(el),
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
        styles
      }
    })

export const readText = (doc: Document, selector: string, limit: number): ReadonlyArray<string> =>
  Array.from(doc.querySelectorAll(selector))
    .slice(0, limit)
    .map((el) => shorten(el.textContent ?? "", 400))

/** The beUI tokens as the page resolves them on :root now; empty when the kit is not on the page. */
export const readDesign = (doc: Document, win: Window): DesignReport => {
  const style = win.getComputedStyle(doc.documentElement)
  const tokens: Record<string, string> = {}
  for (const t of TOKENS) {
    const v = style.getPropertyValue(t).trim()
    if (v !== "") tokens[t] = v
  }
  return { theme: doc.documentElement.getAttribute("data-beui-theme"), tokens }
}
