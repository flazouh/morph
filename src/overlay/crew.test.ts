import { afterEach, beforeAll, describe, expect, test } from "bun:test"
import {
  clearCrewBots,
  crewBotsOf,
  setCrewBots,
  setCrewBotsHidden,
  _crewShadowOf,
  type CrewBotView,
} from "./crew"

// happy-dom returns 0 for window.innerWidth/innerHeight; set realistic values
// so viewport clamping works as in a real browser.
beforeAll(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1200 })
  Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 800 })
})

afterEach(() => {
  clearCrewBots(document)
  document.documentElement.replaceChildren()
})

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Find the overlay host element in the light DOM. */
function findHost(): HTMLElement | null {
  return document.querySelector("[data-morph-crew]") as HTMLElement | null
}

/**
 * Give a target element a non-zero bounding rect so resolveTarget
 * considers it visible. happy-dom does not do layout, so all rects are 0×0.
 */
function mockRect(el: Element, overrides: Partial<DOMRect> = {}): void {
  const base: DOMRect = {
    width: 100, height: 50,
    top: 100, right: 200, bottom: 150, left: 100,
    x: 100, y: 100,
    toJSON: () => ({}),
  }
  el.getBoundingClientRect = () => ({ ...base, ...overrides } as DOMRect)
}

/** Create a target div, append it to documentElement, and return it. */
function makeTarget(id: string): HTMLElement {
  const el = document.createElement("div")
  el.id = id
  // Append to documentElement directly: afterEach calls replaceChildren() which
  // removes <body>, so document.body may be null in subsequent tests.
  document.documentElement.append(el)
  return el
}

const ONE_BOT: CrewBotView = { id: "b1", selector: "#target", status: "working" }

// ─── empty ───────────────────────────────────────────────────────────────────

describe("empty", () => {
  test("setCrewBots([]) adds no host element", () => {
    setCrewBots(document, window, [])
    expect(findHost()).toBeNull()
  })

  test("crewBotsOf returns [] when nothing is mounted", () => {
    expect(crewBotsOf(document)).toHaveLength(0)
  })

  test("empty list after already-active crew removes host", () => {
    const t = makeTarget("target")
    mockRect(t)
    setCrewBots(document, window, [ONE_BOT])
    expect(findHost()).not.toBeNull()

    setCrewBots(document, window, [])
    expect(findHost()).toBeNull()
    expect(crewBotsOf(document)).toHaveLength(0)
  })
})

// ─── one bot ─────────────────────────────────────────────────────────────────

describe("one bot", () => {
  test("stores the view and adds the host", () => {
    const t = makeTarget("target")
    mockRect(t)
    setCrewBots(document, window, [ONE_BOT])

    expect(crewBotsOf(document)).toHaveLength(1)
    expect(crewBotsOf(document)[0]).toEqual(ONE_BOT)
    expect(findHost()).not.toBeNull()
  })

  test("host is position:fixed and pointer-events:none", () => {
    const t = makeTarget("target")
    mockRect(t)
    setCrewBots(document, window, [ONE_BOT])

    const host = findHost()!
    expect(host.style.position).toBe("fixed")
    expect(host.style.pointerEvents).toBe("none")
  })

  test("host uses a closed shadow (shadowRoot is null on the element)", () => {
    const t = makeTarget("target")
    mockRect(t)
    setCrewBots(document, window, [ONE_BOT])

    // Closed shadow: shadowRoot is null on the element.
    expect(findHost()!.shadowRoot).toBeNull()
    // But the internal accessor still works.
    expect(_crewShadowOf(document)).not.toBeNull()
  })
})

// ─── many bots ───────────────────────────────────────────────────────────────

