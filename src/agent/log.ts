import type { Event } from "@clavia/tardigrade/core/event"

/**
 * The durable log: one IndexedDB record per page, holding that page's whole event list.
 *
 * Tardigrade's in-memory host is the driver; this is its memory. After every drive the
 * host's log is written whole, and on open it is seeded back. A record is a few hundred
 * kilobytes at most, so whole writes cost nothing a reader can feel, and there is no
 * partial-write state to reason about.
 */
const DB = "redesign"
const STORE = "logs"

const open = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })

const request = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })

export interface LogStore {
  readonly load: (key: string) => Promise<ReadonlyArray<Event>>
  readonly keys: () => Promise<ReadonlyArray<string>>
  readonly save: (key: string, events: ReadonlyArray<Event>) => Promise<void>
  readonly drop: (key: string) => Promise<void>
}

export const indexedDbLog: LogStore = {
  load: async (key) => {
    const db = await open()
    const value = await request(db.transaction(STORE, "readonly").objectStore(STORE).get(key))
    db.close()
    return Array.isArray(value) ? (value as ReadonlyArray<Event>) : []
  },
  keys: async () => {
    const db = await open()
    const keys = await request(db.transaction(STORE, "readonly").objectStore(STORE).getAllKeys())
    db.close()
    return keys.filter((key): key is string => typeof key === "string")
  },
  save: async (key, events) => {
    const db = await open()
    await request(db.transaction(STORE, "readwrite").objectStore(STORE).put(events, key))
    db.close()
  },
  drop: async (key) => {
    const db = await open()
    await request(db.transaction(STORE, "readwrite").objectStore(STORE).delete(key))
    db.close()
  }
}

export const memoryLog = (): LogStore => {
  const logs = new Map<string, ReadonlyArray<Event>>()
  return {
    load: async (key) => logs.get(key) ?? [],
    keys: async () => [...logs.keys()],
    save: async (key, events) => {
      logs.set(key, events)
    },
    drop: async (key) => {
      logs.delete(key)
    }
  }
}
