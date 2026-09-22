/**
 * The chat as a card on the page the reader is redesigning. The panel still lives in an
 * extension document (an iframe of panel.html). The page only holds a host, in a
 * closed shadow, so the agent's styles and scripts cannot reach the React tree.
 */

import {
  isPanelAction,
  isPanelToHostInspectorAck,
  isPanelToHostInspectorMessage,
  type OverlayAsk,
  type PanelAction
} from "./messages"
import { randomToken } from "@/lib/random-token"
import { chromePanelAttestation, type PanelAttestation } from "./panel-attest"
import { frameOrigin, mintPanelNonce, panelSrcWithNonce } from "./panel-session"
import { CHAT_GEOMETRY, CHAT_LAYOUT } from "./layout"
import { applyRect, moveRect, resizeRect, resolveDisplayRect, type ChatRect, type ResizeBounds, type ResizeCorner, type ResizeDelta } from "./resize"
import { reduceChatWindow, type ChatMode } from "./window-state"
import { MORPH_LOGO, MORPH_LOGO_VIEWBOX } from "@/brand/morph"
import { MASCOT_SHAPES } from "@/brand/mascot-shapes"
import {
  createInspectorController,
  loadInitialHistory,
  type CopyPromptStart,
  type HandoffResult,
  type InspectorController,
  type InspectorSend,
  type InspectorWindow
} from "@/inspector/controller"
import type { ChangeHistory } from "@/inspector/model"

export type { ChatMode } from "./window-state"

export interface ChatState {
  readonly open: boolean
  readonly hidden: boolean
  readonly mode: ChatMode
  readonly src: string | null
}

type ResizableMode = Exclude<ChatMode, "minimized">

/**
 * A card's frame is unloaded until the worker registers this card's nonce, so a hand-off
 * has somewhere to go only in `"open"`. `"failed"` is the one state that shows the notice.
 */
type PanelSessionState = "opening" | "open" | "failed"

interface Mounted {
  host: HTMLElement
  shadow: ShadowRoot
  iframe: HTMLIFrameElement
  widget: HTMLButtonElement
  resizeHandles: ReadonlyArray<HTMLButtonElement>
  grabHandle: HTMLButtonElement
  resizeShield: HTMLDivElement
  hidden: boolean
  mode: ChatMode
  restoreMode: Exclude<ChatMode, "minimized">
  /** The settings workspace widens the normal card in place. */
  wide: boolean
  placements: Partial<Record<ResizableMode, ChatRect>>
  dragging: boolean
  headerHovered: boolean
  /** Base panel URL without the session nonce. */
  baseSrc: string
  /** Secret shared only with this card's iframe through its URL hash. */
  panelNonce: string
  /** Extension origin used as postMessage targetOrigin for hand-offs; `null` for a `baseSrc` that is not a URL. */
  panelOrigin: string | null
  src: string
  /** How this card proves its session to the worker. Carried to a replacement card. */
  attestation: PanelAttestation
  /** Covers the card when the worker would not open a panel session, with a retry. */
  notice: HTMLElement
  /** The frame is only loaded, and only reachable by a hand-off, while this is `"open"`. */
  panel: PanelSessionState
  observer: MutationObserver
  onMessage: (event: MessageEvent) => void
  onClose: () => void
  stopDragging: () => void
  /** Inspect mode: kept outside `ChatMode` so entering and leaving never touches chat geometry directly. */
  inspecting: boolean
  /** True when this card exists only to host the inspector; exit removes it instead of restoring chat geometry. */
  createdForInspector: boolean
  inspector: InspectorController | undefined
  inspectorHistory: ChangeHistory | undefined
  /** Whether the chat was already minimized before inspecting started, so exiting leaves it minimized instead of forcing it back open. */
  wasMinimizedBeforeInspecting: boolean
  /** Hand-offs this card's iframe has not yet acknowledged. Resets with the card: a
   * replacement starts with none, after the old card's own entries are rejected. */
  pending: Map<string, PendingHandoff>
}

interface PendingHandoff {
  readonly resolve: (result: HandoffResult) => void
  readonly timer: ReturnType<typeof setTimeout>
}

const cards = new WeakMap<Document, Mounted>()

/**
 * The inspector send port and the hotkey's own teardown, kept per document instead of on
 * `Mounted`: both outlive any one card. The hotkey works with no chat open at all, and the
 * port must survive a card replace so a resurrected card can still answer `toggleInspector`.
 */
interface DocumentInspectorState {
  send: InspectorSend
  hotkeyCleanup: (() => void) | null
}

const inspectorState = new WeakMap<Document, DocumentInspectorState>()

