import { scriptOf, type Kind, type Persisted } from "./persisted"
import { pageKey } from "./scope"

/** What makes a page a Morph page: something of its own runs there. */
export const WEARS_MORPH: ReadonlyArray<Kind> = ["skin", "script", "declarative", "sandbox"]

/** What the reader can see of a thread's own redesign, a plain stylesheet included. */
export const WEARS_REDESIGN: ReadonlyArray<Kind> = ["skin", "script", "style"]

/**
 * The user scripts this extension has registered, remembered in `chrome.storage.local`.
 *
 * Chrome drops `userScripts.register` entries when the extension updates or is reloaded
 * from disk, and asks the extension to register them again on install. So the record of
 * what a page wears lives here, as the CSS or JS itself, and the worker rebuilds and
 * registers it on `onInstalled`, with whatever loader this build has.
 */
const KEY = "registrations"

/**
 * A record as an earlier build stored it: the registration itself, code and all. It is
 * replayed as it was. Every write since stores a Persisted, so these die out as pages are
 * redesigned again or reset.
 */
type Legacy = chrome.userScripts.RegisteredUserScript

type Stored = Persisted | Legacy

const isPersisted = (s: Stored): s is Persisted => "payload" in s

const registrationOf = (s: Stored): chrome.userScripts.RegisteredUserScript => (isPersisted(s) ? scriptOf(s) : s)

const readAll = async (): Promise<Record<string, Stored>> => ((await chrome.storage.local.get(KEY))[KEY] as Record<string, Stored> | undefined) ?? {}

const siteOfRegistration = (id: string): string | undefined => {
  if (!id.startsWith("redesign:")) return undefined
  const separator = id.indexOf(":", "redesign:".length)
  if (separator < 0) return undefined
  try {
    return new URL(id.slice(separator + 1)).origin
  } catch {
    return undefined
  }
}

const replace = async (removeIds: ReadonlyArray<string>, records: ReadonlyArray<Persisted>): Promise<void> => {
  const desired = new Map(records.map((record) => [record.id, record]))
  if (desired.size !== records.length) throw new Error("replacement registration ids must be unique")
  const ids = [...new Set([...removeIds, ...desired.keys()])]
  const previousStored = { ...(await readAll()) }
  const previousLive = ids.length === 0 ? [] : await chrome.userScripts.getScripts({ ids })
  const liveIds = new Set(previousLive.map((script) => script.id))
  const scripts = records.map(scriptOf)
  const updates = scripts.filter((script) => liveIds.has(script.id))
  const additions = scripts.filter((script) => !liveIds.has(script.id))
  const removals = previousLive.filter((script) => !desired.has(script.id)).map((script) => script.id)

  try {
    if (removals.length > 0) await chrome.userScripts.unregister({ ids: removals })
    if (updates.length > 0) await chrome.userScripts.update(updates)
    if (additions.length > 0) await chrome.userScripts.register(additions)
    const next = { ...previousStored }
    for (const id of ids) delete next[id]
    for (const record of records) next[record.id] = record
    await chrome.storage.local.set({ [KEY]: next })
  } catch (cause) {
    try {
      const current = ids.length === 0 ? [] : await chrome.userScripts.getScripts({ ids })
      if (current.length > 0) await chrome.userScripts.unregister({ ids: current.map((script) => script.id) })
      if (previousLive.length > 0) await chrome.userScripts.register(previousLive)
      await chrome.storage.local.set({ [KEY]: previousStored })
    } catch (rollbackCause) {
      throw new AggregateError([cause, rollbackCause], "registration swap and rollback both failed")
    }
    throw cause
  }
}

export const registrations = {
  /** Register (or update) a script now, and remember what it carries for the next install. */
  put: async (record: Persisted): Promise<void> => replace([record.id], [record]),
  /** Unregister and forget the given ids. Unknown ids are fine. */
  remove: async (ids: ReadonlyArray<string>): Promise<void> => replace(ids, []),
  /** Unregister and forget every page and design record for one site origin. */
  removeSite: async (site: string): Promise<void> => {
    const storedIds = Object.keys(await readAll())
    const liveIds = (await chrome.userScripts.getScripts()).map((script) => script.id)
    const ids = [...new Set([...storedIds, ...liveIds])].filter((id) => siteOfRegistration(id) === site)
    await replace(ids, [])
  },
  /** Atomically replace a set of live and stored registrations, with rollback on failure. */
  replace,
  /** Whether this page wears a Morph: by default a skin, a script, a declarative view or a sandbox. */
  wears: async (url: string, kinds: ReadonlyArray<Kind> = WEARS_MORPH): Promise<boolean> => {
    let key: string
    try {
      key = pageKey(url)
    } catch {
      return false
    }
    const ids = Object.keys(await readAll())
    return kinds.some((kind) => ids.includes(`redesign:${kind}:${key}`))
  },
  /** Register everything remembered that is not live, rebuilt by this build. For the worker, after an install or a reload. */
  replay: async (): Promise<number> => {
    if (typeof chrome.userScripts?.register !== "function") return 0
    const all = Object.values(await readAll())
    if (all.length === 0) return 0
    const live = new Set((await chrome.userScripts.getScripts()).map((s) => s.id))
    const missing = all.filter((s) => !live.has(s.id)).map(registrationOf)
    if (missing.length > 0) await chrome.userScripts.register(missing)
    return missing.length
  }
}
