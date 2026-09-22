import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react"
import {
  closeThread as dropThread,
  IDLE_TURN,
  isUntitledThread,
  type RunState,
  type Session,
  type Spend,
  type Step,
  type TurnView,
  type ThreadState,
  type ThreadStore
} from "@/session"
import { NO_SPEND } from "@/agent/spend"
import { siteKey } from "@/agent/page"

const EMPTY: ReadonlyArray<Step> = []
const noop = () => () => {}

export type Opened = { readonly session: Session; readonly error?: undefined } | { readonly session: null; readonly error?: string }

/** Subscribes to "the tab moved to another page"; returns the unsubscribe. */
export type Follow = (onChange: () => void) => () => void

const stay: Follow = () => () => {}

/**
 * Opens the session on mount, and again each time `follow` says the tab is on another
 * page. `session` is `null` while opening; when opening fails (no website in the window,
 * a tab that went away) `error` says why. A session that resolves after a newer opening
 * started is dropped, so the panel never shows the page before.
 */
export const useOpenSession = (open: () => Promise<Session>, follow: Follow = stay, reopenKey?: string): Opened => {
  const [opened, setOpened] = useState<Opened>({ session: null })
  const [generation, setGeneration] = useState(0)
  // Callers pass fresh closures; the latest is read at open time, and identity changes
  // never reopen. Only a page change (the generation) does.
  const latest = useRef({ open, follow })
  latest.current = { open, follow }
  useEffect(() => latest.current.follow(() => setGeneration((g) => g + 1)), [])
  useEffect(() => {
    let live = true
    setOpened({ session: null })
    latest.current.open().then(
      (session) => {
        if (live) setOpened({ session })
      },
      (e: unknown) => {
        if (live) setOpened({ session: null, error: e instanceof Error ? e.message : String(e) })
      }
    )
    return () => {
      live = false
    }
  }, [generation, reopenKey])
  return opened
}

/**
 * Subscribes to a session. The fake and the real session both keep `steps()`
 * referentially stable between changes, so the snapshot needs no copy.
 */
export const useSessionView = (
  session: Session | null
): { steps: ReadonlyArray<Step>; turn: TurnView; state: RunState; spend: Spend } => {
  const subscribe = session?.subscribe ?? noop
  const steps = useSyncExternalStore(subscribe, () => session?.steps() ?? EMPTY)
  const turn = useSyncExternalStore(subscribe, () => session?.turn() ?? IDLE_TURN)
  const state = useSyncExternalStore(subscribe, () => session?.state() ?? "idle")
  const spend = useSyncExternalStore(subscribe, () => session?.spend() ?? NO_SPEND)
  return { steps, turn, state, spend }
}

/**
 * Gives back everything a session held outside the panel, for sessions the panel dropped.
 *
 * A dropped session is not a garbage-collected one. The Cursor proxy holds a listener on
 * the extension channel and a live session in the service worker, and both outlive the
 * panel object that stopped drawing them. So every place that drops a session says so
 * here, and a session with nothing to give back does nothing.
 *
 * One session can sit in the cache under two keys, the requested thread and its own, so
 * the set is what makes one drop one disposal.
 */
const disposeAll = (sessions: Iterable<Session>): void => {
  for (const session of new Set(sessions)) void session.dispose?.()
}

