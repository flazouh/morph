/**
 * Standalone page bot overlay. Renders small Morph mascot bots anchored near
 * CSS selector targets in a closed-shadow, fixed, pointer-events:none host
 * that floats above the page without blocking clicks.
 */

import { MASCOT_SHAPES, type MascotShapeName } from "@/brand/mascot-shapes"

// ─── public types ────────────────────────────────────────────────────────────

export type BotStatus = "working" | "waiting" | "done" | "failed" | "stopped"

export interface CrewBotView {
  /** Stable identifier. Used to derive a shape when variant is absent. */
  id: string
  /** CSS selector for the target element this bot anchors to. */
  selector: string
  status: BotStatus
  /** Explicit mascot shape name. Overrides seed-derived selection. */
  variant?: MascotShapeName
  /** Numeric seed for deterministic shape selection when variant is absent. */
  seed?: number
  /** Short label shown beneath the bot (20 characters or fewer is recommended). */
  label?: string
}

// ─── constants ───────────────────────────────────────────────────────────────

const BOT_SIZE = 36

/** Morph brand colours, one per mascot shape. */
const SHAPE_COLORS: Record<MascotShapeName, string> = {
  hex: "#E02988",
  wedge: "#FF9800",
  blob: "#009957",
  squircle: "#804EE0",
}

const SHAPE_NAMES = Object.keys(MASCOT_SHAPES) as MascotShapeName[]

const HOST_CSS =
  "all:initial;box-sizing:border-box;position:fixed;top:0;right:0;bottom:0;left:0;" +
  "pointer-events:none;z-index:2147483646;overflow:visible;"

// ─── shadow CSS ───────────────────────────────────────────────────────────────

const CREW_CSS = `
.morph-bot {
  position: absolute;
  width: ${BOT_SIZE}px;
  height: ${BOT_SIZE}px;
  pointer-events: none;
  flex-direction: column;
  align-items: center;
  transform-origin: 50% 50%;
}
.morph-bot svg {
  width: ${BOT_SIZE}px;
  height: ${BOT_SIZE}px;
  flex: 0 0 ${BOT_SIZE}px;
  display: block;
  overflow: visible;
}
.morph-bot-label {
  font: 600 10px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: #fff;
  background: rgba(0,0,0,.65);
  border-radius: 4px;
  padding: 2px 4px;
  white-space: nowrap;
  margin-top: 2px;
  max-width: 80px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.morph-bot[data-status="failed"] svg { opacity: 0.55; filter: grayscale(0.5); }
.morph-bot[data-status="stopped"] svg { opacity: 0.35; filter: grayscale(1); }
@keyframes morph-working {
  0%,100% { transform: rotate(0deg) scale(1); }
  25% { transform: rotate(-8deg) scale(1.1); }
  75% { transform: rotate(8deg) scale(1.1); }
}
@keyframes morph-waiting {
  0%,100% { opacity: 1; }
  50% { opacity: 0.35; }
}
.morph-bot[data-status="working"] svg {
  animation: morph-working 0.9s ease-in-out infinite;
}
.morph-bot[data-status="waiting"] svg {
  animation: morph-waiting 1.8s ease-in-out infinite;
}
@media (prefers-reduced-motion: reduce) {
  .morph-bot[data-status="working"] svg,
  .morph-bot[data-status="waiting"] svg {
    animation: none;
  }
}
`

// ─── internal state ──────────────────────────────────────────────────────────

interface BotEntry {
  view: CrewBotView
  el: HTMLElement
}

interface CrewState {
  host: HTMLElement
  shadow: ShadowRoot
  bots: BotEntry[]
  hidden: boolean
  cleared: boolean
  win: Window & typeof globalThis
  scrollHandler: EventListener
  resizeHandler: EventListener
  resizeObs: ResizeObserver | null
  mutObs: MutationObserver
  restoreObs: MutationObserver
}

const crews = new WeakMap<Document, CrewState>()

// ─── helpers ─────────────────────────────────────────────────────────────────

function charSum(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) n += s.charCodeAt(i)
  return n
}

function variantFor(view: CrewBotView): MascotShapeName {
  if (view.variant != null && (view.variant as string) in MASCOT_SHAPES) return view.variant
  const n = view.seed ?? charSum(view.id)
  return SHAPE_NAMES[((n % SHAPE_NAMES.length) + SHAPE_NAMES.length) % SHAPE_NAMES.length]!
}

function makeBotSvg(doc: Document, shape: MascotShapeName, color: string): SVGSVGElement {
  const s = MASCOT_SHAPES[shape]
  const [body, ...eyes] = s.d.split(" M")
  const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg")
  svg.setAttribute("viewBox", "-15 -15 259 259")
  svg.setAttribute("aria-hidden", "true")
  svg.setAttribute("overflow", "visible")
  const g = doc.createElementNS("http://www.w3.org/2000/svg", "g")
  g.setAttribute("transform", s.transform)
  const bodyPath = doc.createElementNS("http://www.w3.org/2000/svg", "path")
  bodyPath.setAttribute("d", body ?? "")
  bodyPath.setAttribute("fill", color)
  bodyPath.setAttribute("data-shape", shape)
  g.append(bodyPath)
  const eyeG = doc.createElementNS("http://www.w3.org/2000/svg", "g")
  eyeG.setAttribute("fill", "#111111")
  eyeG.setAttribute("data-stripe-eyes", "true")
  for (const eye of eyes) {
    const p = doc.createElementNS("http://www.w3.org/2000/svg", "path")
    p.setAttribute("d", `M${eye}`)
    eyeG.append(p)
  }
  g.append(eyeG)
  svg.append(g)
  return svg
}