describe("many bots", () => {
  test("stores all views in order", () => {
    const views: CrewBotView[] = [
      { id: "a", selector: "#a", status: "working" },
      { id: "b", selector: "#b", status: "waiting" },
      { id: "c", selector: "#c", status: "done" },
    ]
    setCrewBots(document, window, views)

    const stored = crewBotsOf(document)
    expect(stored).toHaveLength(3)
    expect(stored.map(v => v.id)).toEqual(["a", "b", "c"])
  })

  test("second setCrewBots call replaces the first and leaves one host", () => {
    setCrewBots(document, window, [ONE_BOT])
    const next: CrewBotView = { id: "b2", selector: "#other", status: "done" }
    setCrewBots(document, window, [next])

    expect(crewBotsOf(document)).toHaveLength(1)
    expect(crewBotsOf(document)[0]!.id).toBe("b2")
    expect(document.querySelectorAll("[data-morph-crew]")).toHaveLength(1)
  })

  test("each bot has its own element in the shadow", () => {
    const views: CrewBotView[] = [
      { id: "x", selector: "#missing-x", status: "working" },
      { id: "y", selector: "#missing-y", status: "waiting" },
    ]
    setCrewBots(document, window, views)

    const shadow = _crewShadowOf(document)!
    expect(shadow.querySelector("[data-bot-id=x]")).not.toBeNull()
    expect(shadow.querySelector("[data-bot-id=y]")).not.toBeNull()
  })
})

// ─── selector resolution ─────────────────────────────────────────────────────

describe("invalid selector", () => {
  test("does not throw", () => {
    const view: CrewBotView = { id: "iv", selector: "###bad###", status: "working" }
    expect(() => setCrewBots(document, window, [view])).not.toThrow()
  })

  test("view is still stored in crewBotsOf", () => {
    const view: CrewBotView = { id: "iv", selector: "###bad###", status: "working" }
    setCrewBots(document, window, [view])
    expect(crewBotsOf(document)).toHaveLength(1)
  })

  test("bot element stays hidden", () => {
    const view: CrewBotView = { id: "iv", selector: "###bad###", status: "working" }
    setCrewBots(document, window, [view])
    const el = _crewShadowOf(document)!.querySelector("[data-bot-id=iv]") as HTMLElement
    expect(el.style.display).toBe("none")
  })
})

describe("missing selector target", () => {
  test("bot element stays hidden when target does not exist", () => {
    const view: CrewBotView = { id: "ms", selector: "#no-such-element", status: "waiting" }
    setCrewBots(document, window, [view])
    const el = _crewShadowOf(document)!.querySelector("[data-bot-id=ms]") as HTMLElement
    expect(el.style.display).toBe("none")
  })
})

describe("hidden target", () => {
  test("display:none target keeps bot hidden", () => {
    const t = makeTarget("ht")
    t.style.display = "none"
    mockRect(t)
    const view: CrewBotView = { id: "ht", selector: "#ht", status: "working" }
    setCrewBots(document, window, [view])
    const el = _crewShadowOf(document)!.querySelector("[data-bot-id=ht]") as HTMLElement
    expect(el.style.display).toBe("none")
  })

  test("visibility:hidden target keeps bot hidden", () => {
    const t = makeTarget("vh")
    t.style.visibility = "hidden"
    mockRect(t)
    const view: CrewBotView = { id: "vh", selector: "#vh", status: "working" }
    setCrewBots(document, window, [view])
    const el = _crewShadowOf(document)!.querySelector("[data-bot-id=vh]") as HTMLElement
    expect(el.style.display).toBe("none")
  })
})

describe("zero-size target", () => {
  test("zero-size target (no mockRect) keeps bot hidden", () => {
    // happy-dom returns 0×0 for all getBoundingClientRect; do not mock.
    makeTarget("zt")
    const view: CrewBotView = { id: "zt", selector: "#zt", status: "done" }
    setCrewBots(document, window, [view])
    const el = _crewShadowOf(document)!.querySelector("[data-bot-id=zt]") as HTMLElement
    expect(el.style.display).toBe("none")
  })
})

// ─── positioning ─────────────────────────────────────────────────────────────

