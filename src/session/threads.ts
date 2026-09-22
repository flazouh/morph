import { pageKey, siteKey } from "../agent/page"
import { isInvalidatedExtensionContext } from "@/extension/context"

const KEY = "chatThreads"
const UNTITLED = new Set(["Current chat", "New chat"])

export type ThreadStatus = "working" | "waiting" | "done" | "failed" | "stopped"

const VALID_STATUSES = new Set<string>(["working", "waiting", "done", "failed", "stopped"])

export interface ChatThread {
  readonly id: string
  readonly title: string
  readonly createdAt: number
  // Crew metadata — optional, backward-compatible
  readonly parentId?: string
  readonly rootId?: string
  readonly agentId?: string
  readonly target?: string
  readonly status?: ThreadStatus
}

export interface CreateChildInput {
  readonly title?: string
  readonly brief?: string
  readonly target?: string
  readonly status?: ThreadStatus
  readonly agentId?: string
}

export const isUntitledThread = (thread: ChatThread | undefined): boolean => thread !== undefined && UNTITLED.has(thread.title)

export interface ThreadState {
  readonly site: string
  readonly selected: string
  readonly items: ReadonlyArray<ChatThread>
}

export interface ThreadStore {
  readonly state: (url: string, legacyLogKeys?: ReadonlyArray<string>) => Promise<ThreadState>
  readonly create: (site: string) => Promise<ChatThread>
  readonly select: (site: string, id: string) => Promise<void>
  readonly name: (site: string, id: string, firstMessage: string) => Promise<void>
  /** Drops a thread. The last one is replaced by a fresh empty chat so a site always has a tab. */
  readonly remove: (site: string, id: string) => Promise<ThreadState>
  /** Creates a child thread for background delegation. Does not change the current selection. */
  readonly createChild: (site: string, parentId: string, input: CreateChildInput) => Promise<ChatThread>
  /** Updates the live status of a thread. */
  readonly status: (site: string, id: string, status: ThreadStatus) => Promise<void>
  readonly subscribe: (listener: () => void) => () => void
}

type SiteThreads = Omit<ThreadState, "site">
type StoredThreads = Readonly<Record<string, SiteThreads>>

interface Storage {
  readonly read: () => Promise<unknown>
  readonly write: (value: StoredThreads) => Promise<void>
  readonly subscribe: (listener: () => void) => () => void
}

const threadOf = (raw: unknown): ChatThread | null => {
  if (raw === null || typeof raw !== "object") return null
  const value = raw as Partial<Record<string, unknown>>
  if (typeof value.id !== "string" || typeof value.title !== "string" || typeof value.createdAt !== "number") return null
  return {
    id: value.id,
    title: value.title,
    createdAt: value.createdAt,
    ...(typeof value.parentId === "string" ? { parentId: value.parentId } : {}),
    ...(typeof value.rootId === "string" ? { rootId: value.rootId } : {}),
    ...(typeof value.agentId === "string" ? { agentId: value.agentId } : {}),
    ...(typeof value.target === "string" ? { target: value.target } : {}),
    ...(typeof value.status === "string" && VALID_STATUSES.has(value.status)
      ? { status: value.status as ThreadStatus }
      : {})
  }
}

/** Returns the IDs of all threads that are descendants of the given thread id. */
const descendantsOf = (items: ReadonlyArray<ChatThread>, rootId: string): ReadonlyArray<string> => {
  const found: string[] = []
  const queue = [rootId]
  while (queue.length > 0) {
    const id = queue.shift()!
    for (const item of items) {
      if (item.parentId === id) {
        found.push(item.id)
        queue.push(item.id)
      }
    }
  }
  return found
}

const storedOf = (raw: unknown): StoredThreads => {
  if (raw === null || typeof raw !== "object") return {}
  return Object.fromEntries(
    Object.entries(raw).flatMap(([site, value]) => {
      if (value === null || typeof value !== "object") return []
      const record = value as { selected?: unknown; items?: unknown }
      const items = Array.isArray(record.items) ? record.items.map(threadOf).filter((item): item is ChatThread => item !== null) : []
      if (typeof record.selected !== "string" || !items.some((item) => item.id === record.selected)) return []
      return [[site, { selected: record.selected, items }]]
    })
  )
}

