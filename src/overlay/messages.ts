/** Messages the content script answers besides page reads. */

import type { CrewBotView } from "./crew"

export type OverlayAsk =
  | { readonly type: "toggleChat" }
  | { readonly type: "openChat" }
  | { readonly type: "closeChat" }
  | { readonly type: "hideChat" }
  | { readonly type: "showChat" }
  /** Enters or leaves inspect mode on the page's card. `Alt+Shift+I` sends this too. */
  | { readonly type: "toggleInspector" }

export type CrewAsk =
  | { readonly type: "setCrewBots"; readonly bots: ReadonlyArray<CrewBotView> }
  | { readonly type: "hideCrewBots" }
  | { readonly type: "showCrewBots" }
  | { readonly type: "clearCrewBots" }

/** Signals sent from a page document to the service worker. */
export type OverlaySignal = { readonly type: "chatReady" } | { readonly type: "chatClosed" }

/** Actions sent by the panel iframe to its card host. */
export type PanelAction =
  | { readonly type: "closeChat" }
  | { readonly type: "minimizeChat" }
  | { readonly type: "reloadChat" }
  | { readonly type: "toggleExpandedChat" }
  | { readonly type: "setChatHeaderHovered"; readonly hovered: boolean }
  /** Widen the card in place for the settings workspace, or return it to normal. */
  | { readonly type: "setChatWide"; readonly wide: boolean }

/** Panel iframe to page host: inspect mode only. */
export type PanelToHostInspectorMessage = { readonly type: "toggleInspector" }

/** Page host to panel iframe: agent hand-off delivery. */
export type HostToPanelInspectorMessage = {
  readonly type: "inspectorHandoff"
  readonly requestId: string
  readonly nonce: string
  readonly prompt: string
}

/** Panel iframe to page host: hand-off accepted by the current listener. */
export type PanelToHostInspectorAck = {
  readonly type: "inspectorHandoffAck"
  readonly requestId: string
}

export const isOverlayAsk = (message: unknown): message is OverlayAsk => {
  if (message === null || typeof message !== "object" || !("type" in message)) return false
  const type = (message as { type: unknown }).type
  return (
    type === "toggleChat" ||
    type === "openChat" ||
    type === "closeChat" ||
    type === "hideChat" ||
    type === "showChat" ||
    type === "toggleInspector"
  )
}

export const isOverlaySignal = (message: unknown): message is OverlaySignal => {
  if (message === null || typeof message !== "object" || !("type" in message)) return false
  const type = (message as { type: unknown }).type
  return type === "chatReady" || type === "chatClosed"
}

export const isCrewAsk = (message: unknown): message is CrewAsk => {
  if (message === null || typeof message !== "object" || !("type" in message)) return false
  const type = (message as { type: unknown }).type
  if (type === "setCrewBots") return Array.isArray((message as { bots?: unknown }).bots)
  return type === "hideCrewBots" || type === "showCrewBots" || type === "clearCrewBots"
}

export const isPanelToHostInspectorMessage = (message: unknown): message is PanelToHostInspectorMessage => {
  if (message === null || typeof message !== "object" || !("type" in message)) return false
  return (message as { type: unknown }).type === "toggleInspector"
}

export const isHostToPanelInspectorMessage = (message: unknown): message is HostToPanelInspectorMessage => {
  if (message === null || typeof message !== "object" || !("type" in message)) return false
  const row = message as Record<string, unknown>
  return (
    row.type === "inspectorHandoff" &&
    typeof row.requestId === "string" &&
    typeof row.nonce === "string" &&
    typeof row.prompt === "string"
  )
}

export const isPanelToHostInspectorAck = (message: unknown): message is PanelToHostInspectorAck => {
  if (message === null || typeof message !== "object" || !("type" in message)) return false
  const row = message as Record<string, unknown>
  return row.type === "inspectorHandoffAck" && typeof row.requestId === "string"
}

export const isPanelAction = (message: unknown): message is PanelAction => {
  if (message === null || typeof message !== "object" || !("type" in message)) return false
  const type = (message as { type: unknown }).type
  if (type === "setChatWide") return typeof (message as Record<string, unknown>).wide === "boolean"
  if (type === "setChatHeaderHovered") return typeof (message as Record<string, unknown>).hovered === "boolean"
  return type === "closeChat" || type === "minimizeChat" || type === "reloadChat" || type === "toggleExpandedChat"
}
