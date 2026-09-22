import { describe, expect, test } from "bun:test"
import {
  createPanelSessionHandler,
  isPanelSessionAsk,
  makePanelSessionStore,
  PANEL_SESSION_STORAGE_KEY,
  type PanelSessionAnswer,
  type PanelSessionStorage
} from "./panel-attest"

const PANEL_URL = "chrome-extension://morphid/panel.html"
const PAGE = "https://app.test/dashboard"

const memoryStorage = (initial: Record<string, unknown> = {}) => {
  const state: Record<string, unknown> = { ...initial }
  const storage: PanelSessionStorage = {
    get: async (key) => ({ [key]: state[key] }),
    set: async (items) => {
      Object.assign(state, items)
    }
  }
  return { state, storage }
}

const handlerOn = (storage: PanelSessionStorage) =>
  createPanelSessionHandler({ store: makePanelSessionStore(storage), panelUrl: PANEL_URL })

/** What Chrome reports for a message sent by the content script running in a page. */
const pageHost = (tabId: number, url: string = PAGE) => ({ tab: { id: tabId }, url })

/** What Chrome reports for a message sent by the panel document inside an iframe. */
const panelFrame = (tabId: number, url: string = `${PANEL_URL}#morph-nonce=secret`) => ({
  tab: { id: tabId },
  url
})