const setInspectorSend = (doc: Document, send: InspectorSend): void => {
  const existing = inspectorState.get(doc)
  if (existing !== undefined) existing.send = send
  else inspectorState.set(doc, { send, hotkeyCleanup: null })
}

const inspectorSendOf = (doc: Document): InspectorSend | undefined => inspectorState.get(doc)?.send

/**
 * The one dependency a card cannot get for itself: how this document proves to the
 * service worker that Morph, and not the page, created a panel session. The
 * `chrome.runtime` round trip in the extension, another port in a test.
 */
export interface HostOptions {
  readonly attestation?: PanelAttestation
}

/** A port call as a promise, whatever the port does: a synchronous throw is a rejection too. */
const attempt = (run: () => Promise<void>): Promise<void> => {
  try {
    return run()
  } catch (error) {
    return Promise.reject(error)
  }
}

const rejectPendingHandoffs = (card: Mounted, message: string): void => {
  for (const [requestId, entry] of card.pending) {
    clearTimeout(entry.timer)
    entry.resolve({ ok: false, message })
    card.pending.delete(requestId)
  }
}

const HOST_STYLE =
  "all:initial;box-sizing:border-box;display:block;position:fixed;z-index:2147483647;overflow:hidden;pointer-events:none;transition:width 260ms cubic-bezier(0.22,1,0.36,1),border-radius 260ms ease;"

const FRAME_STYLE =
  "all:initial;display:block;box-sizing:border-box;width:100%;height:100%;border:0;border-radius:16px;pointer-events:auto;background:transparent;"

const RESIZE_HANDLE_STYLE =
  "all:initial;box-sizing:border-box;display:block;position:absolute;width:18px;height:18px;z-index:2;pointer-events:auto;border-color:rgba(255,255,255,.48);border-style:solid;"

const RESIZE_SHIELD_STYLE =
  "all:initial;display:none;position:fixed;inset:-100vmax;z-index:1;pointer-events:auto;"

const NOTICE_STYLE =
  "all:initial;box-sizing:border-box;display:none;flex-direction:column;align-items:flex-start;justify-content:center;gap:12px;position:absolute;inset:0;z-index:3;padding:20px;border:1px solid rgba(255,255,255,.12);border-radius:16px;background:#151515;color:#f5f5f5;pointer-events:auto;font:400 13px/1.5 -apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;-webkit-font-smoothing:antialiased;"

const NOTICE_TEXT_STYLE = "all:initial;color:inherit;font:inherit;"

const NOTICE_RETRY_STYLE =
  "all:initial;box-sizing:border-box;display:inline-block;padding:6px 12px;border:1px solid rgba(255,255,255,.24);border-radius:8px;background:transparent;color:#f5f5f5;cursor:pointer;font:600 12px/1 -apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;"

const GRAB_HANDLE_STYLE =
  "all:initial;box-sizing:border-box;display:none;position:absolute;left:50%;top:10px;width:28px;height:20px;z-index:2;transform:translateX(-50%);align-items:center;justify-content:center;border:0;border-radius:6px;background:transparent;color:rgba(255,255,255,.62);cursor:grab;opacity:0;pointer-events:none;transition:opacity 120ms ease,background-color 120ms ease;"

const RESIZE_HANDLE_LAYOUT: Record<ResizeCorner, string> = {
  "north-west": "left:-6px;top:-6px;cursor:nwse-resize;border-width:2px 0 0 2px;border-radius:8px 0 0;",
  "north-east": "right:-6px;top:-6px;cursor:nesw-resize;border-width:2px 2px 0 0;border-radius:0 8px 0 0;",
  "south-west": "left:-6px;bottom:-6px;cursor:nesw-resize;border-width:0 0 2px 2px;border-radius:0 0 0 8px;",
  "south-east": "right:-6px;bottom:-6px;cursor:nwse-resize;border-width:0 2px 2px 0;border-radius:0 0 8px;"
}

const RESIZE_CORNERS = ["north-west", "north-east", "south-west", "south-east"] as const

