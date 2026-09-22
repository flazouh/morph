import { indexedDbLog } from "../agent/log"
import { pageKey } from "../agent/page"
import { ask } from "../bridge/messaging"
import { alwaysOnUserScriptsGate, chromeUserScriptsGate, type UserScriptsGate } from "../bridge/user-scripts"
import { closeCursorThread, chromeCursorPort, cursorProxySession } from "../cursor/proxy"
import type { Session, SettingsStore } from "./contract"
import { openProviderSession } from "./factory"
import { fakeSession } from "./fake"
import { realSession } from "./real"
import { chromeSettings, memorySettings } from "./settings"
import { chromeThreads, memoryThreads, type ThreadState } from "./threads"
import { chromeSkills, memorySkills } from "../skills/store"
import { browserCompilerPorts } from "../marketplace/compiler/browserPorts"
import { compilePackage } from "../marketplace/compiler/compile"
import { compilePagePackage } from "../marketplace/compiler/page"
import { icons } from "../skin/icons"
import { sheets } from "../skin/sheets"
import { createExtensionForkDrafts } from "../marketplace/extension"
import { loadForkParent } from "../marketplace/forks/source"
import type { ForkParent } from "../marketplace/forks/model"
import { chromeLibraryMemory } from "../marketplace/library"
import { installedReleaseOn } from "../marketplace/sandbox/installed"
import { createExtensionPublisher } from "../marketplace/publishing/extension"
import { createCrewSessions } from "./crew"
import { forgetPageOf, forgetSiteOf, worldFor, type PageTab } from "./world"
import type { ForkToolContext } from "../agent/tools"

export type {
  FontSize,
  Provider,
  RunState,
  Session,
  Settings,
  SettingsStore,
  Spend,
  Step,
  ThemeChoice,
  ToolStep,
  TurnPhase,
  TurnView
} from "./contract"
export type { ChatThread, ThreadState, ThreadStore } from "./threads"
export type { UserScriptsGate } from "../bridge/user-scripts"
export { DEFAULT_SETTINGS, IDLE_TURN } from "./contract"
export { isUntitledThread } from "./threads"
export { indexedDbLog } from "../agent/log"

const inExtension = typeof chrome !== "undefined" && chrome.storage !== undefined
const forkParents = new Map<string, Promise<ForkParent>>()
const forkParent = (
  key: string,
  load: () => Promise<ForkParent>
): Promise<ForkParent> => {
  const existing = forkParents.get(key)
  if (existing !== undefined) return existing
  const loading = load()
  forkParents.set(key, loading)
  void loading.catch(() => {
    if (forkParents.get(key) === loading) forkParents.delete(key)
  })
  return loading
}

export const settings: SettingsStore = inExtension ? chromeSettings : memorySettings()
export const skills = inExtension ? chromeSkills : memorySkills()
export const threads = inExtension ? chromeThreads() : memoryThreads()
/** Outside the extension there is no switch to turn on, so the card never asks. */
export const userScripts: UserScriptsGate = inExtension ? chromeUserScriptsGate : alwaysOnUserScriptsGate

const crewSessions = createCrewSessions({
  threads,
  // A crew bot is an OpenRouter thing: only that provider has the tools that spawn one.
  open: async (threadId, page) => {
    const selected = await threadOn(page, threadId)
    if (selected.threadId !== threadId) throw new Error(`chat thread "${threadId}" is not on ${selected.state.site}`)
    return openRouterSessionFor(page, selected.state, threadId)
  },
  send: async (tabId, message) => {
    await ask("crew", message, { tabId })
  }
})

export const stopCrews = (): Promise<void> => crewSessions.stop()

if (inExtension) {
  window.addEventListener("pagehide", () => {
    void stopCrews()
  })
}

const isWebsite = (tab: chrome.tabs.Tab): tab is chrome.tabs.Tab & { id: number; url: string } =>
  tab.id !== undefined && tab.url !== undefined && /^https?:/.test(tab.url)

/**
 * The page this panel is about: the active tab when it is a website. When the active tab
 * is not one (this panel opened as a tab, a chrome:// page), the most recently used
 * website in the window stands in, so the panel works wherever it is drawn.
 */
export const activeTab = async (): Promise<{ readonly id: number; readonly url: string }> => {
  const tabs = await chrome.tabs.query({ currentWindow: true })
  const active = tabs.find((t) => t.active)
  const chosen =
    active !== undefined && isWebsite(active)
      ? active
      : tabs.filter(isWebsite).sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0]
  if (chosen === undefined) throw new Error("no website is open in this window; open one and try again")
  return { id: chosen.id, url: chosen.url }
}

/**
 * Calls `onChange` when the tab this panel is beside moves to another page: a link
 * followed, an address typed, a soft navigation that changes the path. The panel then
 * opens the session for the new page. A hash change or a reload keeps the page and is not
 * a change. Returns the unsubscribe. Outside the extension there is no tab to follow.
 */