describe("positioning", () => {
  test("bot anchors near target top-right: left = right − BOT_SIZE/2", () => {
    const t = makeTarget("target")
    mockRect(t, { right: 200, top: 100, width: 100, height: 50, bottom: 150, left: 100 })
    setCrewBots(document, window, [ONE_BOT])

    const el = _crewShadowOf(document)!.querySelector("[data-bot-id=b1]") as HTMLElement
    // x = 200 − 18 = 182, y = 100 − 18 = 82
    expect(el.style.left).toBe("182px")
    expect(el.style.top).toBe("82px")
    expect(el.style.display).toBe("flex")
  })

  test("clamps x to 0 when target is near left viewport edge", () => {
    const t = makeTarget("target")
    // right=5 → x = 5 − 18 = −13 → clamped to 0
    mockRect(t, { right: 5, top: 100, width: 5, height: 50, bottom: 150, left: 0 })
    setCrewBots(document, window, [ONE_BOT])

    const el = _crewShadowOf(document)!.querySelector("[data-bot-id=b1]") as HTMLElement
    expect(el.style.left).toBe("0px")
  })

  test("clamps y to 0 when target is near top viewport edge", () => {
    const t = makeTarget("target")
    // top=5 → y = 5 − 18 = −13 → clamped to 0
    mockRect(t, { right: 200, top: 5, width: 100, height: 5, bottom: 10, left: 100 })
    setCrewBots(document, window, [ONE_BOT])

    const el = _crewShadowOf(document)!.querySelector("[data-bot-id=b1]") as HTMLElement
    expect(el.style.top).toBe("0px")
  })

  test("clamps x to viewport right edge when target overflows right", () => {
    const t = makeTarget("target")
    // right=1210, vw=1200, BOT_SIZE=36 → x = 1210−18=1192 → clamped to 1200−36=1164
    mockRect(t, { right: 1210, top: 100, width: 100, height: 50, bottom: 150, left: 1110 })
    setCrewBots(document, window, [ONE_BOT])

    const el = _crewShadowOf(document)!.querySelector("[data-bot-id=b1]") as HTMLElement
    expect(el.style.left).toBe("1164px")
  })
})

// ─── hide / show ─────────────────────────────────────────────────────────────

describe("setCrewBotsHidden", () => {
  test("hide sets visibility:hidden on host", () => {
    const t = makeTarget("target")
    mockRect(t)
    setCrewBots(document, window, [ONE_BOT])
    setCrewBotsHidden(document, true)
    expect(findHost()!.style.visibility).toBe("hidden")
  })

  test("show restores visibility:visible", () => {
    const t = makeTarget("target")
    mockRect(t)
    setCrewBots(document, window, [ONE_BOT])
    setCrewBotsHidden(document, true)
    setCrewBotsHidden(document, false)
    expect(findHost()!.style.visibility).toBe("visible")
  })

  test("hidden state preserves bot views in crewBotsOf", () => {
    const t = makeTarget("target")
    mockRect(t)
    setCrewBots(document, window, [ONE_BOT])
    setCrewBotsHidden(document, true)
    expect(crewBotsOf(document)).toHaveLength(1)
    expect(crewBotsOf(document)[0]).toEqual(ONE_BOT)
  })

  test("a bot update keeps the overlay hidden during a screenshot", () => {
    const target = makeTarget("target")
    mockRect(target)
    setCrewBots(document, window, [ONE_BOT])
    setCrewBotsHidden(document, true)

    setCrewBots(document, window, [{ ...ONE_BOT, status: "waiting" }])

    expect(findHost()!.style.visibility).toBe("hidden")
    target.remove()
  })

  test("setCrewBotsHidden is a noop when nothing is mounted", () => {
    expect(() => setCrewBotsHidden(document, true)).not.toThrow()
  })
})

// ─── clear ───────────────────────────────────────────────────────────────────

describe("clearCrewBots", () => {
  test("removes host from document", () => {
    const t = makeTarget("target")
    mockRect(t)
    setCrewBots(document, window, [ONE_BOT])
    expect(findHost()).not.toBeNull()
    clearCrewBots(document)
    expect(findHost()).toBeNull()
  })

  test("crewBotsOf returns [] after clear", () => {
    const t = makeTarget("target")
    mockRect(t)
    setCrewBots(document, window, [ONE_BOT])
    clearCrewBots(document)
    expect(crewBotsOf(document)).toHaveLength(0)
  })

  test("_crewShadowOf returns null after clear", () => {
    const t = makeTarget("target")
    mockRect(t)
    setCrewBots(document, window, [ONE_BOT])
    clearCrewBots(document)
    expect(_crewShadowOf(document)).toBeNull()
  })

  test("clearCrewBots is a noop when nothing is mounted", () => {
    expect(() => clearCrewBots(document)).not.toThrow()
  })
})