describe("panel session attestation", () => {
  test("a page host registers a nonce and its own panel frame validates it", async () => {
    const handle = handlerOn(memoryStorage().storage)

    await expect(handle({ type: "registerPanelSession", nonce: "secret" }, pageHost(7))).resolves.toEqual({
      type: "panelSessionRegistered"
    })
    await expect(handle({ type: "validatePanelSession", nonce: "secret" }, panelFrame(7))).resolves.toEqual({
      type: "panelSessionChecked",
      valid: true
    })
  })

  test("a hostile page that frames the panel with a nonce it chose itself is refused", async () => {
    const handle = handlerOn(memoryStorage().storage)

    // No content host ever registered this nonce; the page invented it and put it in the hash.
    await expect(
      handle(
        { type: "validatePanelSession", nonce: "page-chosen" },
        panelFrame(7, `${PANEL_URL}#morph-nonce=page-chosen`)
      )
    ).resolves.toEqual({ type: "panelSessionChecked", valid: false })
  })

  test("a hostile framed panel cannot register the nonce it chose itself", async () => {
    const handle = handlerOn(memoryStorage().storage)

    await expect(
      handle({ type: "registerPanelSession", nonce: "page-chosen" }, panelFrame(7))
    ).resolves.toEqual({
      type: "panelSessionError",
      message: "Only a Morph page host can register a panel session."
    })
    await expect(
      handle({ type: "validatePanelSession", nonce: "page-chosen" }, panelFrame(7))
    ).resolves.toEqual({ type: "panelSessionChecked", valid: false })
  })

  test("a nonce registered for one tab does not validate in another tab", async () => {
    const handle = handlerOn(memoryStorage().storage)
    await handle({ type: "registerPanelSession", nonce: "secret" }, pageHost(7))

    await expect(handle({ type: "validatePanelSession", nonce: "secret" }, panelFrame(8))).resolves.toEqual({
      type: "panelSessionChecked",
      valid: false
    })
  })

  test("registration needs a content-script sender on a non-extension page URL", async () => {
    const handle = handlerOn(memoryStorage().storage)
    const refused: PanelSessionAnswer = {
      type: "panelSessionError",
      message: "Only a Morph page host can register a panel session."
    }

    // No tab at all: an extension page that is not in a tab.
    await expect(handle({ type: "registerPanelSession", nonce: "n" }, { url: PAGE })).resolves.toEqual(refused)
    // A tab, but no frame URL to judge.
    await expect(handle({ type: "registerPanelSession", nonce: "n" }, { tab: { id: 7 } })).resolves.toEqual(refused)
    // This extension's own pages, in a tab.
    await expect(
      handle({ type: "registerPanelSession", nonce: "n" }, pageHost(7, `${PANEL_URL}#morph-nonce=n`))
    ).resolves.toEqual(refused)
    await expect(
      handle({ type: "registerPanelSession", nonce: "n" }, pageHost(7, "chrome-extension://morphid/sandbox.html"))
    ).resolves.toEqual(refused)
    // Another extension's page.
    await expect(
      handle({ type: "registerPanelSession", nonce: "n" }, pageHost(7, "chrome-extension://other/panel.html"))
    ).resolves.toEqual(refused)
    // An unparseable frame URL.
    await expect(handle({ type: "registerPanelSession", nonce: "n" }, pageHost(7, "not a url"))).resolves.toEqual(
      refused
    )
    // An empty nonce is not a secret.
    await expect(handle({ type: "registerPanelSession", nonce: "" }, pageHost(7))).resolves.toEqual({
      type: "panelSessionError",
      message: "Only a Morph page host can register a panel session."
    })
  })

  test("validation only answers a sender whose URL is exactly this extension's panel.html", async () => {
    const handle = handlerOn(memoryStorage().storage)
    await handle({ type: "registerPanelSession", nonce: "secret" }, pageHost(7))
    const refused: PanelSessionAnswer = {
      type: "panelSessionError",
      message: "Only the Morph panel can check a panel session."
    }

    const wrongSenders = [
      // The page itself, asking on the panel's behalf.
      PAGE,
      // A page path that only contains the panel URL as a substring.
      `https://evil.test/${PANEL_URL}`,
      `https://evil.test/panel.html`,
      // The right origin, a path that only starts with the panel path.
      "chrome-extension://morphid/panel.html.evil",
      "chrome-extension://morphid/nested/panel.html",
      // The right path on another extension.
      "chrome-extension://other/panel.html",
      "not a url"
    ]
    for (const url of wrongSenders) {
      await expect(
        handle({ type: "validatePanelSession", nonce: "secret" }, { tab: { id: 7 }, url })
      ).resolves.toEqual(refused)
    }
    await expect(handle({ type: "validatePanelSession", nonce: "secret" }, { url: PANEL_URL })).resolves.toEqual(
      refused
    )
    // A query string and a hash still name the same document.
    await expect(
      handle({ type: "validatePanelSession", nonce: "secret" }, panelFrame(7, `${PANEL_URL}?a=1#morph-nonce=secret`))
    ).resolves.toEqual({ type: "panelSessionChecked", valid: true })
  })

  test("a new registration replaces the tab's previous nonce in one write", async () => {
    const { state, storage } = memoryStorage()
    const handle = handlerOn(storage)

    await handle({ type: "registerPanelSession", nonce: "first" }, pageHost(7))
    await handle({ type: "registerPanelSession", nonce: "second" }, pageHost(7))

    expect(state[PANEL_SESSION_STORAGE_KEY]).toEqual({ "7": "second" })
    await expect(handle({ type: "validatePanelSession", nonce: "first" }, panelFrame(7))).resolves.toEqual({
      type: "panelSessionChecked",
      valid: false
    })
    await expect(handle({ type: "validatePanelSession", nonce: "second" }, panelFrame(7))).resolves.toEqual({
      type: "panelSessionChecked",
      valid: true
    })
  })

  test("revoking a stale nonce leaves the tab's newer registration alone", async () => {
    const handle = handlerOn(memoryStorage().storage)
    await handle({ type: "registerPanelSession", nonce: "first" }, pageHost(7))
    await handle({ type: "registerPanelSession", nonce: "second" }, pageHost(7))

    await expect(handle({ type: "revokePanelSession", nonce: "first" }, pageHost(7))).resolves.toEqual({
      type: "panelSessionRevoked"
    })

    await expect(handle({ type: "validatePanelSession", nonce: "second" }, panelFrame(7))).resolves.toEqual({
      type: "panelSessionChecked",
      valid: true
    })
  })

  test("revoking the live nonce ends the session", async () => {
    const { state, storage } = memoryStorage()
    const handle = handlerOn(storage)
    await handle({ type: "registerPanelSession", nonce: "secret" }, pageHost(7))

    await handle({ type: "revokePanelSession", nonce: "secret" }, pageHost(7))

    expect(state[PANEL_SESSION_STORAGE_KEY]).toEqual({})
    await expect(handle({ type: "validatePanelSession", nonce: "secret" }, panelFrame(7))).resolves.toEqual({
      type: "panelSessionChecked",
      valid: false
    })
  })

  test("a store rebuilt over the same session storage still answers for a live tab", async () => {
    const { state, storage } = memoryStorage()
    await handlerOn(storage)({ type: "registerPanelSession", nonce: "secret" }, pageHost(7))

    // What a service-worker restart leaves behind: new store, new handler, same session storage.
    const restarted = createPanelSessionHandler({
      store: makePanelSessionStore({
        get: async (key) => ({ [key]: state[key] }),
        set: async (items) => {
          Object.assign(state, items)
        }
      }),
      panelUrl: PANEL_URL
    })

    await expect(restarted({ type: "validatePanelSession", nonce: "secret" }, panelFrame(7))).resolves.toEqual({
      type: "panelSessionChecked",
      valid: true
    })
  })

  test("a malformed stored map answers no instead of throwing", async () => {
    for (const stored of ["nonsense", [1, 2], { "7": 42 }, { notATab: "secret" }]) {
      const handle = handlerOn(memoryStorage({ [PANEL_SESSION_STORAGE_KEY]: stored }).storage)
      await expect(handle({ type: "validatePanelSession", nonce: "secret" }, panelFrame(7))).resolves.toEqual({
        type: "panelSessionChecked",
        valid: false
      })
    }
  })

  test("clearing a removed tab drops only that tab's nonce", async () => {
    const { state, storage } = memoryStorage()
    const store = makePanelSessionStore(storage)
    await store.register(7, "seven")
    await store.register(8, "eight")

    await store.clear(7)

    expect(state[PANEL_SESSION_STORAGE_KEY]).toEqual({ "8": "eight" })
  })

  test("two tabs registering at the same time both keep their nonce", async () => {
    const { state, storage } = memoryStorage()
    const store = makePanelSessionStore(storage)

    await Promise.all([store.register(7, "seven"), store.register(8, "eight")])

    expect(state[PANEL_SESSION_STORAGE_KEY]).toEqual({ "7": "seven", "8": "eight" })
  })

  test("isPanelSessionAsk accepts the three typed asks and nothing else", () => {
    expect(isPanelSessionAsk({ type: "registerPanelSession", nonce: "a" })).toBe(true)
    expect(isPanelSessionAsk({ type: "revokePanelSession", nonce: "a" })).toBe(true)
    expect(isPanelSessionAsk({ type: "validatePanelSession", nonce: "a" })).toBe(true)
    expect(isPanelSessionAsk({ type: "registerPanelSession" })).toBe(false)
    expect(isPanelSessionAsk({ type: "registerPanelSession", nonce: 7 })).toBe(false)
    expect(isPanelSessionAsk({ type: "loadInspector" })).toBe(false)
    expect(isPanelSessionAsk(null)).toBe(false)
  })
})
