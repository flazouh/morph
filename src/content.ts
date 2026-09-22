import { Effect } from "effect"
import { readDesign, readPage, readStyles, readText } from "./bridge/dom"
import { decodePageAsk, type PageAnswer, type PageAsk } from "./bridge/messages"
import { accepting, answer, ask, signal } from "./bridge/messaging"
import { chromeForkDraftMemory } from "./marketplace/forks/memory"
import { isForkPreviewAsk } from "./marketplace/forks/preview"
import { chromeLibraryMemory } from "./marketplace/library"
import { createPagePreviewState } from "./marketplace/page-preview-state"
import { isPagePreviewAsk } from "./marketplace/preview"
import { makeAssetLoader } from "./marketplace/sandbox/asset"
import { makePageFetch } from "./marketplace/sandbox/page-fetch"
import {
  chromePackageStorage,
  makePageContext,
  makePageNavigate,
  makePageTraverse
} from "./marketplace/sandbox/page-ports"
import { watchInstalledSandboxes } from "./marketplace/sandbox/watch"
import type { InspectorAsk, InspectorAnswer } from "./inspector/messages"
import { startInspectorContent } from "./inspector/content-startup"
import { applyOverlay, installInspectorHotkey } from "./overlay/host"
import { clearCrewBots, setCrewBots, setCrewBotsHidden } from "./overlay/crew"
import { isCrewAsk, isOverlayAsk } from "./overlay/messages"
import { relayWebAsks } from "./bridge/web-page"

/**
 * The content script: the panel's eyes on the page, and the host of installed packages.
 * Reads change nothing. Writes go through `chrome.userScripts` from the panel, so a page
 * never sees two writers.
 */

const panelUrl = (): string => chrome.runtime.getURL("panel.html")
const forkMemory = chromeForkDraftMemory()
const previewState = createPagePreviewState()

/** The typed Task 3 runtime contract, shared by the hotkey and the `toggleInspector` overlay ask. */
const sendInspectorAsk = (message: InspectorAsk): Promise<InspectorAnswer> => ask("inspector", message)

const reportClosed = (): void => {
  previewState.stopMarketplace({
    type: "marketplacePreviewError",
    message: "the marketplace preview stopped when the chat closed"
  })
  signal("overlaySignal", { type: "chatClosed" })
}

const read = (message: PageAsk): PageAnswer => {
  switch (message.type) {
    case "readPage":
      return { type: "readPage", page: readPage(document, window, message.selector, message.maxNodes ?? 1500) }
    case "readStyles":
      return { type: "readStyles", nodes: readStyles(document, window, message.selector, message.limit ?? 20) }
    case "readText":
      return { type: "readText", texts: readText(document, message.selector, message.limit ?? 20) }
    case "readDesign":
      return { type: "readDesign", design: readDesign(document, window) }
  }
}

// The preview state settles the reply when the page has drawn, or when a later preview
// replaces this one: the promise's resolve is that reply.
answer("pagePreview", accepting(isPagePreviewAsk), (message) =>
  new Promise((reply) =>
    message.type === "showMarketplacePreview"
      ? previewState.showMarketplace(message.preview, reply)
      : previewState.clearMarketplace(reply)
  )
)

answer("forkPreview", accepting(isForkPreviewAsk), (message) =>
  new Promise((reply) =>
    message.type === "previewForkRevision"
      ? previewState.showFork(message.preview, reply)
      : previewState.clearFork(message.draftId, reply)
  )
)

answer("overlay", accepting(isOverlayAsk), (message) => {
  applyOverlay(message, document, panelUrl(), reportClosed)
  return { type: "ok" }
})

answer("crew", accepting(isCrewAsk), (message) => {
  switch (message.type) {
    case "setCrewBots":
      setCrewBots(document, window, message.bots)
      break
    case "hideCrewBots":
      setCrewBotsHidden(document, true)
      break
    case "showCrewBots":
      setCrewBotsHidden(document, false)
      break
    case "clearCrewBots":
      clearCrewBots(document)
      break
  }
  return { type: "ok" }
})

answer("page", decodePageAsk, (message) => {
  try {
    return read(message)
  } catch (e) {
    return { type: "error", message: e instanceof Error ? e.message : String(e) }
  }
})

// The page's window.__beui.fetch: the kit posts the ask to the window, this world carries
// it to the worker, the one context whose network is not bound by the page's origin.
relayWebAsks(window, (message) => ask("fetchWeb", message))

const clearPageStateOnNavigation = (): void => {
  clearCrewBots(document)
  previewState.navigate()
}
document.addEventListener("turbo:load", clearPageStateOnNavigation)
window.addEventListener("popstate", clearPageStateOnNavigation)
window.navigation?.addEventListener(
  "navigatesuccess",
  clearPageStateOnNavigation
)

void startInspectorContent(
  document,
  sendInspectorAsk
).then(() => signal("overlaySignal", { type: "chatReady" }))

installInspectorHotkey(document, panelUrl(), sendInspectorAsk)

const startPackages = Effect.gen(function* () {
  yield* watchInstalledSandboxes({
    document,
    location: window.location,
    sandboxUrl: chrome.runtime.getURL("sandbox.html"),
    library: () => Effect.promise(() => chromeLibraryMemory.read()),
    current: () =>
      Effect.promise(async () => {
        const installedLibrary = await chromeLibraryMemory.read()
        return previewState.current(
          window.location,
          installedLibrary,
          (await forkMemory.read()).drafts
        )
      }),
    changes: previewState.changes,
    onRefresh: previewState.refresh,
    fetchPage: makePageFetch(globalThis.fetch),
    navigatePage: makePageNavigate(window),
    traversePage: makePageTraverse(window),
    pageContext: makePageContext(document, window.location),
    loadAsset: makeAssetLoader((message) => ask("asset", message)),
    storage: chromePackageStorage()
  })
  return yield* Effect.never
})

Effect.runFork(Effect.scoped(startPackages))