// ─── host restore ────────────────────────────────────────────────────────────

describe("host restore", () => {
  test("re-appends host when page code removes it while bots remain", async () => {
    const t = makeTarget("target")
    mockRect(t)
    setCrewBots(document, window, [ONE_BOT])

    const host = findHost()!
    host.remove()
    expect(findHost()).toBeNull()

    // MutationObserver callbacks are queued as microtasks.
    await Promise.resolve()

    expect(findHost()).not.toBeNull()
    expect(crewBotsOf(document)).toHaveLength(1)
  })

  test("visibility state is preserved after host is restored", async () => {
    const t = makeTarget("target")
    mockRect(t)
    setCrewBots(document, window, [ONE_BOT])
    setCrewBotsHidden(document, true)

    findHost()!.remove()
    await Promise.resolve()

    // Inline visibility:hidden survives remove/re-append.
    expect(findHost()!.style.visibility).toBe("hidden")
  })
})

// ─── shadow CSS ───────────────────────────────────────────────────────────────

describe("shadow style", () => {
  test("style sheet contains the prefers-reduced-motion media rule", () => {
    setCrewBots(document, window, [ONE_BOT])
    const css = _crewShadowOf(document)!.querySelector("style")!.textContent!
    expect(css).toContain("prefers-reduced-motion")
    expect(css).toContain("animation: none")
  })

  test("style sheet defines morph-working and morph-waiting keyframes", () => {
    setCrewBots(document, window, [ONE_BOT])
    const css = _crewShadowOf(document)!.querySelector("style")!.textContent!
    expect(css).toContain("morph-working")
    expect(css).toContain("morph-waiting")
  })

  test("working bot SVG carries the animation declaration via class", () => {
    const view: CrewBotView = { id: "w", selector: "#missing", status: "working" }
    setCrewBots(document, window, [view])
    const css = _crewShadowOf(document)!.querySelector("style")!.textContent!
    // The CSS class rule for working applies the animation.
    expect(css).toContain('[data-status="working"]')
    expect(css).toContain("morph-working")
  })
})

// ─── status attributes ───────────────────────────────────────────────────────

describe("status attributes", () => {
  const statuses: CrewBotView["status"][] = ["working", "waiting", "done", "failed", "stopped"]

  for (const status of statuses) {
    test(`bot element carries data-status="${status}"`, () => {
      const view: CrewBotView = { id: `s-${status}`, selector: "#missing", status }
      setCrewBots(document, window, [view])
      const el = _crewShadowOf(document)!.querySelector(`[data-bot-id=s-${status}]`)!
      expect(el.getAttribute("data-status")).toBe(status)
    })
  }
})

// ─── mascot shape / variant ───────────────────────────────────────────────────

