import { accepting, answer, ask } from "./bridge/messaging"
import { waitAwake } from "./bridge/awake"
import { registrations, WEARS_REDESIGN } from "./bridge/registrations"
import { decodeWebAsk, webHandler, webSenderAllowed } from "./bridge/web"
import { chromeUserScriptsPorts, isUserScriptsAsk, userScriptsHandler } from "./bridge/user-scripts"
import { liveCursorHost } from "./cursor/live"
import { decodeCursorAsk } from "./cursor/messages"
import { browserCompilerPorts } from "./marketplace/compiler/browserPorts"
import { compilePackage } from "./marketplace/compiler/compile"
import { digestOfBytes } from "./marketplace/compiler/digest"
import { isPackageCompileAsk, packageCompileHandler } from "./marketplace/compiler/message"
import { forkEditor } from "./marketplace/forks/editor"
import { chromeForkDraftMemory } from "./marketplace/forks/memory"
import { currentRevisionOf } from "./marketplace/forks/model"
import { marketplaceInstaller } from "./marketplace/installer"
import { chromeLibraryMemory } from "./marketplace/library"
import type { InstalledRelease } from "./marketplace/installer"
import { pageDraftRecords } from "./marketplace/page-draft"
import { scriptOf, type Persisted } from "./bridge/persisted"
import type { ForkDraft } from "./marketplace/forks/model"
import { forkDraftHandler, isForkDraftAsk, isMarketplaceAsk, marketplaceHandler } from "./marketplace/messages"
import {
  isMarketplacePreviewAsk,
  prepareMarketplacePreview,
  type MarketplacePreviewAnswer,
  type MarketplacePreviewAsk
} from "./marketplace/preview"
import { reloadInstalledPage } from "./marketplace/reload"
import { createMarketplaceClient, MARKETPLACE_API } from "./marketplace/client"
import { BADGE_COLOR, markTab, type BadgePorts } from "./marketplace/badge"
import { currentPageDiscovery } from "./marketplace/discovery"
import {
  chromePublisherTokens,
  createPublisherClient
} from "./marketplace/publishing/client"
import {
  isPublisherAsk,
  publisherHandler
} from "./marketplace/publishing/messages"
import { preparePageRelease } from "./marketplace/publishing/page-release"
import { compilePagePackage } from "./marketplace/compiler/page"
import type { CompiledPackage } from "./marketplace/compiler/compile"
import { chromeTabSend, withChatHidden } from "./overlay/tab"
import { icons } from "./skin/icons"
import { sheets } from "./skin/sheets"
import { assetHandler, isAssetAsk } from "./marketplace/sandbox/asset"
import { installedReleaseOn } from "./marketplace/sandbox/installed"
import {
  createInspectorHandler,
  inspectorError,
  isInspectorAsk,
  type InspectorScripting
} from "./inspector/messages"
import { chromeInspectorStore } from "./inspector/session-store"
import { createSourceResolver } from "./inspector/source-resolver"
import { isOverlaySignal } from "./overlay/messages"
import {
  chromePanelSessionStore,
  createPanelSessionHandler,
  isPanelSessionAsk,
  type PanelSessionAnswer
} from "./overlay/panel-attest"
import { chatTabs, type ChatMemory } from "./overlay/session"
import type { TabPort } from "./overlay/tab"

/**
 * The service worker toggles the in-page chat card for the tab whose button was clicked,
 * restores an open card after that tab navigates, and registers again the user scripts
 * pages wear after an extension reload.
 *
 * It also owns every Cursor run: the agent, the SSE reader, the relay socket and the tool
 * server live here, so closing or replacing the panel iframe never stops a run.
 */

const OPEN_TABS = "open-chat-tabs"

const memory: ChatMemory = {
  has: async (tabId) => {
    const ids = ((await chrome.storage.session.get(OPEN_TABS))[OPEN_TABS] as number[] | undefined) ?? []
    return ids.includes(tabId)
  },
  set: async (tabId, open) => {
    const ids = ((await chrome.storage.session.get(OPEN_TABS))[OPEN_TABS] as number[] | undefined) ?? []
    const next = open ? [...new Set([...ids, tabId])] : ids.filter((id) => id !== tabId)
    await chrome.storage.session.set({ [OPEN_TABS]: next })
  }
}

const chromePort: TabPort = {
  send: chromeTabSend,
  inject: async (tabId) => {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content-scripts/content.js"] })
  }
}

