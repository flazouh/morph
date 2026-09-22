/**
 * Where a Cursor thread's step history lives: one IndexedDB record per thread.
 *
 * The history is the transcript a reopened panel draws, so it grows with the thread and
 * a busy one runs to megabytes. `chrome.storage.local` holds ten megabytes for the whole
 * extension in one shared object, so a step log kept there is a quota failure waiting for
 * the reader who uses Morph most, and one that would take every other thread down with
 * it. This follows the durable log's pattern instead: an object store keyed by thread,
 * written whole, so one thread's history is one record and no thread shares another's.
 *
 * A write that fails must not take the run with it. Every operation answers with a safe
 * failure the store turns into a diagnostic, and the Session keeps working from memory.
 */

import { Effect, Layer } from "effect"
import {
  chromeCursorStorage,
  CursorStorageError,
  cursorStoreLayer,
  type CursorStepStorage,
  type CursorStore
} from "./state"

const DB = "morph-cursor"
const STORE = "steps"

const open = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })

const settled = <A>(request: IDBRequest<A>): Promise<A> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })

/** A transaction that stopped without an error of its own. */
class Abandoned extends Error {
  override readonly name = "AbortError"
}

/**
 * Runs a change and answers when the transaction commits, not when its request succeeds.
 *
 * `IDBRequest.onsuccess` fires while the transaction is still open. The quota check
 * happens at commit, and so does an abort from anywhere else in the transaction, so a
 * request that succeeded can still leave nothing behind. Only `oncomplete` means the
 * change is in the database, and a store that answers any earlier tells the caller its
 * history is saved when the old one is still there.
 */
const committed = (
  db: IDBDatabase,
  change: (store: IDBObjectStore) => IDBRequest
): Promise<void> =>
  new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite")
    let request: IDBRequest | undefined
    // `transaction.error` is null when something called `abort()`, so the request's own
    // error is the better name whenever there is one.
    const stop = () => reject(transaction.error ?? request?.error ?? new Abandoned())
    transaction.oncomplete = () => resolve()
    transaction.onabort = stop
    transaction.onerror = stop
    try {
      request = change(transaction.objectStore(STORE))
    } catch (error) {
      reject(error)
    }
  })

/**
 * The name of what went wrong, and nothing else. A `DOMException` message can quote the
 * value it choked on, and that value is the reader's page.
 */
const nameOf = (error: unknown): string =>
  error instanceof Error && error.name !== "" ? error.name : "unknown"

const attempt = <A>(
  operation: CursorStorageError["operation"],
  work: () => Promise<A>
): Effect.Effect<A, CursorStorageError> =>
  Effect.tryPromise({
    try: work,
    catch: (error) => new CursorStorageError({ operation, detail: nameOf(error) })
  })

export const indexedDbCursorSteps: CursorStepStorage = {
  load: (threadId) =>
    attempt("read", async () => {
      const db = await open()
      try {
        return await settled(db.transaction(STORE, "readonly").objectStore(STORE).get(threadId))
      } finally {
        db.close()
      }
    }),
  save: (threadId, steps) =>
    attempt("write", async () => {
      const db = await open()
      try {
        await committed(db, (store) => store.put(steps, threadId))
      } finally {
        db.close()
      }
    }),
  drop: (threadId) =>
    attempt("drop", async () => {
      const db = await open()
      try {
        await committed(db, (store) => store.delete(threadId))
      } finally {
        db.close()
      }
    })
}

/**
 * The store the service worker runs: small metadata in `chrome.storage.local`, step
 * history in IndexedDB. A failure on either side is a warning in the worker's own log,
 * never a step the reader reads, and never the page's text.
 */
export const chromeCursorStore: Layer.Layer<CursorStore> = cursorStoreLayer(chromeCursorStorage, {
  steps: indexedDbCursorSteps
})