describe("mascot shape", () => {
  test("explicit variant uses the correct brand color", () => {
    const view: CrewBotView = { id: "v1", selector: "#missing", status: "done", variant: "hex" }
    setCrewBots(document, window, [view])
    const path = _crewShadowOf(document)!.querySelector("[data-shape=hex]")!
    expect(path.getAttribute("fill")).toBe("#E02988")
  })

  test("wedge uses orange brand color", () => {
    const view: CrewBotView = { id: "v2", selector: "#missing", status: "done", variant: "wedge" }
    setCrewBots(document, window, [view])
    const path = _crewShadowOf(document)!.querySelector("[data-shape=wedge]")!
    expect(path.getAttribute("fill")).toBe("#FF9800")
  })

  test("same seed produces the same shape for two bots", () => {
    const a: CrewBotView = { id: "sa", selector: "#missing", status: "done", seed: 0 }
    const b: CrewBotView = { id: "sb", selector: "#missing", status: "done", seed: 0 }
    setCrewBots(document, window, [a, b])
    const shadow = _crewShadowOf(document)!
    const [elA, elB] = shadow.querySelectorAll(".morph-bot")
    const shapeA = elA!.querySelector("[data-shape]")?.getAttribute("data-shape")
    const shapeB = elB!.querySelector("[data-shape]")?.getAttribute("data-shape")
    expect(shapeA).toBe(shapeB)
    expect(shapeA).not.toBeNull()
  })

  test("stripe-eye paths are rendered inside the SVG", () => {
    const view: CrewBotView = { id: "eyes", selector: "#missing", status: "done", variant: "squircle" }
    setCrewBots(document, window, [view])
    const eyeGroup = _crewShadowOf(document)!.querySelector("[data-stripe-eyes=true]")!
    expect(eyeGroup.querySelectorAll("path").length).toBeGreaterThan(0)
  })
})

// ─── label ───────────────────────────────────────────────────────────────────

describe("label", () => {
  test("renders a label span when label is provided", () => {
    const view: CrewBotView = { id: "lbl", selector: "#missing", status: "working", label: "Checking" }
    setCrewBots(document, window, [view])
    const span = _crewShadowOf(document)!.querySelector(".morph-bot-label")
    expect(span).not.toBeNull()
    expect(span!.textContent).toBe("Checking")
  })

  test("does not render a label span when label is absent", () => {
    const view: CrewBotView = { id: "nolbl", selector: "#missing", status: "done" }
    setCrewBots(document, window, [view])
    const span = _crewShadowOf(document)!.querySelector(".morph-bot-label")
    expect(span).toBeNull()
  })
})

// ─── event-driven refresh ────────────────────────────────────────────────────

describe("event-driven refresh", () => {
  test("scroll event repositions bots (as happy-dom permits)", () => {
    const t = makeTarget("target")
    let rect = { right: 200, top: 100, width: 100, height: 50, bottom: 150, left: 100 }
    t.getBoundingClientRect = () =>
      ({ ...rect, x: rect.left, y: rect.top, toJSON: () => ({}) }) as DOMRect

    setCrewBots(document, window, [ONE_BOT])
    const el = _crewShadowOf(document)!.querySelector("[data-bot-id=b1]") as HTMLElement
    expect(el.style.left).toBe("182px") // initial: 200 − 18

    // Simulate target moving after a scroll.
    rect = { right: 300, top: 200, width: 100, height: 50, bottom: 250, left: 200 }
    document.dispatchEvent(new Event("scroll"))

    expect(el.style.left).toBe("282px") // 300 − 18
    expect(el.style.top).toBe("182px")  // 200 − 18
  })

  test("resize event repositions bots (as happy-dom permits)", () => {
    const t = makeTarget("target")
    let rect = { right: 200, top: 100, width: 100, height: 50, bottom: 150, left: 100 }
    t.getBoundingClientRect = () =>
      ({ ...rect, x: rect.left, y: rect.top, toJSON: () => ({}) }) as DOMRect

    setCrewBots(document, window, [ONE_BOT])
    const el = _crewShadowOf(document)!.querySelector("[data-bot-id=b1]") as HTMLElement
    expect(el.style.left).toBe("182px")

    rect = { right: 400, top: 50, width: 200, height: 100, bottom: 150, left: 200 }
    window.dispatchEvent(new Event("resize"))

    expect(el.style.left).toBe("382px") // 400 − 18
    expect(el.style.top).toBe("32px")   // 50 − 18
  })

  test("target becoming hidden after refresh hides the bot", () => {
    const t = makeTarget("target")
    mockRect(t)
    setCrewBots(document, window, [ONE_BOT])

    const el = _crewShadowOf(document)!.querySelector("[data-bot-id=b1]") as HTMLElement
    expect(el.style.display).toBe("flex")

    // Hide the target; the next refresh should hide the bot.
    t.style.display = "none"
    document.dispatchEvent(new Event("scroll"))

    expect(el.style.display).toBe("none")
  })
})