/** Opens the selected site thread and keeps its session, metadata, and tab actions together. */
export const useThreadSession = (
  open: (threadId?: string) => Promise<Session>,
  follow: Follow,
  store: ThreadStore,
  /** The provider in the settings. A change opens the thread again on the other provider. */
  provider?: string
): Opened & {
  readonly steps: ReadonlyArray<Step>
  readonly turn: TurnView
  readonly state: RunState
  readonly spend: Spend
  readonly threads: ThreadState | null
  readonly selectThread: (id: string) => Promise<void>
  readonly newThread: () => Promise<void>
  readonly closeThread: (id: string) => Promise<void>
  readonly nameThread: (firstMessage: string) => void
} => {
  const [requested, setRequested] = useState<string>()
  const [threads, setThreads] = useState<ThreadState | null>(null)
  const sessions = useRef(new Map<string, Session>())
  const threadReadGeneration = useRef(0)
  /**
   * A session belongs to one provider, so a change of provider opens the thread again on
   * the other one. Learning the provider for the first time is not a change: the settings
   * arrive after the first render, and that must not reopen anything.
   */
  const switches = useRef<{ current?: string; count: number }>({ count: 0 })
  if (provider !== undefined && provider !== switches.current.current) {
    const known = switches.current.current !== undefined
    switches.current = { current: provider, count: switches.current.count + (known ? 1 : 0) }
    if (known) {
      // The other provider draws these threads now. A Cursor session left here would keep
      // its run, its socket and its channel listener behind a panel that shows neither.
      disposeAll(sessions.current.values())
      sessions.current = new Map()
    }
  }
  const providerGeneration = switches.current.count
  const latestFollow = useRef(follow)
  latestFollow.current = follow
  const followPage: Follow = useCallback(
    (onChange) =>
      latestFollow.current(() => {
        // Every cached session is about the page before, so none of them is reused.
        disposeAll(sessions.current.values())
        sessions.current = new Map()
        threadReadGeneration.current += 1
        setThreads(null)
        onChange()
      }),
    []
  )
  const opened = useOpenSession(async () => {
    const cache = sessions.current
    const cached = requested === undefined ? undefined : cache.get(requested)
    if (cached !== undefined) return cached
    const session = await open(requested)
    // A session that arrives after the page moved or the provider changed goes in no
    // cache, so nothing will ever draw it or drop it later. It is given back here.
    if (sessions.current === cache) cache.set(session.threadId, session)
    else disposeAll([session])
    return session
  }, followPage, `${providerGeneration}:${requested ?? ""}`)
  const view = useSessionView(opened.session)
  const threadsReady = opened.session !== null && threads !== null && threads.site === siteKey(opened.session.url)

  useEffect(() => {
    const session = opened.session
    if (session === null) return
    let live = true
    const generation = threadReadGeneration.current
    const read = () => {
      void store.state(session.url).then((next) => {
        if (live && generation === threadReadGeneration.current) setThreads(next)
      })
    }
    read()
    const unsubscribe = store.subscribe(read)
    return () => {
      live = false
      unsubscribe()
    }
  }, [opened.session, store])

  useEffect(() => {
    if (
      opened.session !== null &&
      threads !== null &&
      threadsReady &&
      opened.session.threadId !== threads.selected &&
      requested !== threads.selected
    ) {
      threadReadGeneration.current += 1
      setRequested(threads.selected)
    }
  }, [opened.session, requested, threads, threadsReady])

  return {
    ...opened,
    ...view,
    threads,
    selectThread: async (id) => {
      if (threads === null || id === threads.selected) return
      await store.select(threads.site, id)
      setThreads((current) => (current?.site === threads.site ? { ...current, selected: id } : current))
      threadReadGeneration.current += 1
      setRequested(id)
    },
    newThread: async () => {
      if (threads === null) return
      const thread = await store.create(threads.site)
      setThreads((current) => {
        if (current?.site !== threads.site) return current
        const items = current.items.some((item) => item.id === thread.id) ? current.items : [...current.items, thread]
        return { ...current, selected: thread.id, items }
      })
      threadReadGeneration.current += 1
      setRequested(thread.id)
    },
    closeThread: async (id) => {
      if (threads === null) return
      if (opened.session?.threadId === id) await opened.session.clear()
      await dropThread(id)
      const next = await store.remove(threads.site, id)
      const cached = sessions.current.get(id)
      sessions.current.delete(id)
      if (cached !== undefined) disposeAll([cached])
      setThreads(next)
      threadReadGeneration.current += 1
      setRequested(next.selected)
    },
    nameThread: (firstMessage) => {
      const active = threads?.items.find((thread) => thread.id === opened.session?.threadId)
      if (opened.session !== null && threads !== null && isUntitledThread(active)) {
        void store.name(threads.site, opened.session.threadId, firstMessage)
      }
    }
  }
}