const WIDGET_CLASS = "redesign-chat-widget"
const WIDGET_CSS = `
  .${WIDGET_CLASS} {
    all: initial;
    box-sizing: border-box;
    display: none;
    width: ${CHAT_GEOMETRY.minimized.width}px;
    height: ${CHAT_GEOMETRY.minimized.height}px;
    align-items: center;
    justify-content: flex-start;
    gap: 8px;
    padding: 0 12px 0 8px;
    border: 1px solid rgba(255, 255, 255, .12);
    border-radius: ${CHAT_GEOMETRY.minimized.radius}px;
    background: #151515;
    box-shadow: 0 14px 38px rgba(0, 0, 0, .28);
    color: #f5f5f5;
    cursor: pointer;
    pointer-events: auto;
    font: 600 13px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    -webkit-font-smoothing: antialiased;
    transition: background-color 150ms ease, box-shadow 150ms ease;
  }
  .${WIDGET_CLASS}:hover {
    background: #242424;
    box-shadow: 0 16px 42px rgba(0, 0, 0, .34);
  }
  .${WIDGET_CLASS}:focus-visible {
    outline: 2px solid #f5f5f5;
    outline-offset: 2px;
  }
`

const widgetMark = (doc: Document): SVGSVGElement => {
  const node = doc.createElementNS("http://www.w3.org/2000/svg", "svg")
  node.setAttribute("viewBox", MORPH_LOGO_VIEWBOX)
  node.setAttribute("aria-hidden", "true")
  node.style.cssText = "all:initial;display:block;width:29px;height:22px;flex:0 0 29px;"
  for (const mascot of MORPH_LOGO) {
    const shape = MASCOT_SHAPES[mascot.name]
    const [body, ...eyes] = shape.d.split(" M")
    const figure = doc.createElementNS("http://www.w3.org/2000/svg", "svg")
    figure.setAttribute("x", String(mascot.x))
    figure.setAttribute("y", String(mascot.y))
    figure.setAttribute("width", String(mascot.size))
    figure.setAttribute("height", String(mascot.size))
    figure.setAttribute("viewBox", "-15 -15 259 259")
    figure.setAttribute("overflow", "visible")
    const group = doc.createElementNS("http://www.w3.org/2000/svg", "g")
    group.setAttribute("transform", shape.transform)
    const bodyPath = doc.createElementNS("http://www.w3.org/2000/svg", "path")
    bodyPath.setAttribute("d", body ?? "")
    bodyPath.setAttribute("fill", mascot.color)
    bodyPath.setAttribute("data-shape", mascot.name)
    group.append(bodyPath)
    const eyeGroup = doc.createElementNS("http://www.w3.org/2000/svg", "g")
    eyeGroup.setAttribute("fill", "#111111")
    eyeGroup.setAttribute("data-stripe-eyes", "true")
    for (const eye of eyes) {
      const eyePath = doc.createElementNS("http://www.w3.org/2000/svg", "path")
      eyePath.setAttribute("d", `M${eye}`)
      eyeGroup.append(eyePath)
    }
    group.append(eyeGroup)
    figure.append(group)
    node.append(figure)
  }
  return node
}

const grabMark = (doc: Document): SVGSVGElement => {
  const icon = doc.createElementNS("http://www.w3.org/2000/svg", "svg")
  icon.setAttribute("viewBox", "0 0 18 12")
  icon.setAttribute("aria-hidden", "true")
  icon.style.cssText = "all:initial;display:block;width:18px;height:12px;color:inherit;cursor:inherit;pointer-events:none;"
  for (const x of [4, 9, 14]) {
    for (const y of [3.5, 8.5]) {
      const dot = doc.createElementNS("http://www.w3.org/2000/svg", "circle")
      dot.setAttribute("cx", String(x))
      dot.setAttribute("cy", String(y))
      dot.setAttribute("r", "1.25")
      dot.setAttribute("fill", "currentColor")
      icon.append(dot)
    }
  }
  return icon
}

/**
 * Registers this card's nonce with the worker and only then lets the frame load. A page
 * can frame `panel.html` with a nonce of its own choosing, so the nonce alone proves
 * nothing: the panel checks with the worker that the nonce it reads was registered for
 * its tab, and a registration this function never made can never answer yes.
 *
 * A refusal leaves the card mounted and unloaded, with a retry, instead of failing
 * silently or leaving a rejection nobody handled.
 */
const openPanelSession = (card: Mounted): void => {
  setPanelState(card, "opening")
  void attempt(() => card.attestation.register(card.panelNonce)).then(
    () => {
      if (!card.host.isConnected) return
      if (card.panel !== "open") card.iframe.src = card.src
      setPanelState(card, "open")
    },
    () => {
      if (!card.host.isConnected) return
      setPanelState(card, "failed")
    }
  )
}

const setPanelState = (card: Mounted, state: PanelSessionState): void => {
  card.panel = state
  drawMode(card, false)
}

/**
 * Only for a card that is going away for good. A card replaced in place keeps its nonce
 * and registers it again, and that one write is the atomic replacement: a revoke here
 * would end the session the replacement just opened.
 */