const titleOf = (message: string): string => {
  const title = message.replace(/\s+/g, " ").trim()
  const characters = [...title]
  if (characters.length <= 25) return title
  return `${characters.slice(0, 24).join("").trimEnd()}…`
}

const legacyTitle = (id: string): string => {
  const path = new URL(id).pathname.replace(/\/+$/, "")
  const segment = path.split("/").at(-1)
  if (segment === undefined || segment === "") return "Home"
  let decoded = segment
  try {
    decoded = decodeURIComponent(segment)
  } catch {
    // A malformed escape can exist in a valid URL. Keep the raw path as a usable label.
  }
  const words = decoded.replace(/[-_]+/g, " ")
  return words.charAt(0).toUpperCase() + words.slice(1)
}

const legacyKeysFor = (site: string, keys: ReadonlyArray<string>): ReadonlyArray<string> =>
  [...new Set(keys)].filter((key) => {
    try {
      return siteKey(key) === site
    } catch {
      return false
    }
  })

const createStore = (storage: Storage, id: () => string, now: () => number): ThreadStore => {
  let pending: Promise<void> = Promise.resolve()
  const mutate = <T>(change: (stored: StoredThreads) => readonly [StoredThreads, T]): Promise<T> => {
    const result = pending.then(async () => {
      const stored = storedOf(await storage.read())
      const [next, answer] = change(stored)
      if (next !== stored) await storage.write(next)
      return answer
    })
    pending = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  return {
    state: async (url, legacyLogKeys = []) => {
      const site = siteKey(url)
      const page = pageKey(url)
      const legacy = legacyKeysFor(site, legacyLogKeys)
      await pending
      const stored = storedOf(await storage.read())
      const current = stored[site]
      if (current !== undefined && legacy.every((key) => current.items.some((item) => item.id === key))) return { site, ...current }
      return mutate((latest) => {
        const existing = latest[site]
        if (existing !== undefined) {
          const missing = legacy.filter((key) => !existing.items.some((item) => item.id === key))
          if (missing.length === 0) return [latest, { site, ...existing }]
          const merged = {
            ...existing,
            items: [...existing.items, ...missing.map((key) => ({ id: key, title: legacyTitle(key), createdAt: now() }))]
          }
          return [{ ...latest, [site]: merged }, { site, ...merged }]
        }
        const items =
          legacy.length > 0
            ? legacy.map((key) => ({ id: key, title: legacyTitle(key), createdAt: now() }))
            : [{ id: page, title: "Current chat", createdAt: now() }]
        const initial = { selected: items.some((item) => item.id === page) ? page : (items[0]?.id ?? page), items }
        return [{ ...latest, [site]: initial }, { site, ...initial }]
      })
    },
    create: (site) =>
      mutate((stored) => {
        const thread = { id: id(), title: "New chat", createdAt: now() }
        const current = stored[site]
        const items = [...(current?.items ?? []), thread]
        return [{ ...stored, [site]: { selected: thread.id, items } }, thread]
      }),
    select: (site, id) =>
      mutate((stored) => {
        const current = stored[site]
        if (current === undefined || current.selected === id || !current.items.some((item) => item.id === id)) return [stored, undefined]
        return [{ ...stored, [site]: { ...current, selected: id } }, undefined]
      }),
    name: (site, id, firstMessage) =>
      mutate((stored) => {
        const current = stored[site]
        const title = titleOf(firstMessage)
        if (current === undefined || title === "") return [stored, undefined]
        const thread = current.items.find((item) => item.id === id)
        if (!isUntitledThread(thread)) return [stored, undefined]
        const items = current.items.map((item) => (item.id === id ? { ...item, title } : item))
        return [{ ...stored, [site]: { ...current, items } }, undefined]
      }),
    remove: (site, threadId) =>
      mutate((stored) => {
        const current = stored[site]
        if (current === undefined) return [stored, { site, selected: threadId, items: [] }]
        const index = current.items.findIndex((item) => item.id === threadId)
        if (index < 0) return [stored, { site, ...current }]
        const toRemove = new Set([threadId, ...descendantsOf(current.items, threadId)])
        const remaining = current.items.filter((item) => !toRemove.has(item.id))
        if (remaining.length === 0) {
          const thread = { id: id(), title: "New chat", createdAt: now() }
          const next = { selected: thread.id, items: [thread] }
          return [{ ...stored, [site]: next }, { site, ...next }]
        }
        // Pick the closest predecessor in the original order that survived removal.
        const predecessor = current.items
          .slice(0, index)
          .reverse()
          .find((item) => !toRemove.has(item.id))
        const neighbor = predecessor?.id ?? remaining[0]!.id
        const selected = toRemove.has(current.selected) ? neighbor : current.selected
        const next = { selected, items: remaining }
        return [{ ...stored, [site]: next }, { site, ...next }]
      }),
    createChild: (site, parentId, input) =>
      mutate((stored) => {
        const current = stored[site]
        if (current === undefined) throw new Error(`No threads found for site: ${site}`)
        const parent = current.items.find((item) => item.id === parentId)
        if (parent === undefined) throw new Error(`Parent thread not found: ${parentId}`)
        const childId = id()
        const thread: ChatThread = {
          id: childId,
          title: input.title ?? "New chat",
          createdAt: now(),
          parentId: parent.id,
          rootId: parent.rootId ?? parent.id,
          agentId: input.agentId ?? childId,
          ...(input.target === undefined ? {} : { target: input.target }),
          ...(input.status === undefined ? {} : { status: input.status })
        }
        const items = [...current.items, thread]
        // Do not change the current selection — delegation runs in the background.
        return [{ ...stored, [site]: { ...current, items } }, thread]
      }),
    status: (site, threadId, newStatus) =>
      mutate((stored) => {
        const current = stored[site]
        if (current === undefined) return [stored, undefined]
        const items = current.items.map((item) => (item.id === threadId ? { ...item, status: newStatus } : item))
        return [{ ...stored, [site]: { ...current, items } }, undefined]
      }),
    subscribe: storage.subscribe
  }
}

/** Reloads an extension page whose old JavaScript survived an unpacked-extension reload. */
export const recoverExtensionContext = async <T>(
  operation: () => Promise<T>,
  reload: () => void = () => {
    if (window.parent === window) {
      location.reload()
      return
    }
    window.parent.postMessage({ type: "reloadChat" }, "*")
  }
): Promise<T> => {
  try {
    return await operation()
  } catch (error) {
    if (!isInvalidatedExtensionContext(error)) throw error
    reload()
    return await new Promise<T>(() => {})
  }
}

const chromeStorage: Storage = {
  read: () => recoverExtensionContext(async () => (await chrome.storage.local.get(KEY))[KEY]),
  write: (value) => recoverExtensionContext(() => chrome.storage.local.set({ [KEY]: value })),
  subscribe: (listener) => {
    const onChange = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (changes[KEY] !== undefined) listener()
    }
    chrome.storage.onChanged.addListener(onChange)
    return () => chrome.storage.onChanged.removeListener(onChange)
  }
}

export const memoryThreads = (id: () => string = () => crypto.randomUUID(), rawInitial?: unknown): ThreadStore => {
  let value: StoredThreads = rawInitial !== undefined ? storedOf(rawInitial) : {}
  let clock = 0
  const listeners = new Set<() => void>()
  return createStore(
    {
      read: async () => value,
      write: async (next) => {
        value = next
        for (const listener of listeners) listener()
      },
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    },
    id,
    () => clock++
  )
}

export const chromeThreads = (): ThreadStore => createStore(chromeStorage, () => crypto.randomUUID(), Date.now)
