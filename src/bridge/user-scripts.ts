import { Option, Schema } from "effect"
import { ask } from "./messaging"

/**
 * The switch every page write depends on.
 *
 * Chrome keeps `chrome.userScripts` off until the reader turns on “Allow User Scripts” on
 * Morph's details page (Chrome 138 and later; developer mode before that). Morph writes
 * styles and scripts to a page through that API and nothing else, so while the switch is
 * off, reads work and writes fail. The panel shows a permission card for it, and the
 * service worker answers the card's questions: the worker is the context that writes, so
 * its answer is the one that counts.
 */

/** A script id no page wears, so the probe below returns nothing and costs nothing. */
const PROBE_ID = "redesign:probe"

/**
 * True when this context can call `chrome.userScripts` now. A method call, not a property
 * check: Chrome binds the namespace when the context starts, so a context that outlives a
 * revoke still has it defined, and only a call tells the truth.
 */
export const userScriptsAvailable = async (): Promise<boolean> => {
  try {
    await chrome.userScripts.getScripts({ ids: [PROBE_ID] })
    return true
  } catch {
    return false
  }
}

/** Where the switch lives. Chrome does not follow `chrome://` links from a page; a tab opened by the extension gets there. */
export const userScriptsSettingsUrl = (extensionId: string): string => `chrome://extensions/?id=${extensionId}`

/** What a page write answers the model while the switch is off. The panel card is the reader's half of this. */
export const USER_SCRIPTS_OFF =
  "chrome.userScripts is off, so Morph cannot write to the page yet. The reader sees a card in Morph with an “Open Morph settings” button that leads to the “Allow User Scripts” switch. Tell them to turn it on and send the request again. Do not call ask_user for this."

const Ask = Schema.Struct({
  type: Schema.Literal("userScripts/ask"),
  /** `status` reads the switch. `openSettings` opens its page, then reads. `reload` restarts the extension so a stale worker sees a switch turned on. */
  ask: Schema.Literals(["status", "openSettings", "reload"])
})
export type UserScriptsAsk = typeof Ask.Type

const Status = Schema.Struct({ type: Schema.Literal("userScripts/status"), enabled: Schema.Boolean })
export type UserScriptsStatus = typeof Status.Type

const askOf = Schema.decodeUnknownOption(Ask)
const statusOf = Schema.decodeUnknownOption(Status)

export const decodeUserScriptsAsk = (value: unknown): UserScriptsAsk | undefined => Option.getOrUndefined(askOf(value))
export const isUserScriptsAsk = (value: unknown): value is UserScriptsAsk => decodeUserScriptsAsk(value) !== undefined
export const decodeUserScriptsStatus = (value: unknown): UserScriptsStatus | undefined =>
  Option.getOrUndefined(statusOf(value))

/**
 * The tab whose card asked. The settings page opens beside it, in its window: without an
 * anchor Chrome picks the last focused window, which is not the reader's when they have two.
 */
export interface TabAnchor {
  readonly tabId: number
  readonly windowId: number
  readonly index: number
}

/** The part of a runtime message sender the handler reads: the tab the panel's card sits in, when there is one. */
export interface UserScriptsSender {
  readonly tab?: chrome.tabs.Tab | undefined
}

const tabAnchorOf = (sender: UserScriptsSender): TabAnchor | undefined => {
  const tab = sender.tab
  if (tab === undefined || tab.id === undefined || tab.windowId === undefined) return undefined
  return { tabId: tab.id, windowId: tab.windowId, index: tab.index }
}

/** What the worker needs to answer an ask. Tests bind fakes; `chromeUserScriptsPorts` binds the browser. */
export interface UserScriptsPorts {
  readonly available: () => Promise<boolean>
  /** Opens `url` beside the anchor, or where the browser likes when the asker was not a tab. */
  readonly openTab: (url: string, beside: TabAnchor | undefined) => Promise<void>
  /** Restarts the extension. Never returns an answer: the worker dies with the call. */
  readonly reload: () => void
  readonly settingsUrl: string
}

export const userScriptsHandler =
  (ports: UserScriptsPorts) =>
  async (ask: UserScriptsAsk, sender: UserScriptsSender): Promise<UserScriptsStatus> => {
    if (ask.ask === "openSettings") await ports.openTab(ports.settingsUrl, tabAnchorOf(sender))
    if (ask.ask === "reload") ports.reload()
    return { type: "userScripts/status", enabled: await ports.available() }
  }

export const chromeUserScriptsPorts = (): UserScriptsPorts => ({
  available: userScriptsAvailable,
  openTab: async (url, beside) => {
    await chrome.tabs.create(
      beside === undefined
        ? { url }
        : { url, windowId: beside.windowId, index: beside.index + 1, openerTabId: beside.tabId }
    )
  },
  reload: () => chrome.runtime.reload(),
  settingsUrl: userScriptsSettingsUrl(chrome.runtime.id)
})

/** The panel's view of the switch. The real one asks the worker; a page outside the extension has nothing to switch. */
export interface UserScriptsGate {
  readonly enabled: () => Promise<boolean>
  readonly openSettings: () => Promise<void>
  readonly reload: () => Promise<void>
}

const send = async (question: UserScriptsAsk["ask"]): Promise<boolean> => {
  const message: UserScriptsAsk = { type: "userScripts/ask", ask: question }
  const answer = decodeUserScriptsStatus(await ask("userScripts", message))
  return answer?.enabled ?? false
}

export const chromeUserScriptsGate: UserScriptsGate = {
  enabled: () => send("status"),
  openSettings: async () => {
    await send("openSettings")
  },
  // The worker restarts before it can answer; the rejected send is the expected outcome.
  reload: () => send("reload").then(() => undefined, () => undefined)
}

export const alwaysOnUserScriptsGate: UserScriptsGate = {
  enabled: async () => true,
  openSettings: async () => {},
  reload: async () => {}
}
