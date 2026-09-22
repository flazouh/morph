export type ChatMode = "normal" | "expanded" | "minimized"

export interface ChatWindow {
  readonly mode: ChatMode
  readonly restoreMode: Exclude<ChatMode, "minimized">
}

export type ChatWindowAction =
  | { readonly type: "toggleExpandedChat" }
  | { readonly type: "minimizeChat" }
  | { readonly type: "restoreChat" }

export const initialChatWindow: ChatWindow = {
  mode: "normal",
  restoreMode: "normal"
}

export const reduceChatWindow = (state: ChatWindow, action: ChatWindowAction): ChatWindow => {
  if (action.type === "restoreChat") {
    return state.mode === "minimized" ? { ...state, mode: state.restoreMode } : state
  }
  if (action.type === "minimizeChat") {
    return {
      mode: "minimized",
      restoreMode: state.mode === "minimized" ? state.restoreMode : state.mode
    }
  }
  const mode = state.mode === "expanded" ? "normal" : "expanded"
  return {
    mode,
    restoreMode: mode
  }
}
