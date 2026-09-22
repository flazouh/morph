/**
 * The parts of a browser the sandbox frame does not have, put back by asking the host.
 *
 * The frame has an opaque origin and the strictest policy Morph can write, which costs a
 * package four ordinary things: `localStorage` throws, a link cannot be followed, history
 * cannot be walked, and no remote image loads. None of that is a package's business to
 * solve. It belongs here, before any package code exists, so every package gets one
 * browser and Morph decides what is in it.
 *
 * Each piece is put back only where the package declared the capability behind it, so a
 * package that never asked for navigation keeps ordinary anchors that do nothing in a
 * sandboxed frame, rather than links Morph follows on its behalf.
 */
import { Effect, type Scope } from "effect"
import type { HostInit } from "./messages"
import type { SandboxRequester } from "./request"

type Lends = HostInit["lends"]

/**
 * Puts a global back the way it was found when the scope closes.
 *
 * The frame outlives no scope in Morph, so in the extension this only ever runs as the
 * page is given back. It matters where a scope is short: a shim left behind would answer
 * for a package that no longer exists.
 */
const standIn = (name: string, value: unknown): Effect.Effect<void, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const found = Object.getOwnPropertyDescriptor(globalThis, name)
      Object.defineProperty(globalThis, name, { value, configurable: true })
      return found
    }),
    (found) =>
      Effect.sync(() => {
        if (found === undefined) delete (globalThis as Record<string, unknown>)[name]
        else Object.defineProperty(globalThis, name, found)
      })
  )

/** Fire and forget. A refusal is the host's answer and there is nothing here to do with it. */
const ask = (
  morph: SandboxRequester,
  capability: string,
  fields: Readonly<Record<string, unknown>>
): void => {
  void Effect.runPromise(morph.request(capability, fields).pipe(Effect.catch(() => Effect.void)))
}

/**
 * A store that looks like `localStorage` and is kept by Morph.
 *
 * Its readers answer their own callers in the same tick, and a Morph request is a message
 * with an answer to wait for. So the whole map is held here, filled once before any
 * package code runs, and written back after each change.
 *
 * One write is in flight at a time and it always carries the current map. Requests are
 * served on their own fibers, so two sends could otherwise land out of order and persist
 * the older of the two.
 */
const installStorage = Effect.fn("sandbox.installGuestStorage")(function* (morph: SandboxRequester) {
  const KEY = "morph.localStorage"
  const held = new Map<string, string>()
  let writing = false
  let again = false

  const send = (): void => {
    writing = true
    void Effect.runPromise(
      morph.request("storage.set", { key: KEY, value: Object.fromEntries(held) }).pipe(
        Effect.catch(() => Effect.void)
      )
    ).then(() => {
      writing = false
      if (!again) return
      again = false
      send()
    })
  }

  const mirror = (): void => {
    if (writing) again = true
    else send()
  }

  const shim = {
    get length(): number {
      return held.size
    },
    clear: (): void => {
      held.clear()
      mirror()
    },
    getItem: (key: string): string | null => held.get(key) ?? null,
    key: (index: number): string | null => [...held.keys()][index] ?? null,
    removeItem: (key: string): void => {
      held.delete(key)
      mirror()
    },
    setItem: (key: string, value: string): void => {
      held.set(key, String(value))
      mirror()
    }
    // A real `Storage` also answers `store.name` and `store.name = value`. Nothing needs
    // that here, and a Proxy to support it would hide which access a package made.
  } as Storage

  const kept = yield* morph.request("storage.get", { key: KEY }).pipe(
    Effect.catch(() => Effect.succeed(undefined))
  )
  if (typeof kept === "object" && kept !== null) {
    for (const [key, value] of Object.entries(kept)) {
      if (typeof value === "string") held.set(key, value)
    }
  }

  // An own property on the window shadows the prototype accessor that throws.
  yield* standIn("localStorage", shim)
})

/**
 * Anchor presses, routed to the host.
 *
 * A frame sandboxed without `allow-top-navigation` cannot follow a link, and the press is
 * refused with nothing to show for it. So the press is read here and the address is handed
 * to Morph, which owns the page the reader is actually on.
 *
 * Relative addresses resolve against that page rather than against the frame, whose own
 * address is an extension URL with a nonce in it and names nothing a reader can visit.
 * Schemes Morph does not perform are left alone, so a `mailto:` behaves as it would
 * anywhere and the press is not cancelled for nothing.
 */