function makeBotEl(doc: Document, view: CrewBotView): HTMLElement {
  const shape = variantFor(view)
  const color = SHAPE_COLORS[shape]
  const div = doc.createElement("div")
  div.className = "morph-bot"
  div.setAttribute("data-status", view.status)
  div.setAttribute("data-bot-id", view.id)
  div.style.display = "none"
  div.append(makeBotSvg(doc, shape, color))
  if (view.label) {
    const span = doc.createElement("span")
    span.className = "morph-bot-label"
    span.textContent = view.label
    div.append(span)
  }
  return div
}

function resolveTarget(doc: Document, selector: string, win: Window): Element | null {
  let el: Element | null
  try {
    el = doc.querySelector(selector)
  } catch {
    return null
  }
  if (!el || !el.isConnected) return null
  const cs = win.getComputedStyle(el)
  if (cs.display === "none") return null
  if (cs.visibility === "hidden") return null
  const rect = el.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return null
  return el
}

function positionBot(botEl: HTMLElement, target: Element, win: Window): void {
  const rect = target.getBoundingClientRect()
  const vw = win.innerWidth
  const vh = win.innerHeight
  // Anchor near the target top-right corner.
  let x = rect.right - BOT_SIZE / 2
  let y = rect.top - BOT_SIZE / 2
  // Clamp to the visible viewport.
  x = Math.max(0, Math.min(x, vw - BOT_SIZE))
  y = Math.max(0, Math.min(y, vh - BOT_SIZE))
  botEl.style.left = `${x}px`
  botEl.style.top = `${y}px`
  botEl.style.display = "flex"
}

function refresh(state: CrewState, doc: Document): void {
  if (state.cleared) return
  // Re-attach host if page code removed it while bots remain.
  if (!state.host.isConnected && state.bots.length > 0) {
    doc.documentElement.append(state.host)
  }
  for (const entry of state.bots) {
    const target = resolveTarget(doc, entry.view.selector, state.win)
    if (target) {
      positionBot(entry.el, target, state.win)
    } else {
      entry.el.style.display = "none"
    }
  }
}

// ─── public API ──────────────────────────────────────────────────────────────

/**
 * Mount or replace the crew bot overlay on the page.
 * An empty views array removes any existing overlay.
 */
export function setCrewBots(
  doc: Document,
  win: Window & typeof globalThis,
  views: readonly CrewBotView[],
): void {
  const hidden = crews.get(doc)?.hidden ?? false
  clearCrewBots(doc)
  if (views.length === 0) return

  const host = doc.createElement("div")
  host.setAttribute("data-morph-crew", "")
  host.style.cssText = HOST_CSS
  host.style.visibility = hidden ? "hidden" : "visible"
  const shadow = host.attachShadow({ mode: "closed" })

  const styleEl = doc.createElement("style")
  styleEl.textContent = CREW_CSS
  shadow.append(styleEl)

  const bots: BotEntry[] = []
  for (const view of views) {
    const el = makeBotEl(doc, view)
    shadow.append(el)
    bots.push({ view, el })
  }

  // Declare state before doRefresh so the closure captures the variable by reference.
  let state!: CrewState
  const doRefresh = (): void => refresh(state, doc)

  let resizeObs: ResizeObserver | null = null
  if (typeof ResizeObserver !== "undefined") {
    resizeObs = new ResizeObserver(doRefresh)
    for (const view of views) {
      try {
        const el = doc.querySelector(view.selector)
        if (el) resizeObs.observe(el)
      } catch { /* invalid selector: skip */ }
    }
  }

  const mutObs = new MutationObserver(doRefresh)
  mutObs.observe(doc.body ?? doc.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["style", "class", "hidden"],
  })

  // Watch for the host being removed from documentElement.
  const restoreObs = new MutationObserver(() => {
    if (!host.isConnected && bots.length > 0) {
      doc.documentElement.append(host)
      doRefresh()
    }
  })
  restoreObs.observe(doc.documentElement, { childList: true })

  doc.addEventListener("scroll", doRefresh, { capture: true, passive: true })
  win.addEventListener("resize", doRefresh)

  state = {
    host,
    shadow,
    bots,
    hidden,
    cleared: false,
    win,
    scrollHandler: doRefresh as EventListener,
    resizeHandler: doRefresh as EventListener,
    resizeObs,
    mutObs,
    restoreObs,
  }

  doc.documentElement.append(host)
  crews.set(doc, state)
  refresh(state, doc)
}

/** Hide or show the overlay without destroying bot state or removing from DOM. */
export function setCrewBotsHidden(doc: Document, hidden: boolean): void {
  const state = crews.get(doc)
  if (!state) return
  state.hidden = hidden
  state.host.style.visibility = hidden ? "hidden" : "visible"
}

/** Remove the overlay and disconnect all observers. */
export function clearCrewBots(doc: Document): void {
  const state = crews.get(doc)
  if (!state) return
  state.cleared = true
  doc.removeEventListener("scroll", state.scrollHandler, { capture: true })
  state.win.removeEventListener("resize", state.resizeHandler)
  state.resizeObs?.disconnect()
  state.mutObs.disconnect()
  state.restoreObs.disconnect()
  state.host.remove()
  crews.delete(doc)
}

/**
 * Return the registered bot views. Includes all views passed to setCrewBots,
 * regardless of whether their targets are currently resolved.
 * Intended for test inspection.
 */
export function crewBotsOf(doc: Document): readonly CrewBotView[] {
  return crews.get(doc)?.bots.map(e => e.view) ?? []
}

/**
 * Internal. Exposes the closed shadow root for test inspection of bot elements.
 * Not part of the public API surface.
 */
export function _crewShadowOf(doc: Document): ShadowRoot | null {
  return crews.get(doc)?.shadow ?? null
}
