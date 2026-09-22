import type { PanelAction, PanelToHostInspectorMessage } from "@/overlay/messages"
import { isInvalidatedExtensionContext } from "@/extension/context"

/** Tell the page host to resize, minimize, or close this embedded chat. */
export const postWindowAction = (action: PanelAction): void => {
  window.parent.postMessage(action, "*")
}

/** Tell the page host to enter or leave inspect mode. */
export const postInspectorPanelMessage = (message: PanelToHostInspectorMessage): void => {
  window.parent.postMessage(message, "*")
}

/** Replaces an embedded panel when an extension reload invalidates its local context. */
export const watchExtensionContext = (
  check: () => void = () => {
    chrome.runtime.getManifest()
  },
  reload: () => void = () => postWindowAction({ type: "reloadChat" }),
  intervalMs = 1_000
): (() => void) => {
  const timer = setInterval(() => {
    try {
      check()
    } catch (error) {
      if (!isInvalidatedExtensionContext(error)) return
      clearInterval(timer)
      reload()
    }
  }, intervalMs)
  return () => {
    clearInterval(timer)
  }
}
