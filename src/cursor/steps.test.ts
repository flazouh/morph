import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { indexedDbCursorSteps } from "./steps"
import { CursorStorageError } from "./state"

/**
 * The IndexedDB step store, against a database that can fail the way a real one does.
 *
 * The failure that matters here is the quiet one. A `put` request succeeds while its
 * transaction is still open, and the transaction can still abort afterwards: a quota
 * check happens at commit, and so does an abort from anywhere else in it. A store that
 * answers on the request calls that a saved history, and the next read finds the old one.
 * So the fake can abort at commit, and the tests hold the store to the commit.
 */

type Mode = "normal" | "abortAtCommit" | "failRequest"

/** Delivers an IndexedDB event the way the real one does: never in the calling turn. */
const later = (deliver: () => void): void => {
  setTimeout(deliver, 0)
}

interface FakeRequest {
  result: unknown
  error: Error | null
  onsuccess: (() => void) | null
  onerror: (() => void) | null
}

const fakeIndexedDb = (mode: Mode, initial: Record<string, unknown> = {}) => {
  const records = new Map<string, unknown>(Object.entries(initial))
  const quota = Object.assign(new Error("the database is full"), {
    name: "QuotaExceededError"
  })

  const request = (work: () => unknown): FakeRequest => {
    const pending: FakeRequest = { result: undefined, error: null, onsuccess: null, onerror: null }
    later(() => {
      if (mode === "failRequest") {
        pending.error = quota
        pending.onerror?.()
        return
      }
      pending.result = work()
      pending.onsuccess?.()
    })
    return pending
  }

  const transaction = (writes: boolean) => {
    const tx = {
      error: null as Error | null,
      oncomplete: null as (() => void) | null,
      onabort: null as (() => void) | null,
      onerror: null as (() => void) | null,
      objectStore: () => ({
        get: (key: string) => request(() => records.get(key)),
        put: (value: unknown, key: string) =>
          request(() => {
            // A write the transaction later abandons never reached the records.
            if (mode === "normal") records.set(key, value)
            return undefined
          }),
        delete: (key: string) =>
          request(() => {
            if (mode === "normal") records.delete(key)
            return undefined
          })
      })
    }
    // The request settles first, then the transaction says whether it kept the write.
    later(() =>
      later(() => {
        if (writes && mode !== "normal") {
          tx.error = quota
          tx.onabort?.()
          return
        }
        tx.oncomplete?.()
      })
    )
    return tx
  }

  return {
    records,
    open: () => {
      const pending = {
        result: {
          objectStoreNames: { contains: () => true },
          createObjectStore: () => undefined,
          transaction: (_store: string, mode: string) => transaction(mode === "readwrite"),
          close: () => undefined
        },
        error: null,
        onsuccess: null as (() => void) | null,
        onerror: null as (() => void) | null,
        onupgradeneeded: null as (() => void) | null
      }
      later(() => pending.onsuccess?.())
      return pending
    }
  }
}

const install = (mode: Mode, initial: Record<string, unknown> = {}) => {
  const db = fakeIndexedDb(mode, initial)
  Object.assign(globalThis, { indexedDB: { open: db.open } })
  return db
}

let before: unknown

beforeEach(() => {
  before = (globalThis as { indexedDB?: unknown }).indexedDB
})

afterEach(() => {
  Object.assign(globalThis, { indexedDB: before })
})

const failure = async <A>(effect: Effect.Effect<A, CursorStorageError>) => {
  const exit = await Effect.runPromiseExit(effect)
  if (Exit.isSuccess(exit)) throw new Error("the store reported success")
  return exit.cause
}

describe("cursor step store", () => {
  test("a saved history reads back whole", async () => {
    install("normal")
    const steps = [{ kind: "user", text: "Restyle it", at: 1 }]
    const read = await Effect.runPromise(
      Effect.andThen(indexedDbCursorSteps.save("thread-1", steps), indexedDbCursorSteps.load("thread-1"))
    )

    expect(read).toEqual(steps)
  })

  test("a save the transaction abandons at commit is a failure, not a saved history", async () => {
    const history = [{ kind: "user", text: "Restyle it", at: 1 }]
    const db = install("abortAtCommit", { "thread-1": history })

    const cause = await failure(
      indexedDbCursorSteps.save("thread-1", [{ kind: "user", text: "Again", at: 9 }])
    )

    expect(String(cause)).toContain("write")
    expect(String(cause)).toContain("QuotaExceededError")
    // The history that was there is the history that is there.
    expect(db.records.get("thread-1")).toEqual(history)
  })

  test("a delete the transaction abandons at commit is a failure", async () => {
    const history = [{ kind: "user", text: "Restyle it", at: 1 }]
    const db = install("abortAtCommit", { "thread-1": history })

    const cause = await failure(indexedDbCursorSteps.drop("thread-1"))

    expect(String(cause)).toContain("drop")
    expect(db.records.get("thread-1")).toEqual(history)
  })

  test("a history the store cannot read is a failure, not an empty one", async () => {
    install("failRequest", { "thread-1": [{ kind: "user", text: "Restyle it", at: 1 }] })

    const cause = await failure(indexedDbCursorSteps.load("thread-1"))

    expect(String(cause)).toContain("read")
  })
})