export const followPage = (onChange: () => void): (() => void) => {
  if (!inExtension) return () => {}
  let stop = false
  let off: (() => void) | undefined
  void activeTab().then(({ id, url }) => {
    if (stop) return
    let key = pageKey(url)
    const listener = (tabId: number, info: chrome.tabs.OnUpdatedInfo) => {
      if (tabId !== id || info.url === undefined) return
      const next = pageKey(info.url)
      if (next === key) return
      key = next
      void stopCrews().finally(onChange)
    }
    chrome.tabs.onUpdated.addListener(listener)
    off = () => chrome.tabs.onUpdated.removeListener(listener)
  })
  return () => {
    stop = true
    off?.()
  }
}

/**
 * The installed marketplace release this page runs, as something the chat can change: its
 * compiled parent, a place for drafts, and the publisher that releases one. Absent when
 * the page runs no sandbox release.
 */
/**
 * The installed Morph this page runs, loaded as something the thread may change. Both
 * runtimes can be forked: a sandbox program rebuilds with the sandbox compiler, a page
 * package with the page one, and each is checked against the release it came from.
 */
const forkOn = async (tab: PageTab): Promise<ForkToolContext | undefined> => {
  const installed = installedReleaseOn(await chromeLibraryMemory.read(), new URL(tab.url))
  const runtime = installed?.detail.manifest.runtime
  if (installed === undefined || (runtime !== "sandbox-v1" && runtime !== "script-v1")) return undefined
  const key = `${installed.slug}@${installed.version}#${installed.detail.source.commit}`
  const parent = await forkParent(key, () =>
    loadForkParent(installed, fetch, (source) =>
      runtime === "script-v1"
        ? compilePagePackage(source, { sheets, icons })
        : compilePackage(source, browserCompilerPorts)
    )
  )
  return {
    parent,
    drafts: createExtensionForkDrafts(undefined, tab.id),
    publisher: createExtensionPublisher(undefined, tab.id)
  }
}

/** The thread a request lands on: the one asked for, when the site still has it. */
const threadOn = async (
  tab: PageTab,
  requestedThread?: string
): Promise<{ readonly state: ThreadState; readonly threadId: string }> => {
  const state = await threads.state(tab.url, await indexedDbLog.keys())
  const exists = requestedThread !== undefined && state.items.some((item) => item.id === requestedThread)
  return { state, threadId: exists ? requestedThread : state.selected }
}

/**
 * The session for the tab this panel is beside. Outside the extension (tests, a dev
 * page) it is the fake, so the panel runs anywhere.
 */
async function openSessionFor(tab: PageTab, requestedThread?: string): Promise<Session> {
  const { state, threadId } = await threadOn(tab, requestedThread)
  return openProviderSession(await settings.read(), {
    openrouter: () => openRouterSessionFor(tab, state, threadId),
    // The run itself lives in the service worker; this side only draws it and sends to it.
    cursor: () => cursorProxySession(chromeCursorPort, { threadId, url: tab.url, tabId: tab.id })
  })
}

/**
 * The OpenRouter session for one thread, with everything that provider alone brings: the
 * crew this thread belongs to, the installed marketplace release it may fork, and the
 * reader's design skills.
 */
async function openRouterSessionFor(
  tab: PageTab,
  state: ThreadState,
  threadId: string
): Promise<Session> {
  const thread = state.items.find((item) => item.id === threadId)!
  const prepared = crewSessions.prepare(tab, state, thread)
  if (prepared.cached !== undefined) return prepared.cached
  const read = () => settings.read()
  const fork = await forkOn(tab)
  const session = await realSession({
    url: tab.url,
    threadId,
    settings: read,
    skills: skills.read,
    world: worldFor(tab),
    logs: indexedDbLog,
    ...(fork === undefined ? { publisher: createExtensionPublisher(undefined, tab.id) } : { fork }),
    ...(prepared.context === undefined ? {} : { crew: prepared.context }),
    forget: () => forgetPageOf(tab),
    forgetSite: () => forgetSiteOf(tab)
  })
  crewSessions.remember(tab.url, threadId, session)
  return session
}

export const openSession = async (requestedThread?: string): Promise<Session> => {
  if (!inExtension) return fakeSession()
  return openSessionFor(await activeTab(), requestedThread)
}

/**
 * The reader closed a thread. Both provider histories go, and the Cursor agent with them,
 * whichever provider the thread was last used with.
 */
export const closeThread = async (threadId: string): Promise<void> => {
  // A store that is not there (a test page, a browser without IndexedDB) has nothing to
  // drop, and must not stop the rest of the close.
  await indexedDbLog.drop(threadId).catch(() => undefined)
  if (inExtension) await closeCursorThread(chromeCursorPort, threadId).catch(() => undefined)
}