const closePanelSession = (card: Mounted): void => {
  void attempt(() => card.attestation.revoke(card.panelNonce)).catch(() => {})
}

const live = (doc: Document): Mounted | undefined => {
  const card = cards.get(doc)
  if (card === undefined || !card.host.isConnected) return undefined
  return card
}

export const chatOf = (doc: Document): ChatState => {
  const card = live(doc)
  return card === undefined
    ? { open: false, hidden: false, mode: "normal", src: null }
    : { open: true, hidden: card.hidden, mode: card.mode, src: card.iframe.src || card.src }
}

const drawMode = (card: Mounted, animateLayout = true): void => {
  card.host.style.cssText = HOST_STYLE
  if (card.dragging || !animateLayout) card.host.style.transition = "none"
  Object.assign(card.host.style, CHAT_LAYOUT[card.mode])
  const rawPlacement = card.mode === "minimized" ? undefined : card.placements[card.mode]
  // The settings workspace widens the normal card in place; the wider expanded card
  // and the minimized widget keep their own width. resolveDisplayRect is the one
  // canonical path for this adjustment so move and stop always agree.
  const placement =
    rawPlacement !== undefined && card.wide && card.mode === "normal"
      ? resolveDisplayRect(rawPlacement, CHAT_GEOMETRY.settings.width, CHAT_GEOMETRY.inset)
      : rawPlacement
  if (placement !== undefined) {
    applyRect(card.host, placement)
    card.host.style.maxHeight = `calc(100vh - ${CHAT_GEOMETRY.expanded.viewportMargin}px)`
  } else if (card.wide && card.mode === "normal") {
    // No manual placement yet; the CSS anchor (right: 24px) is already set by
    // Object.assign above, so only the width needs to be overridden.
    card.host.style.width = `${CHAT_GEOMETRY.settings.width}px`
  }
  if (card.mode === "minimized") {
    card.iframe.style.display = "none"
    card.widget.style.display = "flex"
    card.notice.style.display = "none"
    for (const handle of card.resizeHandles) handle.style.display = "none"
    card.grabHandle.style.display = "none"
    card.host.style.visibility = card.hidden ? "hidden" : "visible"
    return
  }
  card.notice.style.display = card.panel === "failed" ? "flex" : "none"
  card.iframe.style.display = "block"
  card.widget.style.display = "none"
  for (const handle of card.resizeHandles) handle.style.display = "block"
  card.grabHandle.style.display = "flex"
  const showGrabHandle = card.headerHovered || card.dragging
  card.grabHandle.style.opacity = showGrabHandle ? "1" : "0"
  card.grabHandle.style.pointerEvents = showGrabHandle ? "auto" : "none"
  card.host.style.overflow = "visible"
  card.host.style.visibility = card.hidden ? "hidden" : "visible"
}

const resizeBounds = (doc: Document): ResizeBounds => ({
  left: CHAT_GEOMETRY.inset,
  top: CHAT_GEOMETRY.inset,
  right: (doc.defaultView?.innerWidth ?? 1024) - CHAT_GEOMETRY.inset,
  bottom: (doc.defaultView?.innerHeight ?? 768) - CHAT_GEOMETRY.inset,
  minWidth: CHAT_GEOMETRY.normal.minWidth,
  minHeight: CHAT_GEOMETRY.normal.minHeight
})

const arrowDelta = (key: string): ResizeDelta | undefined =>
  key === "ArrowLeft" ? { x: -16, y: 0 }
  : key === "ArrowRight" ? { x: 16, y: 0 }
  : key === "ArrowUp" ? { x: 0, y: -16 }
  : key === "ArrowDown" ? { x: 0, y: 16 }
  : undefined

const actOnWindow = (card: Mounted, action: Parameters<typeof reduceChatWindow>[1]): void => {
  card.stopDragging()
  const next = reduceChatWindow(card, action)
  card.mode = next.mode
  card.restoreMode = next.restoreMode
  drawMode(card)
}

/**
 * Every field a replacement path (host resurrection, a reload) must carry from the card it
 * replaces. One object, so a new field on `Mounted` that a replace should keep only needs
 * adding here and in `carryOf`, not at every positional call site that could forget it.
 */
interface AttachOptions extends HostOptions {
  readonly baseSrc: string
  readonly hidden?: boolean
  readonly mode?: ChatMode
  readonly restoreMode?: Exclude<ChatMode, "minimized">
  readonly onClose?: () => void
  readonly wide?: boolean
  readonly placements?: Partial<Record<ResizableMode, ChatRect>>
  readonly panelNonce?: string
}

