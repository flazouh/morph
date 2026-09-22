/**
 * Test-only helpers shared by `host.test.ts` and `host-handoff.test.ts`: opening the
 * card's closed shadow for a test, and reading the session nonce/origin a real page never
 * needs, from public document behavior instead of a shipped test hook.
 */

import type { HostOptions } from "./host"
import { frameOrigin, readPanelNonce } from "./panel-session"

/** A microtask flush: enough for the card's panel-session registration to settle. */
export const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

export interface FakeAttestation {
  readonly registered: ReadonlyArray<string>
  readonly revoked: ReadonlyArray<string>
  /** Pass to any host entry point, so its cards register through this fake. */
  readonly options: HostOptions
  /** Holds every registration until `settle` is called, for a test about ordering. */
  defer(): void
  settle(): void
  fail(reason?: string): void
}

/**
 * The background attestation a card needs before its frame may load, in place of the
 * real `chrome.runtime` round trip, which no page document has here.
 */
export const attestPanelSessions = (): FakeAttestation => {
  const registered: Array<string> = []
  const revoked: Array<string> = []
  let waiting: Array<() => void> = []
  let deferred = false
  let failure: string | null = null

  const fake: FakeAttestation = {
    registered,
    revoked,
    options: {
      attestation: {
        register: async (nonce) => {
          if (deferred) await new Promise<void>((resolve) => waiting.push(resolve))
          if (failure !== null) throw new Error(failure)
          registered.push(nonce)
        },
        revoke: async (nonce) => {
          revoked.push(nonce)
        }
      }
    },
    defer: () => {
      deferred = true
    },
    settle: () => {
      deferred = false
      failure = null
      const pending = waiting
      waiting = []
      for (const release of pending) release()
    },
    fail: (reason = "no panel session") => {
      failure = reason
      deferred = false
      const pending = waiting
      waiting = []
      for (const release of pending) release()
    }
  }

  return fake
}

/** Runs `fn` while `attachShadow` is forced open, so a test can read the closed-shadow host content. */
export const withOpenShadow = async (fn: () => Promise<void> | void): Promise<void> => {
  const original = Element.prototype.attachShadow
  Element.prototype.attachShadow = function (init) {
    return original.call(this, { ...init, mode: "open" })
  }
  try {
    await fn()
  } finally {
    Element.prototype.attachShadow = original
  }
}

/** The host element itself, for a test that needs the card's shadow root. Call inside `withOpenShadow`. */
export const hostOf = (doc: Document = document): HTMLElement => {
  const host = Array.from(doc.documentElement.children).find((el) => el.shadowRoot !== null)
  if (host === undefined) throw new Error("host has no open shadow root; wrap the test in withOpenShadow")
  return host as HTMLElement
}

export const shadowOf = (doc: Document = document): ShadowRoot => hostOf(doc).shadowRoot!

/** A page fixture. `document.head`/`document.body` do not survive a shared `afterEach`, so each test rebuilds them. */
export const pageWith = (html: string, doc: Document = document): HTMLElement => {
  if (doc.head === null) doc.documentElement.append(doc.createElement("head"))
  if (doc.body === null) doc.documentElement.append(doc.createElement("body"))
  const body = doc.body as HTMLBodyElement
  body.innerHTML = html
  return body
}

/**
 * The card's session nonce and origin, read from its iframe `src` the same way the page
 * itself never can: `panelSessionOf` was a shipped test hook and is gone. Call inside
 * `withOpenShadow`, after the card has mounted.
 */
export const sessionOf = (doc: Document = document): { readonly nonce: string; readonly origin: string } | null => {
  const iframe = shadowOf(doc).querySelector("iframe") as HTMLIFrameElement | null
  if (iframe === null || iframe.src === "") return null
  const nonce = readPanelNonce(new URL(iframe.src))
  const origin = frameOrigin(iframe.src)
  if (nonce === null || origin === null) return null
  return { nonce, origin }
}