const installLinks = Effect.fn("sandbox.installGuestLinks")(function* (
  morph: SandboxRequester,
  at: string
) {
  const addressOf = (anchor: HTMLAnchorElement): string | undefined => {
    const href = anchor.getAttribute("href")
    if (href === null || href === "" || href.startsWith("#")) return undefined
    try {
      const url = new URL(href, at)
      return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined
    } catch {
      return undefined
    }
  }

  const beside = (event: MouseEvent): boolean =>
    event.button === 1 || event.metaKey || event.ctrlKey || event.shiftKey

  const follow = (event: MouseEvent): void => {
    if (event.defaultPrevented || event.altKey) return
    if (event.button !== 0 && event.button !== 1) return
    const on = event.target
    const anchor = on instanceof Element ? on.closest("a[href]") : null
    if (!(anchor instanceof HTMLAnchorElement)) return
    const url = addressOf(anchor)
    if (url === undefined) return

    event.preventDefault()
    ask(morph, "page.navigate", {
      url,
      target: beside(event) || anchor.target === "_blank" ? "_blank" : "_self"
    })
  }

  yield* Effect.acquireRelease(
    Effect.sync(() => {
      document.addEventListener("click", follow)
      document.addEventListener("auxclick", follow)
    }),
    () =>
      Effect.sync(() => {
        document.removeEventListener("click", follow)
        document.removeEventListener("auxclick", follow)
      })
  )
})

/**
 * Back and forward, asked of the host.
 *
 * The frame shares the tab's session history, so `history.length` counts the pages the
 * reader has been to and a bar built on it shows its arrows for the right reason. Walking
 * it is refused, so the three moves are replaced.
 *
 * `navigation` is removed rather than replaced. It describes this frame and its single
 * entry, which is not where the reader has been, and a package reading it would offer a
 * menu of places that do not exist. Removed, a package falls back to `history`, which
 * answers for the tab.
 *
 * `pushState` and `replaceState` do nothing. The frame's address is not the reader's, and
 * writing a page's path into an opaque-origin document throws.
 */
const installHistory = Effect.fn("sandbox.installGuestHistory")(function* (morph: SandboxRequester) {
  const own = globalThis.history
  const step = (delta: number): void => {
    if (delta === 0) return
    ask(morph, "page.traverse", { delta })
  }
  const shim: History = {
    get length() {
      return own.length
    },
    get scrollRestoration() {
      return own.scrollRestoration
    },
    set scrollRestoration(mode: ScrollRestoration) {
      own.scrollRestoration = mode
    },
    get state() {
      return own.state
    },
    back: () => step(-1),
    forward: () => step(1),
    go: (delta?: number) => step(delta ?? 0),
    pushState: () => {},
    replaceState: () => {}
  }
  yield* standIn("history", shim)
  yield* standIn("navigation", undefined)
})

/** A pixel of nothing, held by an image while the host reads the real one. */
const NOTHING_YET =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"

/**
 * Remote images, fetched by the host and handed back as data.
 *
 * The frame's policy allows no remote image, and it has to stay that way: that policy is
 * one document shared by every package, so an origin opened there is opened for all of
 * them, outside the firewall that is supposed to decide it. Each address goes through
 * `assets.load` instead, where the host checks it against the origins this package
 * declared.
 *
 * The address is caught as it is written, not after. Watching for it and swapping it
 * afterwards was tried and lost a race it cannot win: the browser refuses the address in
 * the same turn, the element's `error` handler runs, and a package that draws an initial
 * when a face is missing has already drawn one before the face arrives. So `src` is a
 * property Morph owns for the length of the frame. A write parks a transparent pixel on
 * the element and asks the host, and the element ends up either with the picture or with
 * the `error` its package was waiting for.
 *
 * Each address is read once and the answer is reused, so a list of a hundred rows showing
 * six faces costs six reads.
 */
