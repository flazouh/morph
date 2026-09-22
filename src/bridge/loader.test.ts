import { afterEach, describe, expect, test } from "bun:test"
import { designScript, GATE, GATE_MS, readyScript, stylesScript } from "./loader"

/**
 * The real page scripts, run against this DOM the way Chrome runs them: as source. A page
 * still loading is a document whose readyState says so; DOMContentLoaded is dispatched by hand.
 */
const run = (code: string): unknown => new Function(`return ${code}`)()
const order = () => Array.from(document.querySelectorAll("style[id^=redesign-]")).map((s) => s.id)
const loading = (is: boolean) => Object.defineProperty(document, "readyState", { value: is ? "loading" : "complete", configurable: true })
const domReady = () => document.dispatchEvent(new Event("DOMContentLoaded"))
const gate = () => document.getElementById(GATE)
const styles = (css: string, gated = true) => stylesScript("redesign-styles", css, gated)
const design = (css: string) => designScript("redesign-design", css, "redesign-palette")
const seen: Array<string> = []
;(globalThis as { seen?: Array<string> }).seen = seen

afterEach(() => {
  document.querySelectorAll("style[id^=redesign-]").forEach((s) => s.remove())
  loading(false)
  seen.length = 0
})

describe("on a loaded page", () => {
  test("styles written before the design still end up last; the design sits after the palette; each sheet is one element", () => {
    const palette = document.createElement("style")
    palette.id = "redesign-palette"
    document.documentElement.prepend(palette)
    run(styles("a{}"))
    run(design(":root{}"))
    expect(order()).toEqual(["redesign-palette", "redesign-design", "redesign-styles"])
    run(styles("b{}"))
    run(design(":root{--x:1}"))
    expect(order()).toEqual(["redesign-palette", "redesign-design", "redesign-styles"])
    expect(document.querySelectorAll("#redesign-styles")).toHaveLength(1)
    expect(document.getElementById("redesign-styles")?.textContent).toBe("b{}")
    expect(gate()).toBeNull()
  })

  test("a second write changes the mounted sheet's text without moving the element", () => {
    run(styles("a{}", false))
    const sheet = document.getElementById("redesign-styles")!
    const watch = new MutationObserver(() => {})
    watch.observe(document.documentElement, { childList: true })

    run(styles("b{}", false))
    const moves = watch.takeRecords()
    watch.disconnect()

    // The inspector rewrites this sheet on every keystroke. Re-appending it takes the
    // element out of the document and puts it back, which every page-level childList
    // observer sees, this module's own selection watcher included.
    expect(moves).toEqual([])
    expect(document.getElementById("redesign-styles")).toBe(sheet)
    expect(sheet.textContent).toBe("b{}")
  })

  test("a sheet the page pushed off the end is moved back last, so it still wins every tie", () => {
    run(styles("a{}", false))
    const sheet = document.getElementById("redesign-styles")!
    const pageSheet = document.createElement("style")
    pageSheet.id = "page-styles"
    document.documentElement.appendChild(pageSheet)

    run(styles("b{}", false))

    expect(document.documentElement.lastElementChild).toBe(sheet)
    expect(sheet.textContent).toBe("b{}")
    expect(document.querySelectorAll("#redesign-styles")).toHaveLength(1)
    pageSheet.remove()
  })

  test("a sheet the page moved into the head is put back as a direct child of html", () => {
    run(styles("a{}", false))
    const sheet = document.getElementById("redesign-styles")!
    document.head.appendChild(sheet)

    run(styles("b{}", false))

    expect(document.getElementById("redesign-styles")?.parentElement).toBe(document.documentElement)
  })

  test("without the palette the design goes first", () => {
    run(design(":root{}"))
    expect(document.documentElement.firstElementChild?.id).toBe("redesign-design")
  })

  test("a script runs at once, in its own function, and returns what it returns", () => {
    expect(run(readyScript("var leaked = 1; return document.title.length + 1", false))).toBe(document.title.length + 1)
    expect((globalThis as { leaked?: unknown }).leaked).toBeUndefined()
    expect(run(readyScript("seen.push('no return')", true))).toBeUndefined()
    expect(seen).toEqual(["no return"])
  })
})

describe("on a page still loading", () => {
  test("the styles go in, the page hides, and at DOMContentLoaded the sheet moves last and the gate comes off", () => {
    loading(true)
    run(styles("a{}"))
    expect(gate()?.textContent).toBe("html{visibility:hidden!important}")
    // The page's own head arrives after our sheet, as it does while parsing.
    const theirs = document.createElement("style")
    theirs.id = "theirs"
    document.documentElement.appendChild(theirs)
    expect(document.documentElement.lastElementChild?.id).toBe("theirs")
    domReady()
    expect(document.documentElement.lastElementChild?.id).toBe("redesign-styles")
    expect(gate()).toBeNull()
    theirs.remove()
  })

  test("the copy applied while the reader watches never hides the page", () => {
    loading(true)
    run(styles("a{}", false))
    expect(gate()).toBeNull()
    domReady()
    expect(document.getElementById("redesign-styles")).not.toBeNull()
  })

  test("a design sheet neither waits nor gates", () => {
    loading(true)
    run(design(":root{}"))
    expect(document.getElementById("redesign-design")).not.toBeNull()
    expect(gate()).toBeNull()
  })

  test("the sheet and the script each hold the gate; it comes off with the last release, whichever ran first", () => {
    loading(true)
    run(readyScript("seen.push('ran')", true))
    run(styles("a{}"))
    expect(gate()?.getAttribute("data-holds")).toBe("2")
    expect(seen).toEqual([])
    domReady()
    expect(seen).toEqual(["ran"])
    expect(gate()).toBeNull()
  })

  test("a script that throws at DOMContentLoaded still releases its hold", () => {
    loading(true)
    run(readyScript("throw new Error('boom')", true))
    expect(gate()?.getAttribute("data-holds")).toBe("1")
    // The listener's error is reported by the event loop, not thrown here.
    domReady()
    expect(gate()).toBeNull()
  })

  test("a page whose DOMContentLoaded is late is shown after the timer, once, and the timer is cancelled by a release", async () => {
    loading(true)
    const fakeTimer = { fn: undefined as (() => void) | undefined, cleared: 0 }
    const realSet = globalThis.setTimeout
    const realClear = globalThis.clearTimeout
    globalThis.setTimeout = ((fn: () => void, ms: number) => {
      expect(ms).toBe(GATE_MS)
      fakeTimer.fn = fn
      return 1 as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout
    globalThis.clearTimeout = (() => {
      fakeTimer.cleared += 1
    }) as typeof clearTimeout
    try {
      run(styles("a{}"))
      fakeTimer.fn?.()
      expect(gate()).toBeNull()
      // DOMContentLoaded after the timer: the sheet still moves last; the gate is not touched twice.
      domReady()
      expect(document.documentElement.lastElementChild?.id).toBe("redesign-styles")
      expect(fakeTimer.cleared).toBe(1)
      // The other way round: DOMContentLoaded first cancels the timer.
      loading(true)
      run(styles("b{}"))
      domReady()
      expect(fakeTimer.cleared).toBe(2)
    } finally {
      globalThis.setTimeout = realSet
      globalThis.clearTimeout = realClear
    }
  })
})