const tabs = chatTabs(memory, chromePort)
const inspectorStore = chromeInspectorStore()
const panelSessions = chromePanelSessionStore()
const inspectorScripting: InspectorScripting = {
  executeScript: (details) => chrome.scripting.executeScript(details)
}
const handleInspector = createInspectorHandler({
  store: inspectorStore,
  scripting: inspectorScripting,
  resolveSource: createSourceResolver(fetch)
})
const handleMarketplace = marketplaceHandler(
  marketplaceInstaller({
    fetcher: fetch,
    registrations,
    memory: chromeLibraryMemory,
    now: () => new Date().toISOString()
  })
)
/**
 * The toolbar count. The discovery cache lives with these ports, so a reader moving around
 * one site asks the marketplace once; the worker restarting is what clears it.
 */
const badge: BadgePorts = {
  find: currentPageDiscovery(createMarketplaceClient()).find,
  library: () => chromeLibraryMemory.read(),
  show: async (tabId, { text, title }) => {
    await chrome.action.setBadgeText({ tabId, text })
    await chrome.action.setTitle({ tabId, title })
  }
}

const readPackageAsset = assetHandler(fetch)
const fetchWeb = webHandler(fetch, (sender) => webSenderAllowed(sender, chrome.runtime.getURL(""), registrations.wears))
const compileLocalPackage = packageCompileHandler(browserCompilerPorts)
const marketplacePage = {
  active: async (): Promise<number | undefined> => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id,
  reload: async (tabId: number): Promise<void> => chrome.tabs.reload(tabId)
}
const verifyForkTarget = async (
  tabId: number,
  preview: {
    readonly parent: { readonly slug: string; readonly version: string; readonly commit: string }
    readonly scope: { readonly origin: string; readonly paths: ReadonlyArray<string> }
  }
): Promise<void> => {
  const tab = await chrome.tabs.get(tabId)
  if (tab.url === undefined) throw new Error("the Morph draft page is no longer open")
  const location = new URL(tab.url)
  if (
    location.origin !== preview.scope.origin ||
    !preview.scope.paths.includes(location.pathname)
  ) {
    throw new Error("the Morph draft does not match its original page tab")
  }
  const release = installedReleaseOn(await chromeLibraryMemory.read(), location)
  const matchesInstalled =
    release !== undefined &&
    release.slug === preview.parent.slug &&
    release.version === preview.parent.version &&
    release.detail.source.commit === preview.parent.commit
  if (!matchesInstalled) {
    throw new Error("the page tab no longer runs the Morph draft parent")
  }
}
const handleMarketplacePreview = async (
  message: MarketplacePreviewAsk,
  senderTabId: number | undefined
): Promise<MarketplacePreviewAnswer> => {
  try {
    const tabId = senderTabId ?? await marketplacePage.active()
    if (tabId === undefined) throw new Error("no website is open for the preview")
    if (message.type === "stopMarketplacePreview") {
      await ask("pagePreview", { type: "clearMarketplacePreview" }, { tabId })
      return { type: "marketplacePreviewStopped" }
    }
    const tab = await chrome.tabs.get(tabId)
    if (tab.url === undefined) throw new Error("the preview page is no longer open")
    const location = new URL(tab.url)
    const scope = message.detail.manifest.scope
    if (location.origin !== scope.origin || !scope.paths.includes(location.pathname)) {
      throw new Error("the marketplace Morph does not match this page")
    }
    const preview = await prepareMarketplacePreview(message.detail, fetch)
    const shown = await ask("pagePreview", { type: "showMarketplacePreview", preview }, { tabId })
    if (shown.type !== "marketplacePackagePreviewed") {
      throw new Error(
        shown.type === "marketplacePreviewError" ? shown.message : "the page could not preview the marketplace Morph"
      )
    }
    return { type: "marketplacePackagePreviewed", slug: message.detail.slug }
  } catch (error) {
    return {
      type: "marketplacePreviewError",
      message: error instanceof Error ? error.message : "Marketplace preview failed"
    }
  }
}
let marketplacePreviewTurn: Promise<void> = Promise.resolve()
const queueMarketplacePreview = (
  message: MarketplacePreviewAsk,
  senderTabId: number | undefined
): Promise<MarketplacePreviewAnswer> => {
  const result = marketplacePreviewTurn.then(() =>
    handleMarketplacePreview(message, senderTabId)
  )
  marketplacePreviewTurn = result.then(
    () => undefined,
    () => undefined
  )
  return result
}
/** The installed release a draft was forked from, as the library holds it. */
const installedParentOf = async (parent: ForkDraft["parent"]): Promise<InstalledRelease | undefined> => {
  const release = (await chromeLibraryMemory.read()).active[parent.slug]
  if (release === undefined) return undefined
  return release.version === parent.version && release.detail.source.commit === parent.commit ? release : undefined
}