/** The options a replacement `attach()` needs to keep the card it is replacing unchanged. */
const carryOf = (card: Mounted): AttachOptions => ({
  baseSrc: card.baseSrc,
  hidden: card.hidden,
  mode: card.mode,
  restoreMode: card.restoreMode,
  onClose: card.onClose,
  wide: card.wide,
  placements: card.placements,
  panelNonce: card.panelNonce,
  attestation: card.attestation
})

const attach = (doc: Document, options: AttachOptions): Mounted => {
  const {
    baseSrc,
    hidden = false,
    mode = "normal",
    restoreMode = "normal",
    onClose = () => {},
    wide = false,
    placements = {},
    panelNonce = mintPanelNonce(),
    attestation = chromePanelAttestation()
  } = options
  const host = doc.createElement("div")
  const shadow = host.attachShadow({ mode: "closed" })
  const iframe = doc.createElement("iframe")
  const src = panelSrcWithNonce(baseSrc, panelNonce)
  const panelOrigin = frameOrigin(src)
  // No `src` yet. The frame navigates in `openPanelSession`, once the worker holds this
  // card's nonce, so a panel document only ever exists for an attested session.
  iframe.style.cssText = FRAME_STYLE
  iframe.setAttribute("title", "Morph")
  const widget = doc.createElement("button")
  widget.type = "button"
  widget.title = "Open Morph"
  widget.setAttribute("aria-label", "Open Morph")
  widget.className = WIDGET_CLASS
  const label = doc.createElement("span")
  label.textContent = "Morph"
  label.style.cssText = "all:initial;color:inherit;font:inherit;white-space:nowrap;"
  widget.append(widgetMark(doc), label)
  const widgetStyle = doc.createElement("style")
  widgetStyle.textContent = WIDGET_CSS
  const resizeControls = RESIZE_CORNERS.map((corner) => {
    const handle = doc.createElement("button")
    handle.type = "button"
    handle.title = `Resize Morph from the ${corner} corner`
    handle.setAttribute("aria-label", handle.title)
    handle.dataset.corner = corner
    handle.style.cssText = `${RESIZE_HANDLE_STYLE}${RESIZE_HANDLE_LAYOUT[corner]}`
    return { corner, handle }
  })
  const resizeHandles = resizeControls.map(({ handle }) => handle)
  const grabHandle = doc.createElement("button")
  grabHandle.type = "button"
  grabHandle.title = "Move Morph"
  grabHandle.setAttribute("aria-label", "Move Morph")
  grabHandle.style.cssText = GRAB_HANDLE_STYLE
  grabHandle.append(grabMark(doc))
  const resizeShield = doc.createElement("div")
  resizeShield.dataset.morphResizeShield = ""
  resizeShield.style.cssText = RESIZE_SHIELD_STYLE
  const notice = doc.createElement("div")
  notice.dataset.morphPanelNotice = ""
  notice.setAttribute("role", "alert")
  notice.style.cssText = NOTICE_STYLE
  const noticeText = doc.createElement("span")
  noticeText.style.cssText = NOTICE_TEXT_STYLE
  noticeText.textContent =
    "Morph could not open a secure panel session for this tab. Your changes are still on the page."
  const noticeRetry = doc.createElement("button")
  noticeRetry.type = "button"
  noticeRetry.textContent = "Try again"
  noticeRetry.style.cssText = NOTICE_RETRY_STYLE
  notice.append(noticeText, noticeRetry)
  shadow.append(widgetStyle, iframe, notice, widget, resizeShield, grabHandle, ...resizeHandles)
  doc.documentElement.append(host)

  const onMessage = (event: MessageEvent) => {
    const card = live(doc)
    if (card === undefined || event.source !== card.iframe.contentWindow) return
    if (isPanelAction(event.data)) {
      applyPanelAction(doc, event.data)
      return
    }
    if (isPanelToHostInspectorAck(event.data)) {
      const pending = card.pending.get(event.data.requestId)
      if (pending === undefined) return
      clearTimeout(pending.timer)
      card.pending.delete(event.data.requestId)
      pending.resolve({ ok: true })
      return
    }
    if (isPanelToHostInspectorMessage(event.data)) {
      const send = inspectorSendOf(doc)
      if (send !== undefined) void toggleInspector(doc, card.baseSrc, send)
    }
  }
  const card: Mounted = {
    host,
    shadow,
    iframe,
    widget,
    resizeHandles,
    grabHandle,
    resizeShield,
    hidden,
    mode,
    restoreMode,
    wide,
    placements,
    dragging: false,
    headerHovered: false,
    baseSrc,
    panelNonce,
    panelOrigin,
    src,
    attestation,
    notice,
    panel: "opening",
    observer: new MutationObserver(() => {}),
    onMessage,
    onClose,
    stopDragging: () => {},
    inspecting: false,
    createdForInspector: false,
    inspector: undefined,
    inspectorHistory: undefined,
    wasMinimizedBeforeInspecting: false,
    pending: new Map()
  }
  const beginDrag = (
    event: PointerEvent,
    cursor: string,
    place: (start: ChatRect, delta: ResizeDelta) => ChatRect
  ) => {
    if (event.button !== 0 || card.mode === "minimized") return
    event.preventDefault()
    card.stopDragging()
    card.dragging = true
    card.host.style.transition = "none"
    card.host.style.willChange = "left, top, width, height"
    card.resizeShield.style.display = "block"
    card.resizeShield.style.cursor = cursor
    const startX = event.clientX
    const startY = event.clientY
    const mode = card.mode
    const rect = card.host.getBoundingClientRect()
    const start: ChatRect = { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
    applyRect(card.host, start)
    card.host.style.maxHeight = `calc(100vh - ${CHAT_GEOMETRY.expanded.viewportMargin}px)`
    const move = (next: PointerEvent) => {
      const placement = place(start, { x: next.clientX - startX, y: next.clientY - startY })
      card.placements[mode] = placement
      // Use the same canonical wide-mode path as drawMode so the card never
      // snaps on pointerup.
      const display =
        card.wide && mode === "normal"
          ? resolveDisplayRect(placement, CHAT_GEOMETRY.settings.width, CHAT_GEOMETRY.inset)
          : placement
      applyRect(card.host, display)
    }
    const stop = () => {
      card.resizeShield.removeEventListener("pointermove", move)
      doc.defaultView?.removeEventListener("pointerup", stop)
      doc.defaultView?.removeEventListener("pointercancel", stop)
      doc.defaultView?.removeEventListener("blur", stop)
      card.resizeShield.style.display = "none"
      card.grabHandle.style.cursor = "grab"
      card.dragging = false
      card.stopDragging = () => {}
      drawMode(card)
    }
    card.stopDragging = stop
    card.resizeShield.addEventListener("pointermove", move)
    doc.defaultView?.addEventListener("pointerup", stop)
    doc.defaultView?.addEventListener("pointercancel", stop)
    doc.defaultView?.addEventListener("blur", stop)
  }
  for (const { corner, handle: resizeHandle } of resizeControls) {
    resizeHandle.addEventListener("keydown", (event) => {
      const delta = arrowDelta(event.key)
      if (delta === undefined || card.mode === "minimized") return
      event.preventDefault()
      const rect = card.host.getBoundingClientRect()
      card.placements[card.mode] = resizeRect(
        { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        delta,
        corner,
        resizeBounds(doc)
      )
      drawMode(card)
    })
    resizeHandle.addEventListener("pointerdown", (event) => {
      beginDrag(event, resizeHandle.style.cursor, (start, delta) =>
        resizeRect(start, delta, corner, resizeBounds(doc))
      )
    })
  }
  grabHandle.addEventListener("keydown", (event) => {
    const delta = arrowDelta(event.key)
    if (delta === undefined || card.mode === "minimized") return
    event.preventDefault()
    const rect = card.host.getBoundingClientRect()
    card.placements[card.mode] = moveRect(
      { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      delta,
      resizeBounds(doc)
    )
    drawMode(card)
  })
  grabHandle.addEventListener("pointerdown", (event) => {
    if (event.button === 0 && card.mode !== "minimized") grabHandle.style.cursor = "grabbing"
    beginDrag(event, "grabbing", (start, delta) => moveRect(start, delta, resizeBounds(doc)))
  })
  grabHandle.addEventListener("pointerenter", () => {
    card.headerHovered = true
    drawMode(card)
  })
  grabHandle.addEventListener("pointerleave", () => {
    if (card.dragging) return
    card.headerHovered = false
    drawMode(card)
  })
  widget.addEventListener("click", () => restoreChat(doc))
  noticeRetry.addEventListener("click", () => openPanelSession(card))
  doc.defaultView?.addEventListener("message", onMessage)
  drawMode(card)
  openPanelSession(card)

  // The agent writes MAIN-world JS. It can remove this host. The card is wanted
  // until the reader toggles it off, so a stripped host is put back once.
  const observer = new MutationObserver(() => {
    const current = cards.get(doc)
    if (current === undefined || current.host.isConnected) return
    rejectPendingHandoffs(current, "Morph panel replaced before the hand-off was accepted.")
    current.observer.disconnect()
    current.stopDragging()
    current.inspector?.destroy()
    doc.defaultView?.removeEventListener("message", current.onMessage)
    cards.set(doc, attach(doc, carryOf(current)))
  })
  card.observer = observer
  observer.observe(doc.documentElement, { childList: true })
  return card
}

export const unmountChat = (doc: Document): void => {
  const card = cards.get(doc)
  if (card === undefined) return
  closePanelSession(card)
  rejectPendingHandoffs(card, "Morph panel closed before the hand-off was accepted.")
  card.observer.disconnect()
  card.stopDragging()
  card.inspector?.destroy()
  doc.defaultView?.removeEventListener("message", card.onMessage)
  cards.delete(doc)
  card.host.remove()
}

export const reloadChat = (doc: Document): void => {
  const card = live(doc)
  if (card === undefined) return
  rejectPendingHandoffs(card, "Morph panel reloaded before the hand-off was accepted.")
  card.observer.disconnect()
  card.stopDragging()
  card.inspector?.destroy()
  doc.defaultView?.removeEventListener("message", card.onMessage)
  card.host.remove()
  cards.set(doc, attach(doc, carryOf(card)))
}

export const openChat = (
  doc: Document,
  src: string,
  onClose: () => void = () => {},
  options: HostOptions = {}
): void => {
  if (live(doc) !== undefined) return
  cards.set(doc, attach(doc, { ...options, baseSrc: src, onClose }))
}

export const toggleChat = (
  doc: Document,
  src: string,
  onClose: () => void = () => {},
  options: HostOptions = {}
): "open" | "closed" => {
  const open = live(doc)
  if (open !== undefined) {
    open.onClose()
    unmountChat(doc)
    return "closed"
  }
  openChat(doc, src, onClose, options)
  return "open"
}

export const setChatHidden = (doc: Document, hidden: boolean): void => {
  const card = live(doc)
  if (card === undefined) return
  card.hidden = hidden
  card.host.style.visibility = hidden ? "hidden" : "visible"
}

export const restoreChat = (doc: Document): void => {
  const card = live(doc)
  if (card === undefined) return
  actOnWindow(card, { type: "restoreChat" })
}

const viewOf = (doc: Document): InspectorWindow =>
  (doc.defaultView ?? (globalThis as unknown as Window)) as InspectorWindow

export interface InspectorState {
  readonly inspecting: boolean
}

export interface HandoffOptions {
  /** How long a hand-off waits for the panel's acknowledgement before it fails. */
  readonly ackTimeoutMs?: number
}

const DEFAULT_HANDOFF_ACK_TIMEOUT_MS = 3_000

/** Sends a hand-off prompt to the card iframe that owns this page session and waits for its ack. */
export const sendInspectorHandoff = (
  doc: Document,
  prompt: string,
  options: HandoffOptions = {}
): Promise<HandoffResult> => {
  const card = live(doc)
  if (card === undefined) {
    return Promise.resolve({ ok: false, message: "Morph is not open on this page." })
  }
  if (card.panel !== "open") {
    return Promise.resolve({
      ok: false,
      message: "Morph is still opening its panel. Try again in a moment."
    })
  }
  const contentWindow = card.iframe.contentWindow
  const targetOrigin = card.panelOrigin
  if (contentWindow === null || targetOrigin === null) {
    return Promise.resolve({ ok: false, message: "Morph panel frame is not available." })
  }

  const ackTimeoutMs = options.ackTimeoutMs ?? DEFAULT_HANDOFF_ACK_TIMEOUT_MS
  const requestId = randomToken()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      card.pending.delete(requestId)
      resolve({
        ok: false,
        message:
          "Morph did not confirm the hand-off in time. It may still appear in chat. Check Morph before you send again."
      })
    }, ackTimeoutMs)

    card.pending.set(requestId, { resolve, timer })
    contentWindow.postMessage(
      { type: "inspectorHandoff", requestId, nonce: card.panelNonce, prompt },
      targetOrigin
    )
  })
}

