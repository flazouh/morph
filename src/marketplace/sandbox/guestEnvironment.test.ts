import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect, Exit, Scope } from "effect"
import { installGuestEnvironment } from "./guestEnvironment"
import { SandboxFailure, type SandboxRequester } from "./request"

interface Asked {
  readonly capability: string
  readonly fields: Readonly<Record<string, unknown>>
}

const NOTHING = { storage: false, navigate: false, traverse: false, assets: false } as const

/** A host that records what it was asked and answers with whatever the test provides. */
const hostThat = (answer: (asked: Asked) => unknown = () => undefined) => {
  const asked: Array<Asked> = []
  const morph: SandboxRequester = {
    request: (capability, fields = {}) =>
      Effect.suspend(() => {
        asked.push({ capability, fields })
        const value = answer({ capability, fields })
        return value instanceof Error
          ? Effect.fail(new SandboxFailure({ message: value.message }))
          : Effect.succeed(value)
      })
  }
  return { asked, morph }
}

const settle = () => new Promise((resume) => setTimeout(resume, 0))

/**
 * One scope per test, closed after it.
 *
 * The environment lives as long as the frame does, so it cannot be installed and torn
 * down inside one call. Holding the scope here keeps each test's shims in place for the
 * length of the test, and closing it proves they are given back.
 */
let living: Scope.Closeable | undefined

const lend = <A>(work: Effect.Effect<A, never, Scope.Scope>): Promise<A> =>
  Effect.runPromise(Effect.provideService(work, Scope.Scope, living as Scope.Closeable))

/**
 * The globals as this file found them, put back after every test.
 *
 * Closing the scope is not enough on its own. A test that stands a fake in front of one
 * of these has the environment record the fake as what was there before, and hand the
 * fake back. The whole suite shares one window, so the next file inherits it.
 */