/**
 * What a page package runs, put on the page in front of the reader. The records are the
 * release's own or a draft's under the release's ids, and they are run here exactly as a
 * load would run them, so the change is seen without a reload. Reloading would do as
 * well, but it would take the thread's own chat down with the page.
 */
const wearPage = async (tabId: number, records: ReadonlyArray<Persisted>): Promise<void> => {
  for (const record of records) {
    const sources = scriptOf(record).js ?? []
    const [first, ...rest] = sources
    if (first === undefined) continue
    const [result] = await chrome.userScripts.execute({ target: { tabId }, js: [first, ...rest], world: "MAIN" })
    if (result?.error !== undefined) throw new Error(String(result.error))
  }
}

/**
 * What the page wears on every load, swapped between the release as published and a local
 * draft of it. The record ids stay the release's own, so discarding a draft is this same
 * write in reverse.
 */
const keepPage = async (release: InstalledRelease, compiled: CompiledPackage | undefined): Promise<ReadonlyArray<Persisted>> => {
  const records = pageDraftRecords(release.records, compiled)
  await registrations.replace(records.map((record) => record.id), records)
  return records
}

/** A page draft, worn now and on every load until it is published or discarded. */
const wearPageDraft = async (tabId: number, parent: ForkDraft["parent"], compiled: CompiledPackage): Promise<void> => {
  const release = await installedParentOf(parent)
  if (release === undefined) throw new Error("the Morph this draft changes is no longer installed")
  await wearPage(tabId, await keepPage(release, compiled))
}

/** The published page package again, in what the page wears now and on every load. */
const wearPublishedPage = async (tabId: number, parent: ForkDraft["parent"]): Promise<void> => {
  const release = await installedParentOf(parent)
  if (release === undefined) return
  await wearPage(tabId, await keepPage(release, undefined))
}

const editLocalFork = forkDraftHandler(
  forkEditor(chromeForkDraftMemory(), {
    compile: (source, runtime) =>
      runtime === "script-v1"
        ? compilePagePackage(source, { sheets, icons })
        : compilePackage(source, browserCompilerPorts),
    preview: async (preview) => {
      await verifyForkTarget(preview.tabId, preview)
      if (preview.runtime === "script-v1") {
        await wearPageDraft(preview.tabId, preview.parent, preview.revision.compiled)
        return
      }
      const shown = await ask("forkPreview", { type: "previewForkRevision", preview }, { tabId: preview.tabId })
      if (shown.type !== "forkRevisionPreviewed") {
        throw new Error(
          shown.type === "forkPreviewError" ? shown.message : "the page could not preview the local Morph draft"
        )
      }
    },
    clearPreview: async (draftId, tabId, of) => {
      if (of?.runtime === "script-v1") {
        await wearPublishedPage(tabId, of.parent)
        return
      }
      await ask("forkPreview", { type: "clearForkPreview", draftId }, { tabId })
    },
    id: () => crypto.randomUUID(),
    now: () => new Date().toISOString()
  })
)

const webpPreview = async (
  png: string
): Promise<{ readonly data: string; readonly digest: string }> => {
  const image = await createImageBitmap(await (await fetch(png)).blob())
  const canvas = new OffscreenCanvas(image.width, image.height)
  const context = canvas.getContext("2d")
  if (context === null) throw new Error("the preview image could not be created")
  context.drawImage(image, 0, 0)
  image.close()
  const bytes = new Uint8Array(
    await (await canvas.convertToBlob({ type: "image/webp", quality: 0.86 })).arrayBuffer()
  )
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return {
    data: `data:image/webp;base64,${btoa(binary)}`,
    digest: await digestOfBytes(bytes)
  }
}

/** The published look, shown for the "before" image only: what the page keeps is untouched. */
const withoutPageDraft = async (tabId: number, parent: ForkDraft["parent"]): Promise<void> => {
  const release = await installedParentOf(parent)
  if (release === undefined) throw new Error("the Morph this draft changes is no longer installed")
  await wearPage(tabId, release.records)
}