const beginCopyPrompt = (prompt: string): CopyPromptStart => {
  if (typeof navigator.clipboard?.writeText !== "function") {
    return {
      ok: false,
      message: "Clipboard unavailable. Select Copy prompt again or copy the text manually from the change list."
    }
  }
  return { ok: true, pending: navigator.clipboard.writeText(prompt) }
}

const exitInspecting = (doc: Document, card: Mounted): void => {
  if (!card.inspecting) return
  card.inspecting = false
  card.inspector?.destroy()
  card.inspector = undefined
  if (card.createdForInspector) {
    unmountChat(doc)
    return
  }
  // Leave it minimized if that is how the reader had it before inspecting started.
  if (!card.wasMinimizedBeforeInspecting) actOnWindow(card, { type: "restoreChat" })
}

const enterInspecting = async (doc: Document, card: Mounted, send: InspectorSend): Promise<void> => {
  card.wasMinimizedBeforeInspecting = card.mode === "minimized"
  if (!card.wasMinimizedBeforeInspecting) actOnWindow(card, { type: "minimizeChat" })
  card.inspecting = true
  if (card.inspectorHistory === undefined) {
    card.inspectorHistory = await loadInitialHistory(doc, send)
  }
  // Escape or a second hotkey press can race this await; only mount if inspecting is still wanted.
  if (live(doc) !== card || !card.inspecting) return
  card.inspector = createInspectorController(doc, viewOf(doc), card.inspectorHistory, {
    send,
    onExit: () => exitInspecting(doc, card),
    onHistoryChange: (history) => {
      card.inspectorHistory = history
    },
    beginCopyPrompt,
    sendToMorph: (prompt) => sendInspectorHandoff(doc, prompt)
  })
  card.shadow.append(card.inspector.root)
}

