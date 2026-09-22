export interface AsyncCache<Value> {
  get(key: string, load: () => Promise<Value>): Promise<Value>
}

interface CacheEntry<Value> {
  readonly value: Promise<Value>
  expiresAt: number
}

export interface AsyncCacheOptions {
  readonly now: () => number
  readonly ttlMs: number
  readonly maxEntries: number
}

export const makeAsyncCache = <Value>({
  now,
  ttlMs,
  maxEntries
}: AsyncCacheOptions): AsyncCache<Value> => {
  const entries = new Map<string, CacheEntry<Value>>()
  const lifetime = Number.isFinite(ttlMs) && ttlMs >= 0 ? ttlMs : 0
  const limit = Number.isInteger(maxEntries) && maxEntries > 0 ? maxEntries : 1

  return {
    get: (key, load) => {
      const time = now()
      const cached = entries.get(key)
      if (cached !== undefined && cached.expiresAt > time) return cached.value
      if (cached !== undefined) entries.delete(key)

      for (const [storedKey, entry] of entries) {
        if (entry.expiresAt <= time) entries.delete(storedKey)
      }
      while (entries.size >= limit) {
        const oldest = entries.keys().next().value
        if (oldest === undefined) break
        entries.delete(oldest)
      }

      const value = load()
      const entry: CacheEntry<Value> = {
        value,
        expiresAt: Number.POSITIVE_INFINITY
      }
      entries.set(key, entry)
      void value.then(
        () => {
          if (entries.get(key) === entry) entry.expiresAt = now() + lifetime
        },
        () => {
          if (entries.get(key) === entry) entries.delete(key)
        }
      )
      return value
    }
  }
}
