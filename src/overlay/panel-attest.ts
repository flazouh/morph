/**
 * Proof that Morph's own content host, and not the page, created an embedded panel
 * session.
 *
 * The panel reads its session nonce from its own URL hash, which is exactly what a
 * hostile page can write: `panel.html` is web accessible, so any page can frame it with a
 * nonce it chose itself and then post a matching hand-off. The nonce is therefore not
 * evidence on its own. The service worker holds the evidence: the content host registers
 * its fresh nonce for its own tab before the iframe navigates, and the panel asks the
 * worker whether the nonce in its URL is the one that was registered for the tab it runs
 * in. A page-chosen nonce was never registered, so its panel never starts listening.
 *
 * Registration answers a content script on a page. Validation answers this extension's
 * own `panel.html`. Both boundaries are exact origin-and-path comparisons, never a
 * substring test, because `https://evil.test/chrome-extension://id/panel.html` contains
 * the panel URL and is not it.
 */

import { makeTabMap, type TabMapStorage } from "@/lib/tab-map"
import { ask } from "../bridge/messaging"
import { frameOrigin } from "./panel-session"

export const PANEL_SESSION_STORAGE_KEY = "panel-sessions"

export type PanelSessionAsk =
  | { readonly type: "registerPanelSession"; readonly nonce: string }
  | { readonly type: "revokePanelSession"; readonly nonce: string }
  | { readonly type: "validatePanelSession"; readonly nonce: string }

export type PanelSessionAnswer =
  | { readonly type: "panelSessionRegistered" }
  | { readonly type: "panelSessionRevoked" }
  | { readonly type: "panelSessionChecked"; readonly valid: boolean }
  | { readonly type: "panelSessionError"; readonly message: string }

export const isPanelSessionAsk = (value: unknown): value is PanelSessionAsk => {
  if (typeof value !== "object" || value === null) return false
  const ask = value as Record<string, unknown>
  if (typeof ask.nonce !== "string") return false
  return (
    ask.type === "registerPanelSession" ||
    ask.type === "revokePanelSession" ||
    ask.type === "validatePanelSession"
  )
}

/** The one live panel nonce per tab. A tab holds at most one embedded card at a time. */
export interface PanelSessionStore {
  register(tabId: number, nonce: string): Promise<void>
  /** Ends the session only when `nonce` is still the live one, so a late revoke cannot end a newer card's session. */
  revoke(tabId: number, nonce: string): Promise<void>
  clear(tabId: number): Promise<void>
  active(tabId: number): Promise<string | null>
}

export type PanelSessionStorage = TabMapStorage

/** An empty nonce is not a secret, so it is not a session either. */
const isNonce = (value: unknown): value is string => typeof value === "string" && value !== ""

export const makePanelSessionStore = (storage: PanelSessionStorage): PanelSessionStore => {
  const sessions = makeTabMap(storage, PANEL_SESSION_STORAGE_KEY, isNonce)

  return {
    register: (tabId, nonce) => sessions.update(tabId, () => nonce),
    revoke: (tabId, nonce) => sessions.update(tabId, (live) => (live === nonce ? undefined : live)),
    clear: (tabId) => sessions.update(tabId, () => undefined),
    active: (tabId) => sessions.get(tabId)
  }
}

export const chromePanelSessionStore = (): PanelSessionStore =>
  makePanelSessionStore(chrome.storage.session)

export interface PanelSessionSender {
  readonly tab?: { readonly id?: number }
  /** The URL of the frame that sent the message, which is what tells a page apart from the panel. */
  readonly url?: string
}

export interface PanelSessionPorts {
  readonly store: PanelSessionStore
  /** `chrome.runtime.getURL("panel.html")`: the one exact origin and path a panel sender may have. */
  readonly panelUrl: string
}

export type PanelSessionHandler = (
  ask: PanelSessionAsk,
  sender: PanelSessionSender
) => Promise<PanelSessionAnswer>

/**
 * Origin and path only: a query string or a hash names the same document, a different
 * path does not. `frameOrigin` is the canonical origin rule, which is why two different
 * extensions never compare equal here.
 */
const documentBoundary = (url: string): string | null => {
  const origin = frameOrigin(url)
  return origin === null ? null : `${origin}${new URL(url).pathname}`
}

const REGISTER_REFUSED = "Only a Morph page host can register a panel session."
const VALIDATE_REFUSED = "Only the Morph panel can check a panel session."

export const createPanelSessionHandler = ({ store, panelUrl }: PanelSessionPorts): PanelSessionHandler => {
  const panelBoundary = documentBoundary(panelUrl)
  const extensionOrigin = frameOrigin(panelUrl)

  /** The tab of a content script running on a page: a real tab, and a frame URL outside any extension. */
  const pageHostTab = (sender: PanelSessionSender): number | null => {
    const tabId = sender.tab?.id
    if (typeof tabId !== "number" || typeof sender.url !== "string") return null
    const origin = frameOrigin(sender.url)
    if (origin === null || origin === extensionOrigin) return null
    if (new URL(sender.url).protocol === "chrome-extension:") return null
    return tabId
  }

  /** The tab of this extension's own `panel.html`, wherever it is framed. */
  const panelTab = (sender: PanelSessionSender): number | null => {
    const tabId = sender.tab?.id
    if (typeof tabId !== "number" || typeof sender.url !== "string") return null
    const boundary = documentBoundary(sender.url)
    return boundary !== null && boundary === panelBoundary ? tabId : null
  }

  return async (ask, sender) => {
    if (ask.type === "validatePanelSession") {
      const tabId = panelTab(sender)
      if (tabId === null) return { type: "panelSessionError", message: VALIDATE_REFUSED }
      return { type: "panelSessionChecked", valid: (await store.active(tabId)) === ask.nonce }
    }

    const tabId = pageHostTab(sender)
    if (tabId === null || ask.nonce === "") {
      return { type: "panelSessionError", message: REGISTER_REFUSED }
    }
    if (ask.type === "registerPanelSession") {
      await store.register(tabId, ask.nonce)
      return { type: "panelSessionRegistered" }
    }
    await store.revoke(tabId, ask.nonce)
    return { type: "panelSessionRevoked" }
  }
}

/** What the content host does with its nonce: prove it to the worker, and give it back on unmount. */
export interface PanelAttestation {
  register(nonce: string): Promise<void>
  revoke(nonce: string): Promise<void>
}

const askWorker = (message: PanelSessionAsk): Promise<PanelSessionAnswer | undefined> =>
  ask("panelSession", message).catch((): undefined => undefined)

export const chromePanelAttestation = (): PanelAttestation => ({
  register: async (nonce) => {
    const answer = await askWorker({ type: "registerPanelSession", nonce })
    if (answer?.type !== "panelSessionRegistered") {
      throw new Error("Morph could not open a panel session for this tab.")
    }
  },
  revoke: async (nonce) => {
    await askWorker({ type: "revokePanelSession", nonce })
  }
})

/** The panel's own check, before it will listen for a hand-off. Any failure answers no. */
export const chromeValidatePanelSession = async (nonce: string): Promise<boolean> => {
  try {
    const answer = await askWorker({ type: "validatePanelSession", nonce })
    return answer?.type === "panelSessionChecked" && answer.valid
  } catch {
    return false
  }
}