/** Enter or leave inspect mode on the page's card, creating one first when the reader never opened chat. */
export const toggleInspector = (
  doc: Document,
  src: string,
  send: InspectorSend,
  options: HostOptions = {}
): Promise<void> => {
  setInspectorSend(doc, send)
  const existing = live(doc)
  const card = existing ?? attach(doc, { ...options, baseSrc: src })
  if (existing === undefined) {
    card.createdForInspector = true
    cards.set(doc, card)
  }
  if (card.inspecting) {
    exitInspecting(doc, card)
    return Promise.resolve()
  }
  return enterInspecting(doc, card, send)
}

const isEditableTarget = (event: KeyboardEvent): boolean => {
  const origin = event.composedPath()[0]
  if (!(origin instanceof Element)) return false
  return (
    origin instanceof HTMLInputElement ||
    origin instanceof HTMLTextAreaElement ||
    origin instanceof HTMLSelectElement ||
    (origin instanceof HTMLElement && origin.isContentEditable)
  )
}

/** `Alt+Shift+I` toggles inspect mode from anywhere on the page. Installed once per document; independent of the chat card's lifecycle. */
export const installInspectorHotkey = (
  doc: Document,
  src: string,
  send: InspectorSend,
  options: HostOptions = {}
): (() => void) => {
  setInspectorSend(doc, send)
  const state = inspectorState.get(doc)!
  if (state.hotkeyCleanup !== null) return state.hotkeyCleanup
  const onKeydown = (event: KeyboardEvent): void => {
    if (!event.altKey || !event.shiftKey || event.key.toLowerCase() !== "i") return
    if (isEditableTarget(event)) return
    event.preventDefault()
    void toggleInspector(doc, src, send, options)
  }
  doc.addEventListener("keydown", onKeydown)
  const cleanup = (): void => {
    doc.removeEventListener("keydown", onKeydown)
    state.hotkeyCleanup = null
  }
  state.hotkeyCleanup = cleanup
  return cleanup
}

