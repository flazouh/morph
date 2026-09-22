/**
 * Test doubles for the extension protocol.
 *
 * A test plays the other context by registering `answer(...)` in this same process. The
 * fake browser's `runtime.sendMessage` already delivers to those answers; `tabs.sendMessage`
 * is not mocked, so this routes a tab-targeted ask the same way.
 */

import { fakeBrowser } from "@webext-core/fake-browser"

/** A `chrome.tabs.sendMessage` that delivers to the answers registered in this process. */
export const tabsThatAnswer = (): Pick<typeof chrome.tabs, "sendMessage"> => ({
  sendMessage: ((_tabId: number, message: unknown, _options: unknown, callback: (answer: unknown) => void) => {
    void fakeBrowser.runtime.sendMessage(message).then(callback)
  }) as typeof chrome.tabs.sendMessage
})

/** The runtime a context needs to `answer` and `ask` through the fake browser. */
export const runtimeThatAnswers = (): Pick<typeof chrome.runtime, "onMessage" | "sendMessage"> => ({
  onMessage: fakeBrowser.runtime.onMessage,
  sendMessage: fakeBrowser.runtime.sendMessage
})
