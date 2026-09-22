import { afterEach, expect, test } from "bun:test"
import { DEFAULT_SETTINGS } from "./contract"
import { chromeSettings } from "./settings"

/** A tiny `chrome.storage.local` that reads back one stored value and records writes. */
const stubChrome = (stored: unknown) => {
  const set: Array<Record<string, unknown>> = []
  ;(globalThis as { chrome?: unknown }).chrome = {
    storage: {
      local: {
        get: async () => ({ settings: stored }),
        set: async (value: Record<string, unknown>) => {
          set.push(value)
        }
      },
      onChanged: { addListener: () => {}, removeListener: () => {} }
    }
  }
  return set
}

afterEach(() => {
  delete (globalThis as { chrome?: unknown }).chrome
})

test("an old stored shape reads provider defaults and keeps its OpenRouter model", async () => {
  // The GitHub fields of the removed commit tool may still sit in storage: they are dropped.
  stubChrome({ openRouterKey: "k", model: "m", githubToken: "t", repo: "a/b", visibility: "public" })
  const read = await chromeSettings.read()
  expect("repo" in read).toBe(false)
  expect("githubToken" in read).toBe(false)
  expect(read.theme).toBe(DEFAULT_SETTINGS.theme)
  expect(read.fontSize).toBe(DEFAULT_SETTINGS.fontSize)
  expect(read.openRouterKey).toBe("k")
  expect(read.provider).toBe("openrouter")
  expect(read.cursorKey).toBe("")
  expect(read.model).toBe("m")
  expect(read.cursorModel).toBe(DEFAULT_SETTINGS.cursorModel)
})

test("an unknown theme or font size falls back to the default", async () => {
  stubChrome({ openRouterKey: "kept", theme: "sunset", fontSize: "huge", provider: "future-provider", cursorKey: 42 })
  const read = await chromeSettings.read()
  expect(read.theme).toBe(DEFAULT_SETTINGS.theme)
  expect(read.fontSize).toBe(DEFAULT_SETTINGS.fontSize)
  expect(read.provider).toBe(DEFAULT_SETTINGS.provider)
  expect(read.cursorKey).toBe(DEFAULT_SETTINGS.cursorKey)
  expect(read.openRouterKey).toBe("kept")
})

test("a stored theme and font size read back as stored", async () => {
  stubChrome({ theme: "dark", fontSize: "large" })
  const read = await chromeSettings.read()
  expect(read.theme).toBe("dark")
  expect(read.fontSize).toBe("large")
})

test("a write keeps the theme and font size next to the rest", async () => {
  const set = stubChrome({ theme: "light", fontSize: "small" })
  await chromeSettings.write({ openRouterKey: "sk" })
  expect(set[0]).toEqual({
    settings: { ...DEFAULT_SETTINGS, theme: "light", fontSize: "small", openRouterKey: "sk" }
  })
})