export const applyPanelAction = (doc: Document, action: PanelAction): void => {
  const card = live(doc)
  if (card === undefined) return
  if (action.type === "reloadChat") {
    reloadChat(doc)
    return
  }
  if (action.type === "closeChat") {
    card.onClose()
    unmountChat(doc)
    return
  }
  if (action.type === "setChatWide") {
    card.wide = action.wide
    drawMode(card, !action.wide)
    return
  }
  if (action.type === "setChatHeaderHovered") {
    card.headerHovered = action.hovered || card.grabHandle.matches(":hover")
    drawMode(card)
    return
  }
  if (action.type === "minimizeChat") {
    actOnWindow(card, action)
    return
  }
  actOnWindow(card, action)
}

export const applyOverlay = (
  message: OverlayAsk,
  doc: Document,
  src: string,
  onClose: () => void = () => {},
  options: HostOptions = {}
): void => {
  switch (message.type) {
    case "toggleChat":
      toggleChat(doc, src, onClose, options)
      return
    case "openChat":
      openChat(doc, src, onClose, options)
      return
    case "closeChat":
      unmountChat(doc)
      return
    case "hideChat":
      setChatHidden(doc, true)
      return
    case "showChat":
      setChatHidden(doc, false)
      return
    case "toggleInspector": {
      const send = inspectorSendOf(doc)
      if (send !== undefined) void toggleInspector(doc, src, send, options)
      return
    }
  }
  const exhaustive: never = message
  return exhaustive
}