const own = ["localStorage", "history", "navigation"].map(
  (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const
)

beforeEach(async () => {
  living = await Effect.runPromise(Scope.make())
})

afterEach(async () => {
  if (living !== undefined) await Effect.runPromise(Scope.close(living, Exit.void))
  living = undefined
  for (const [name, descriptor] of own) {
    if (descriptor === undefined) delete (globalThis as Record<string, unknown>)[name]
    else Object.defineProperty(globalThis, name, descriptor)
  }
  document.body.replaceChildren()
})

describe("the browser the guest lends a package", () => {
  test("lends nothing the package did not declare", async () => {
    const before = globalThis.history
    const { asked, morph } = hostThat()
    await lend(installGuestEnvironment(morph, NOTHING, "https://github.com/pulls"))

    expect(asked).toEqual([])
    expect(globalThis.history).toBe(before)
  })

  test("gives the frame back as it found it when the package's scope closes", async () => {
    const before = {
      history: globalThis.history,
      storage: Object.getOwnPropertyDescriptor(globalThis, "localStorage")
    }
    const { asked, morph } = hostThat(() => ({}))
    const all = { storage: true, navigate: true, traverse: true, assets: true }
    await lend(installGuestEnvironment(morph, all, "https://github.com/pulls"))
    expect(globalThis.history).not.toBe(before.history)

    await Effect.runPromise(Scope.close(living as Scope.Closeable, Exit.void))

    expect(globalThis.history).toBe(before.history)
    expect(Object.getOwnPropertyDescriptor(globalThis, "localStorage")).toEqual(before.storage)

    // The listeners went with it: a press after the close asks nothing.
    const anchor = document.createElement("a")
    anchor.setAttribute("href", "https://github.com/flazouh/acepe/pull/1")
    document.body.append(anchor)
    anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }))
    expect(asked.filter((one) => one.capability === "page.navigate")).toEqual([])
  })

  describe("storage", () => {
    const WITH = { ...NOTHING, storage: true }

    test("answers a package in the same tick, out of what the host kept", async () => {
      const { morph } = hostThat(() => ({ "package.scheme": "dark" }))
      await lend(installGuestEnvironment(morph, WITH, "https://github.com/pulls"))

      // Not awaited: a package reads this while it draws its first frame.
      expect(localStorage.getItem("package.scheme")).toBe("dark")
      expect(localStorage.getItem("absent")).toBeNull()
      expect(localStorage.length).toBe(1)
      expect(localStorage.key(0)).toBe("package.scheme")
    })

    test("keeps a written value, and writes the whole map back to the host", async () => {
      const { asked, morph } = hostThat(() => ({}))
      await lend(installGuestEnvironment(morph, WITH, "https://github.com/pulls"))

      localStorage.setItem("a", "1")
      expect(localStorage.getItem("a")).toBe("1")
      await settle()

      const wrote = asked.filter((one) => one.capability === "storage.set")
      expect(wrote.at(-1)?.fields["value"]).toEqual({ a: "1" })
    })

    test("sends the newest map when writes arrive faster than the host answers", async () => {
      const { asked, morph } = hostThat(() => ({}))
      await lend(installGuestEnvironment(morph, WITH, "https://github.com/pulls"))

      localStorage.setItem("a", "1")
      localStorage.setItem("b", "2")
      localStorage.removeItem("a")
      await settle()
      await settle()

      const wrote = asked.filter((one) => one.capability === "storage.set")
      // Fewer sends than changes, and the last one is the map as it now stands.
      expect(wrote.length).toBeLessThan(3)
      expect(wrote.at(-1)?.fields["value"]).toEqual({ b: "2" })
    })

    test("still answers when the host has nothing and when the host refuses", async () => {
      const { morph } = hostThat(() => new Error("storage is not declared"))
      await lend(installGuestEnvironment(morph, WITH, "https://github.com/pulls"))
      expect(localStorage.getItem("anything")).toBeNull()
      expect(() => localStorage.setItem("a", "1")).not.toThrow()
    })
  })

  describe("links", () => {
    const WITH = { ...NOTHING, navigate: true }

    const press = (anchor: HTMLAnchorElement, how: Partial<MouseEventInit> = {}) => {
      const event = new MouseEvent(how.button === 1 ? "auxclick" : "click", {
        bubbles: true,
        cancelable: true,
        button: 0,
        ...how
      })
      anchor.dispatchEvent(event)
      return event
    }

    const anchorTo = (href: string, target?: string): HTMLAnchorElement => {
      const anchor = document.createElement("a")
      anchor.setAttribute("href", href)
      if (target !== undefined) anchor.target = target
      document.body.append(anchor)
      return anchor
    }

    test("hands an address to the host rather than letting the frame fail to follow it", async () => {
      const { asked, morph } = hostThat()
      await lend(installGuestEnvironment(morph, WITH, "https://github.com/pulls"))

      const event = press(anchorTo("https://github.com/flazouh/acepe/pull/1"))
      expect(event.defaultPrevented).toBe(true)
      expect(asked).toEqual([
        {
          capability: "page.navigate",
          fields: { url: "https://github.com/flazouh/acepe/pull/1", target: "_self" }
        }
      ])
    })

    test("resolves a relative address against the page, not against the frame", async () => {
      const { asked, morph } = hostThat()
      await lend(installGuestEnvironment(morph, WITH, "https://github.com/pulls/inbox"))

      press(anchorTo("/flazouh/acepe/pull/2"))
      expect(asked[0]?.fields["url"]).toBe("https://github.com/flazouh/acepe/pull/2")
    })

    test("opens beside the page for a middle press, a modifier, or a blank target", async () => {
      const { asked, morph } = hostThat()
      await lend(installGuestEnvironment(morph, WITH, "https://github.com/pulls"))

      press(anchorTo("https://github.com/a"), { button: 1 })
      press(anchorTo("https://github.com/b"), { metaKey: true })
      press(anchorTo("https://github.com/c"), { ctrlKey: true })
      press(anchorTo("https://github.com/d", "_blank"))

      expect(asked.map((one) => one.fields["target"])).toEqual(["_blank", "_blank", "_blank", "_blank"])
    })

    test("leaves alone what is not a page to go to", async () => {
      const { asked, morph } = hostThat()
      await lend(installGuestEnvironment(morph, WITH, "https://github.com/pulls"))

      for (const href of ["#top", "mailto:a@b.c", "javascript:void 0"]) {
        expect(press(anchorTo(href)).defaultPrevented).toBe(false)
      }
      // A press the package already handled itself.
      const own = anchorTo("https://github.com/e")
      own.addEventListener("click", (event) => event.preventDefault())
      press(own)

      expect(asked).toEqual([])
    })

    test("follows a press on what sits inside the link", async () => {
      const { asked, morph } = hostThat()
      await lend(installGuestEnvironment(morph, WITH, "https://github.com/pulls"))

      const anchor = anchorTo("https://github.com/flazouh/acepe/pull/3")
      const title = document.createElement("span")
      anchor.append(title)
      title.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }))

      expect(asked[0]?.fields["url"]).toBe("https://github.com/flazouh/acepe/pull/3")
    })
  })

  describe("history", () => {
    const WITH = { ...NOTHING, traverse: true }

    test("asks the host to walk the tab, which the frame may not do itself", async () => {
      const { asked, morph } = hostThat()
      await lend(installGuestEnvironment(morph, WITH, "https://github.com/pulls"))

      history.back()
      history.forward()
      history.go(-3)
      history.go()
      history.go(0)

      expect(asked).toEqual([
        { capability: "page.traverse", fields: { delta: -1 } },
        { capability: "page.traverse", fields: { delta: 1 } },
        { capability: "page.traverse", fields: { delta: -3 } }
      ])
    })

    test("still counts the tab's pages, which is what an arrow is drawn from", async () => {
      const { morph } = hostThat()
      const counted = globalThis.history.length
      await lend(installGuestEnvironment(morph, WITH, "https://github.com/pulls"))
      expect(history.length).toBe(counted)
    })

    test("hides the frame's own single entry, so a package falls back to the tab", async () => {
      const { morph } = hostThat()
      Object.defineProperty(globalThis, "navigation", {
        value: { entries: () => [{ url: "chrome-extension://x/sandbox.html" }] },
        configurable: true
      })
      await lend(installGuestEnvironment(morph, WITH, "https://github.com/pulls"))
      expect((globalThis as { navigation?: unknown }).navigation).toBeUndefined()
    })

    test("writes no address, because the frame's is not the reader's", async () => {
      const { asked, morph } = hostThat()
      await lend(installGuestEnvironment(morph, WITH, "https://github.com/pulls"))
      expect(() => history.pushState(null, "", "/pulls/inbox")).not.toThrow()
      expect(() => history.replaceState(null, "", "/pulls/inbox")).not.toThrow()
      expect(asked).toEqual([])
    })
  })

  describe("images", () => {
    const WITH = { ...NOTHING, assets: true }
    const DATA = "data:image/png;base64,iVBORw0KGgo="

    /** What the browser was actually given, past the address the package reads back. */
    const painted = (image: HTMLImageElement): string =>
      image.ownerDocument.createElement("div").appendChild(image.cloneNode(true)) &&
      (image.outerHTML.match(/src="([^"]*)"/)?.[1] ?? "")

    test("holds the address rather than letting the frame try it, then paints what the host read", async () => {
      const { asked, morph } = hostThat(() => DATA)
      await lend(installGuestEnvironment(morph, WITH, "https://github.com/pulls"))

      const image = document.createElement("img")
      image.setAttribute("src", "https://github.com/octocat.png")
      document.body.append(image)

      // Before the answer: the package still reads what it wrote, and the browser has a
      // pixel of nothing, so the address is never fetched and no `error` fires.
      expect(image.getAttribute("src")).toBe("https://github.com/octocat.png")
      expect(painted(image).startsWith("data:image/gif;base64,")).toBe(true)

      await settle()
      expect(painted(image)).toBe(DATA)
      expect(asked).toEqual([
        { capability: "assets.load", fields: { url: "https://github.com/octocat.png" } }
      ])
    })

    test("catches an address written as a property as well as one written as an attribute", async () => {
      const { asked, morph } = hostThat(() => DATA)
      await lend(installGuestEnvironment(morph, WITH, "https://github.com/pulls"))

      const image = document.createElement("img")
      image.src = "https://github.com/octocat.png"
      expect(image.src).toBe("https://github.com/octocat.png")
      await settle()

      expect(painted(image)).toBe(DATA)
      expect(asked.length).toBe(1)
    })

    test("reads an address once, however many rows show it", async () => {
      const { asked, morph } = hostThat(() => DATA)
      await lend(installGuestEnvironment(morph, WITH, "https://github.com/pulls"))

      const drawn: Array<HTMLImageElement> = []
      for (let index = 0; index < 5; index += 1) {
        const image = document.createElement("img")
        image.setAttribute("src", "https://avatars.githubusercontent.com/u/1")
        document.body.append(image)
        drawn.push(image)
      }
      await settle()
      await settle()

      expect(asked.length).toBe(1)
      expect(drawn.map(painted)).toEqual([DATA, DATA, DATA, DATA, DATA])
    })

    test("follows a redraw that writes a different face into the same element", async () => {
      const answers: Record<string, string> = {
        "https://github.com/a.png": "data:image/png;base64,AAAA",
        "https://github.com/b.png": "data:image/png;base64,BBBB"
      }
      const { morph } = hostThat(({ fields }) => answers[String(fields["url"])])
      await lend(installGuestEnvironment(morph, WITH, "https://github.com/pulls"))

      const image = document.createElement("img")
      image.setAttribute("src", "https://github.com/a.png")
      document.body.append(image)
      await settle()
      await settle()
      expect(painted(image)).toBe("data:image/png;base64,AAAA")

      image.setAttribute("src", "https://github.com/b.png")
      await settle()
      await settle()

      expect(painted(image)).toBe("data:image/png;base64,BBBB")
    })

    test("raises the error a package draws its own fallback from", async () => {
      const { morph } = hostThat(() => new Error("asset origin is not declared"))
      await lend(installGuestEnvironment(morph, WITH, "https://github.com/pulls"))

      let broke = false
      const image = document.createElement("img")
      image.addEventListener("error", () => {
        broke = true
      })
      image.setAttribute("src", "https://tracker.example/pixel.png")
      document.body.append(image)
      await settle()
      await settle()

      expect(broke).toBe(true)
    })

    test("asks nothing for what is already data, and paints it at once", async () => {
      const { asked, morph } = hostThat(() => DATA)
      await lend(installGuestEnvironment(morph, WITH, "https://github.com/pulls"))

      const image = document.createElement("img")
      image.setAttribute("src", DATA)
      document.body.append(image)

      expect(painted(image)).toBe(DATA)
      await settle()
      expect(asked).toEqual([])
    })

    test("gives the address back to the browser when the package's scope closes", async () => {
      const { asked, morph } = hostThat(() => DATA)
      await lend(installGuestEnvironment(morph, WITH, "https://github.com/pulls"))
      await Effect.runPromise(Scope.close(living as Scope.Closeable, Exit.void))

      const image = document.createElement("img")
      image.setAttribute("src", "https://github.com/octocat.png")
      await settle()

      expect(painted(image)).toBe("https://github.com/octocat.png")
      expect(asked).toEqual([])
    })
  })
})