const installImages = Effect.fn("sandbox.installGuestImages")(function* (morph: SandboxRequester) {
  const resolved = new Map<string, Promise<string | undefined>>()
  /** What a package last wrote, so it reads back what it wrote rather than the pixel. */
  const wanted = new WeakMap<HTMLImageElement, string>()

  const read = (url: string): Promise<string | undefined> => {
    const already = resolved.get(url)
    if (already !== undefined) return already
    const answer = Effect.runPromise(
      morph.request("assets.load", { url }).pipe(
        Effect.map((value) => (typeof value === "string" ? value : undefined)),
        Effect.catch(() => Effect.succeed(undefined))
      )
    )
    resolved.set(url, answer)
    return answer
  }

  const own = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src")
  /**
   * True while Morph is the one writing.
   *
   * The real `src` setter writes the attribute underneath, which is the same door a
   * package comes through. Without this the pixel Morph parks reads as the package
   * changing its mind, and the address it was holding is dropped.
   */
  let painting = false
  const setSrc = (image: HTMLImageElement, value: string): void => {
    painting = true
    try {
      own?.set?.call(image, value)
    } finally {
      painting = false
    }
  }

  /**
   * Answers a write of `src`, and says whether it took the address over.
   *
   * A local address is none of Morph's business and goes straight through, which keeps the
   * pixel itself and every answer from looping back through here.
   */
  const catchWrite = (image: HTMLImageElement, value: string): boolean => {
    if (!value.startsWith("https:") && !value.startsWith("http:")) return false
    if (wanted.get(image) === value) return true
    wanted.set(image, value)
    setSrc(image, NOTHING_YET)

    void read(value).then((data) => {
      if (wanted.get(image) !== value) return
      if (data === undefined) {
        // What the package was waiting for. Without it, a face that cannot be read is a
        // transparent hole where the package would have drawn an initial.
        image.dispatchEvent(new Event("error"))
        return
      }
      setSrc(image, data)
    })
    return true
  }

  yield* Effect.acquireRelease(
    Effect.sync(() => {
      const setAttribute = HTMLImageElement.prototype.setAttribute
      const getAttribute = HTMLImageElement.prototype.getAttribute

      Object.defineProperty(HTMLImageElement.prototype, "src", {
        configurable: true,
        enumerable: own?.enumerable ?? true,
        get(this: HTMLImageElement) {
          return wanted.get(this) ?? own?.get?.call(this) ?? ""
        },
        set(this: HTMLImageElement, value: string) {
          if (painting || !catchWrite(this, String(value))) {
            if (!painting) wanted.delete(this)
            setSrc(this, String(value))
          }
        }
      })

      // React writes an image's address with `setAttribute`, not with the property.
      HTMLImageElement.prototype.setAttribute = function (name: string, value: string) {
        if (name !== "src" || painting || !catchWrite(this, String(value))) {
          if (name === "src" && !painting) wanted.delete(this)
          setAttribute.call(this, name, value)
        }
      }
      HTMLImageElement.prototype.getAttribute = function (name: string) {
        return name === "src" && wanted.has(this)
          ? (wanted.get(this) ?? null)
          : getAttribute.call(this, name)
      }

      return { setAttribute, getAttribute }
    }),
    (before) =>
      Effect.sync(() => {
        if (own === undefined) delete (HTMLImageElement.prototype as { src?: unknown }).src
        else Object.defineProperty(HTMLImageElement.prototype, "src", own)
        HTMLImageElement.prototype.setAttribute = before.setAttribute
        HTMLImageElement.prototype.getAttribute = before.getAttribute
      })
  )

  // Anything the package drew before this was installed. There should be none: the guest
  // installs the environment before it compiles a package's code.
  for (const image of document.querySelectorAll("img")) {
    const said = own?.get?.call(image)
    if (typeof said === "string") catchWrite(image, said)
  }
})

export const installGuestEnvironment = Effect.fn("sandbox.installGuestEnvironment")(
  function* (
    morph: SandboxRequester,
    lends: Lends,
    at: string
  ): Effect.fn.Return<void, never, Scope.Scope> {
    if (lends.storage) yield* installStorage(morph)
    if (lends.navigate) yield* installLinks(morph, at)
    if (lends.traverse) yield* installHistory(morph)
    if (lends.assets) yield* installImages(morph)
  }
)