const captureForkPreviews = async (
  draftId: string,
  tabId: number
): Promise<{
  readonly before: { readonly data: string; readonly digest: string }
  readonly after: { readonly data: string; readonly digest: string }
}> => {
  const tab = await chrome.tabs.get(tabId)
  if (tab.windowId === undefined || !tab.active) {
    throw new Error("keep the Morph page active while its release previews are captured")
  }
  const draft = (await chromeForkDraftMemory().read()).drafts[draftId]
  if (draft === undefined) throw new Error("the local Morph draft does not exist")
  const revision = currentRevisionOf(draft)
  await ask("overlay", { type: "hideChat" }, { tabId })
  let beforePng: string | undefined
  let afterPng: string | undefined
  try {
    afterPng = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" })
    if (draft.runtime === "script-v1") {
      await withoutPageDraft(tabId, draft.parent)
    } else {
      const cleared = await ask("forkPreview", { type: "clearForkPreview", draftId }, { tabId })
      if (cleared.type !== "forkPreviewCleared") {
        throw new Error(
          cleared.type === "forkPreviewError" ? cleared.message : "the parent Morph could not be restored for its preview"
        )
      }
    }
    beforePng = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" })
  } finally {
    try {
      if (draft.runtime === "script-v1") {
        await wearPageDraft(tabId, draft.parent, revision.compiled)
      } else {
        const shown = await ask(
          "forkPreview",
          {
            type: "previewForkRevision",
            preview: { draftId, runtime: draft.runtime, parent: draft.parent, scope: draft.scope, revision, tabId }
          },
          { tabId }
        )
        if (shown.type !== "forkRevisionPreviewed") {
          throw new Error(shown.type === "forkPreviewError" ? shown.message : "the local Morph preview could not be restored")
        }
      }
    } finally {
      await ask("overlay", { type: "showChat" }, { tabId }).catch(() => {})
    }
  }
  if (beforePng === undefined || afterPng === undefined) {
    throw new Error("the release previews could not be captured")
  }
  const [before, after] = await Promise.all([
    webpPreview(beforePng),
    webpPreview(afterPng)
  ])
  return { before, after }
}

/** A page redesign's release: compiled here as the server compiles it, pictured on its own tab. */
const preparePage = (
  tabId: number,
  source: Parameters<typeof preparePageRelease>[2],
  paths: Parameters<typeof preparePageRelease>[3]
) =>
  preparePageRelease(
    {
      tab: async (id) => {
        const tab = await chrome.tabs.get(id)
        if (tab.url === undefined || tab.windowId === undefined) throw new Error("the Morph page is no longer open")
        return { url: tab.url, active: tab.active, windowId: tab.windowId }
      },
      compile: (input) => compilePagePackage(input, { sheets, icons }),
      execute: async (id, code) => {
        const [result] = await chrome.userScripts.execute({ target: { tabId: id }, js: [{ code }], world: "MAIN" })
        if (result?.error !== undefined) throw new Error(String(result.error))
      },
      capture: (windowId) => chrome.tabs.captureVisibleTab(windowId, { format: "png" }),
      preview: webpPreview,
      withChatHidden: (id, action) => withChatHidden(id, chromePort, action),
      wears: (url) => registrations.wears(url, WEARS_REDESIGN)
    },
    tabId,
    source,
    paths
  )

const publisher = publisherHandler(
  createPublisherClient(MARKETPLACE_API, {
    // Called through, not handed over: a worker's `fetch` wants the global as its `this`.
    fetch: (input, init) => fetch(input, init),
    tokens: chromePublisherTokens(),
    open: async (url) => {
      await chrome.tabs.create({ url })
    },
    // Pinged through, not slept through: a publish waits on a reader's sign-in, and a
    // worker that only sets a timer is stopped before they finish (see bridge/awake).
    sleep: (milliseconds) =>
      waitAwake(
        {
          wait: (step) =>
            new Promise((resolve) => {
              setTimeout(resolve, step)
            }),
          ping: () => chrome.runtime.getPlatformInfo()
        },
        milliseconds
      ),
    now: () => new Date()
  }),
  chromeForkDraftMemory(),
  captureForkPreviews,
  preparePage
)

