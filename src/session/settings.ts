import { Effect, Schema } from "effect"
import { DEFAULT_SETTINGS, SettingsSchema, type Settings, type SettingsStore } from "./contract"

const KEY = "settings"

/**
 * Settings live in `chrome.storage.local`: the key never leaves the machine and
 * survives the panel closing. Unknown stored fields are dropped, missing ones take
 * the default, so an older stored shape still reads.
 */
const decodeSettings = Schema.decodeUnknownSync(SettingsSchema)
const encodeSettings = Schema.encodeUnknownEffect(SettingsSchema)

const shape = (raw: unknown): Settings => decodeSettings(raw ?? {})

export const chromeSettings: SettingsStore = {
  read: async () => shape((await chrome.storage.local.get(KEY))[KEY]),
  write: async (patch) => {
    const next = { ...shape((await chrome.storage.local.get(KEY))[KEY]), ...patch }
    const encoded = await Effect.runPromise(encodeSettings(next))
    await chrome.storage.local.set({ [KEY]: encoded })
    return next
  },
  subscribe: (listener) => {
    const on = (changes: Record<string, chrome.storage.StorageChange>) => {
      const change = changes[KEY]
      if (change !== undefined) listener(shape(change.newValue))
    }
    chrome.storage.onChanged.addListener(on)
    return () => chrome.storage.onChanged.removeListener(on)
  }
}

/** In-memory store for tests and for the panel built against a fake. */
export const memorySettings = (initial: Partial<Settings> = {}): SettingsStore => {
  let current: Settings = { ...DEFAULT_SETTINGS, ...initial }
  const listeners = new Set<(settings: Settings) => void>()
  return {
    read: async () => current,
    write: async (patch) => {
      current = { ...current, ...patch }
      for (const l of listeners) l(current)
      return current
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}
