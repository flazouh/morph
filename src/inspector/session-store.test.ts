import { describe, expect, test } from "bun:test"
import type { ChangeRecord } from "./model"
import {
  INSPECTOR_STORAGE_KEY,
  makeInspectorStore,
  type InspectorStorage
} from "./session-store"

const record = (url: string, after = "16px"): ChangeRecord => ({
  url,
  tailwind: false,
  changes: [
    {
      selector: "#save",
      property: "padding",
      before: "8px",
      after
    }
  ],
  sources: {
    "#save": {
      file: "src/Save.tsx",
      line: 9,
      column: 2,
      component: "Save",
      precision: "authored"
    }
  }
})

const memoryStorage = (initial: unknown = undefined): {
  readonly storage: InspectorStorage
  readonly state: Record<string, unknown>
} => {
  const state: Record<string, unknown> = {}
  if (initial !== undefined) state[INSPECTOR_STORAGE_KEY] = initial
  return {
    state,
    storage: {
      get: async (key) => ({ [key]: state[key] }),
      set: async (items) => {
        Object.assign(state, items)
      }
    }
  }
}

describe("inspector session store", () => {
  test("an empty store has no active record", async () => {
    const { storage } = memoryStorage()
    const store = makeInspectorStore(storage)

    expect(await store.load(7, "https://app.test/settings")).toBeNull()
  })

  test("a saved record loads on the same tab and page", async () => {
    const { storage } = memoryStorage()
    const store = makeInspectorStore(storage)
    const saved = record("https://app.test/settings")

    await store.save(7, saved.url, saved)

    expect(await store.load(7, saved.url)).toEqual(saved)
  })

  test("a page mismatch does not restore the tab record", async () => {
    const { storage } = memoryStorage()
    const store = makeInspectorStore(storage)
    const saved = record("https://app.test/settings")
    await store.save(7, saved.url, saved)

    expect(await store.load(7, "https://app.test/profile")).toBeNull()
  })

  test("a later save replaces the record for that tab", async () => {
    const { storage } = memoryStorage()
    const store = makeInspectorStore(storage)
    const first = record("https://app.test/settings")
    const replacement = record(first.url, "24px")

    await store.save(7, first.url, first)
    await store.save(7, replacement.url, replacement)

    expect(await store.load(7, first.url)).toEqual(replacement)
  })

  test("clear removes the tab record", async () => {
    const { storage } = memoryStorage()
    const store = makeInspectorStore(storage)
    const saved = record("https://app.test/settings")
    await store.save(7, saved.url, saved)

    await store.clear(7)

    expect(await store.load(7, saved.url)).toBeNull()
  })

  test("malformed stored records are rejected at the boundary", async () => {
    const page = "https://app.test/settings"
    const row = { selector: "#save", property: "padding", before: "1px", after: "2px" }
    const stored = (value: unknown) => ({ "7": { page, record: value } })
    const malformed = [
      "bad",
      { "7": null },
      { "7": { page: 42, record: record(page) } },
      stored({ url: page, tailwind: "no", changes: [], sources: {} }),
      // An unsupported property.
      stored({ url: page, tailwind: false, changes: [{ ...row, property: "width" }], sources: {} }),
      // The branch's old experimental shape: source metadata on each change, no record map.
      stored({ url: page, tailwind: false, changes: [{ ...row, source: null }] }),
      // A record map that is missing.
      stored({ url: page, tailwind: false, changes: [row] }),
      // A record map that is not an object.
      stored({ url: page, tailwind: false, changes: [row], sources: [] }),
      // A source entry with a bad field.
      stored({
        url: page,
        tailwind: false,
        changes: [row],
        sources: { "#save": { file: "src/Save.tsx", line: 9, column: 2, component: "Save", precision: "guessed" } }
      }),
      // A source entry that is not an object at all.
      stored({ url: page, tailwind: false, changes: [row], sources: { "#save": "src/Save.tsx" } })
    ]

    for (const value of malformed) {
      const { storage } = memoryStorage(value)
      expect(await makeInspectorStore(storage).load(7, page)).toBeNull()
    }
  })

  test("a record with an empty source map loads", async () => {
    const { storage } = memoryStorage({
      "7": {
        page: "https://app.test/settings",
        record: {
          url: "https://app.test/settings",
          tailwind: false,
          changes: [{ selector: "#save", property: "padding", before: "1px", after: "2px" }],
          sources: {}
        }
      }
    })

    expect(await makeInspectorStore(storage).load(7, "https://app.test/settings")).not.toBeNull()
  })

  test("two tabs on one URL keep separate records", async () => {
    const { storage } = memoryStorage()
    const store = makeInspectorStore(storage)
    const first = record("https://app.test/settings", "12px")
    const second = record(first.url, "20px")

    await store.save(7, first.url, first)
    await store.save(8, second.url, second)

    expect(await store.load(7, first.url)).toEqual(first)
    expect(await store.load(8, second.url)).toEqual(second)
  })

  test("two tabs can save at the same time without losing either record", async () => {
    const { storage } = memoryStorage()
    const store = makeInspectorStore(storage)
    const first = record("https://app.test/settings", "12px")
    const second = record(first.url, "20px")

    await Promise.all([
      store.save(7, first.url, first),
      store.save(8, second.url, second)
    ])

    expect(await store.load(7, first.url)).toEqual(first)
    expect(await store.load(8, second.url)).toEqual(second)
  })
})