export const startBackground = (): void => {
  // The Cursor host runs its tools here, so it publishes through this handler in hand.
  const cursor = liveCursorHost(publisher)
  const userScripts = userScriptsHandler(chromeUserScriptsPorts())
  // Built here, not at module scope, because the panel URL is the security boundary this
  // worker judges panel senders against and `getURL` needs a live runtime to answer.
  const handlePanelSession = createPanelSessionHandler({
    store: panelSessions,
    panelUrl: chrome.runtime.getURL("panel.html")
  })

  chrome.runtime.onInstalled.addListener(() => {
    void registrations.replay()
  })

  chrome.runtime.onStartup.addListener(() => {
    void registrations.replay()
  })

  chrome.action.onClicked.addListener((tab) => {
    void tabs.toggle(tab)
  })

  // The page in front decides what the icon says. A tab that loads, or moves within a site
  // without loading, is a new page to count for; the badge is per tab, so nothing else is.
  chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR })
  chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
    if (change.url === undefined && change.status !== "complete") return
    void markTab(badge, tabId, change.url ?? tab.url)
  })

  /**
   * Chrome is about to unload this worker. Releasing the Cursor sessions here closes their
   * relay sockets instead of leaving the relay to notice a cut one, and it stops the runs
   * rather than leaving them going with nothing reading them. Chrome does not promise to
   * ask, so nothing depends on it: every thread reads back from its own record.
   */
  chrome.runtime.onSuspend.addListener(() => {
    void cursor.shutdown()
  })

  // Every Cursor run lives here, not in the panel, so the panel closing never stops one.
  answer("cursor", decodeCursorAsk, (message) => cursor.handle(message))

  // Proof that Morph's own content host, and not the page, opened this panel session.
  // The sender's own frame URL is what tells a page host apart from the panel, so this
  // must stay on the worker side of the boundary.
  answer("panelSession", accepting(isPanelSessionAsk), (message, sender) =>
    handlePanelSession(message, sender).catch(
      (): PanelSessionAnswer => ({ type: "panelSessionError", message: "The panel session could not be checked." })
    )
  )

  // The panel's User Scripts card: this worker is the context that writes pages, so it
  // is the one that says whether the switch is on.
  answer("userScripts", accepting(isUserScriptsAsk), userScripts)

  answer("inspector", accepting(isInspectorAsk), (message, sender) =>
    handleInspector(message, sender).catch(inspectorError)
  )

  // Faces for a package. The worker holds the extension's own host permissions, and it is
  // the only part of Morph that does: the page's network is bound by GitHub's own policy,
  // which refuses an address GitHub never fetches, and the sandbox frame has no network.
  answer("asset", accepting(isAssetAsk), readPackageAsset)

  // A document over the web, for the agent's fetch_url or a skin's window.__beui.fetch.
  // The worker is the one context whose network is not bound by the page's origin.
  answer("fetchWeb", decodeWebAsk, fetchWeb)
  answer("packageCompile", accepting(isPackageCompileAsk), compileLocalPackage)
  answer("publisher", accepting(isPublisherAsk), publisher)
  answer("forkDraft", accepting(isForkDraftAsk), editLocalFork)
  answer("marketplacePreview", accepting(isMarketplacePreviewAsk), (message, sender) =>
    queueMarketplacePreview(message, sender.tab?.id)
  )

  answer("marketplace", accepting(isMarketplaceAsk), async (message, sender) => {
    const answered = await handleMarketplace(message)
    const tabId = sender.tab?.id
    if (
      (answered.type === "packageInstalled" ||
        answered.type === "packageRolledBack" ||
        answered.type === "packageRemoved") &&
      tabId !== undefined
    ) {
      await ask("pagePreview", { type: "clearMarketplacePreview" }, { tabId }).catch(() => {})
    }
    await reloadInstalledPage(answered, tabId, marketplacePage).catch(() => {})
    return answered
  })

  answer("overlaySignal", accepting(isOverlaySignal), (signalled, sender) => {
    const tabId = sender.tab?.id
    if (tabId === undefined) return
    if (signalled.type === "chatReady") void tabs.restore(tabId)
    else void tabs.close(tabId)
  })

  // Teardown for a tab that is already gone: nothing here can be reported to anyone, so
  // a failed write must settle quietly instead of becoming an unhandled rejection.
  chrome.tabs.onRemoved.addListener((tabId) => {
    void Promise.all([
      tabs.close(tabId),
      inspectorStore.clear(tabId),
      panelSessions.clear(tabId)
    ]).catch(() => {})
  })
}
