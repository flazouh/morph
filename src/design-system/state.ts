import type { PanelAction } from "@/overlay/messages"
import { initialChatWindow, reduceChatWindow, type ChatWindow } from "@/overlay/window-state"

export interface PreviewState extends ChatWindow {
  readonly open: boolean
}

export type PreviewAction = PanelAction | { readonly type: "openChat" } | { readonly type: "restoreChat" }

export const initialPreview: PreviewState = {
  open: true,
  ...initialChatWindow
}

export const reducePreview = (state: PreviewState, action: PreviewAction): PreviewState => {
  if (action.type === "openChat") return initialPreview
  if (action.type === "reloadChat") return state
  if (action.type === "closeChat") return { ...state, open: false }
  // The preview drives the settings width from its own state, not the window reducer.
  if (action.type === "setChatWide" || action.type === "setChatHeaderHovered") {
    return state
  }
  const next = reduceChatWindow(state, action)
  return next === state ? state : { ...state, ...next }
}
