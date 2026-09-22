/**
 * One value per browser tab, in a single extension storage key.
 *
 * `chrome.storage.session` stores whole values, so every tab's entry shares one record
 * and a write is a read-modify-write of the whole map. Two tabs writing in the same tick
 * would otherwise read the same snapshot and the second write would drop the first, so
 * writes queue here. A read waits for the queue, so a caller that writes and then reads
 * sees its own write.
 *
 * Storage is also shared with older builds and with anything else that can write the key,
 * so nothing is trusted on the way in: a key that is not a tab id and a value the owner
 * rejects are dropped, and a stored value that is not a map at all reads as empty.
 */

export interface TabMapStorage {
  get(key: string): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
}

export interface TabMap<T> {
  /** The value for `tabId`, or `null`. Waits for any write already in flight. */
  get(tabId: number): Promise<T | null>
  /**
   * Reads the tab's current value and stores what `next` returns for it, with no other
   * write in between. Returning `undefined` removes the entry.
   */
  update(tabId: number, next: (current: T | undefined) => T | undefined): Promise<void>
}

const isTabId = (key: string): boolean => /^\d+$/.test(key)

export const makeTabMap = <T>(
  storage: TabMapStorage,
  key: string,
  isValue: (value: unknown) => value is T
): TabMap<T> => {
  let writes: Promise<void> = Promise.resolve()

  const read = async (): Promise<Record<string, T>> => {
    const stored = (await storage.get(key))[key]
    if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return {}
    return Object.fromEntries(
      Object.entries(stored as Record<string, unknown>).filter(
        (entry): entry is [string, T] => isTabId(entry[0]) && isValue(entry[1])
      )
    )
  }

  return {
    get: async (tabId) => {
      await writes
      return (await read())[String(tabId)] ?? null
    },
    update: (tabId, next) => {
      const operation = writes.then(async () => {
        const values = await read()
        const value = next(values[String(tabId)])
        if (value === undefined) delete values[String(tabId)]
        else values[String(tabId)] = value
        await storage.set({ [key]: values })
      })
      // The caller hears about a failed write; the queue does not, or one full disk
      // would fail every later write for the life of the worker.
      writes = operation.catch(() => {})
      return operation
    }
  }
}
