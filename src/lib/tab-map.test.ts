import { describe, expect, test } from "bun:test"
import { makeTabMap, type TabMapStorage } from "./tab-map"

const KEY = "things"

const isThing = (value: unknown): value is string => typeof value === "string" && value !== ""

interface Fake {
  readonly state: Record<string, unknown>
  readonly storage: TabMapStorage
  readonly sets: ReadonlyArray<Record<string, unknown>>
  failNextSet(reason: string): void
  holdSets(): void
  releaseSets(): void
}

const fakeStorage = (initial: Record<string, unknown> = {}): Fake => {
  const state: Record<string, unknown> = { ...initial }
  const sets: Array<Record<string, unknown>> = []
  let failure: string | null = null
  let held: Array<() => void> | null = null

  return {
    state,
    sets,
    failNextSet: (reason) => {
      failure = reason
    },
    holdSets: () => {
      held = []
    },
    releaseSets: () => {
      const waiting = held ?? []
      held = null
      for (const release of waiting) release()
    },
    storage: {
      get: async (key) => ({ [key]: state[key] }),
      set: async (items) => {
        if (held !== null) await new Promise<void>((resolve) => held!.push(resolve))
        sets.push(structuredClone(items))
        if (failure !== null) {
          const reason = failure
          failure = null
          throw new Error(reason)
        }
        Object.assign(state, items)
      }
    }
  }
}

describe("tab map", () => {
  test("a value written for a tab reads back for that tab only", async () => {
    const map = makeTabMap(fakeStorage().storage, KEY, isThing)

    await map.update(7, () => "seven")

    expect(await map.get(7)).toBe("seven")
    expect(await map.get(9)).toBe(null)
  })

  test("update sees the current value, so a conditional change is atomic", async () => {
    const map = makeTabMap(fakeStorage().storage, KEY, isThing)
    await map.update(7, () => "first")

    await map.update(7, (current) => (current === "stale" ? undefined : current))
    expect(await map.get(7)).toBe("first")

    await map.update(7, (current) => (current === "first" ? undefined : current))
    expect(await map.get(7)).toBe(null)
  })

  test("keys that are not a tab id, and values the caller rejects, never load", async () => {
    const fake = fakeStorage({
      [KEY]: {
        "7": "seven",
        "-1": "negative",
        "1.5": "fractional",
        abc: "named",
        "9": 42,
        "11": ""
      }
    })
    const map = makeTabMap(fake.storage, KEY, isThing)

    expect(await map.get(7)).toBe("seven")
    for (const tabId of [-1, 9, 11]) expect(await map.get(tabId)).toBe(null)

    // The rejected entries are dropped rather than carried forward by the next write.
    await map.update(3, () => "three")
    expect(fake.state[KEY]).toEqual({ "7": "seven", "3": "three" })
  })

  test("a stored value that is not a map at all reads as empty", async () => {
    for (const stored of [null, "text", 7, ["7", "nine"]]) {
      const map = makeTabMap(fakeStorage({ [KEY]: stored }).storage, KEY, isThing)
      expect(await map.get(7)).toBe(null)
    }
  })

  test("two tabs writing in the same tick both survive", async () => {
    const fake = fakeStorage()
    const map = makeTabMap(fake.storage, KEY, isThing)

    await Promise.all([map.update(7, () => "seven"), map.update(9, () => "nine")])

    expect(fake.state[KEY]).toEqual({ "7": "seven", "9": "nine" })
  })

  test("a write that rejects reaches its caller and leaves the queue usable", async () => {
    const fake = fakeStorage()
    const map = makeTabMap(fake.storage, KEY, isThing)
    fake.failNextSet("storage is full")

    await expect(map.update(7, () => "seven")).rejects.toThrow("storage is full")

    await map.update(9, () => "nine")
    expect(fake.state[KEY]).toEqual({ "9": "nine" })
  })

  test("a read waits for a write that is already in flight", async () => {
    const fake = fakeStorage()
    const map = makeTabMap(fake.storage, KEY, isThing)
    fake.holdSets()

    const written = map.update(7, () => "seven")
    const read = map.get(7)
    let readFirst = false
    void read.then(() => {
      readFirst = true
    })
    await Promise.resolve()
    expect(readFirst).toBe(false)

    fake.releaseSets()
    await written
    expect(await read).toBe("seven")
  })
})
