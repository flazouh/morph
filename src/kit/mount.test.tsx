import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { act } from "react"
import { MODULE_IDS } from "./module-ids"
import { beui, modules, requireModule } from "./modules"
import { createKit, type Kit } from "./mount"

/**
 * The mount API against a DOM: where the host lands, what the component gets as
 * children, and that a second mount on the same host re-renders instead of duplicating.
 * Runs under the panel's happy-dom setup (`bun run test:panel`).
 */

let kit: Kit
beforeEach(() => {
  document.body.innerHTML = `<p id="p"><a id="more" href="/news?p=2">More</a> <span id="pts">1091 points</span></p><div id="box"></div>`
  kit = createKit(new CSSStyleSheet())
})
afterEach(() => {
  document.body.innerHTML = ""
})

const render = (f: () => Element): Element => {
  let host: Element | undefined
  act(() => {
    host = f()
  })
  return host as Element
}

describe("__beui.mount", () => {
  test("replace: the host takes the element's place, its text becomes the children, and a link stays a link", () => {
    const host = render(() => kit.mount("#more", "Button", { href: "/news?p=2", variant: "secondary" }))
    expect(document.getElementById("more")).toBeNull()
    expect(host.getAttribute("data-beui")).toBe("Button")
    expect(host.parentElement?.id).toBe("p")
    const a = host.shadowRoot?.querySelector("a")
    expect(a?.getAttribute("href")).toBe("/news?p=2")
    expect(a?.textContent).toBe("More")
  })

  test("inside and append: the element stays and gets the host", () => {
    const inside = render(() => kit.mount("#box", "Badge", { status: "success" }, { mode: "inside", children: "live" }))
    expect(document.getElementById("box")?.firstElementChild).toBe(inside)
    expect(inside.shadowRoot?.textContent).toContain("live")
    const appended = render(() => kit.mount("#p", "Badge", {}, { mode: "append", children: "new" }))
    expect(document.getElementById("p")?.lastElementChild).toBe(appended)
  })

  test("mounting the host again re-renders it: one host, new props", () => {
    const host = render(() => kit.mount("#pts", "Badge", { status: "neutral" }))
    const again = render(() => kit.mount(host, "Badge", { status: "danger" }, { children: "changed" }))
    expect(again).toBe(host)
    expect(document.querySelectorAll("[data-beui]")).toHaveLength(1)
    expect(host.shadowRoot?.textContent).toContain("changed")
  })

  test("a detached target is refused with a plain error, so a script's own element is inserted before it is mounted", () => {
    const loose = document.createElement("div")
    expect(() => kit.mount(loose, "Card")).toThrow("not in the document")
    expect(() => kit.mount(loose, "Badge", {}, { mode: "inside" })).toThrow("not in the document")
  })

  test("unmount removes the host; unknown names and missing targets are plain errors", () => {
    const host = render(() => kit.mount("#more", "Button"))
    act(() => kit.unmount(host))
    expect(document.querySelectorAll("[data-beui]")).toHaveLength(0)
    expect(() => kit.mount("#more", "Button")).toThrow('nothing matches "#more"')
    expect(() => kit.mount("#pts", "Carousel")).toThrow("no component named Carousel")
    expect(kit.list()).toContain("Tabs")
  })

  test("each host carries the page's theme, so the components' dark: rules flip with the palette", () => {
    document.documentElement.setAttribute("data-beui-theme", "dark")
    const host = render(() => kit.mount("#pts", "Badge"))
    expect(host.getAttribute("data-beui-theme")).toBe("dark")
    document.documentElement.removeAttribute("data-beui-theme")
  })

  test("mounting a different component on a host is refused; unmount first", () => {
    const host = render(() => kit.mount("#pts", "Badge"))
    expect(() => kit.mount(host, "Button")).toThrow("Badge is mounted here")
  })

  test("wrap: the element moves into the host as light DOM, so page CSS still styles it, and the component shows it through a slot", () => {
    const host = render(() => kit.mount("#p", "Card", { tilt: false }))
    expect(host.getAttribute("data-beui")).toBe("Card")
    expect(host.parentElement).toBe(document.body)
    // The paragraph is the host's own child, not inside the shadow root: its link and its id survive.
    const p = document.getElementById("p")
    expect(p?.parentElement === host).toBe(true)
    expect(p?.querySelector("a#more")?.getAttribute("href")).toBe("/news?p=2")
    expect(host.shadowRoot?.querySelector("slot")).not.toBeNull()
  })

  test("wrap twice on the same element re-renders the one host and keeps the element", () => {
    const first = render(() => kit.mount("#p", "Card", {}))
    const second = render(() => kit.mount("#p", "Card", { padding: "lg" }))
    expect(second).toBe(first)
    expect(document.querySelectorAll("[data-beui=Card]")).toHaveLength(1)
    expect(document.getElementById("p")?.parentElement === first).toBe(true)
  })

  test("wrapping a stranger that sits inside a host wraps it in a card of its own", () => {
    const outer = render(() => kit.mount("#p", "Card", {}))
    const stranger = document.createElement("div")
    stranger.id = "stranger"
    outer.append(stranger)
    const inner = render(() => kit.mount("#stranger", "Card", {}))
    expect(inner).not.toBe(outer)
    expect(inner.parentElement === outer).toBe(true)
    expect(document.getElementById("stranger")?.parentElement === inner).toBe(true)
  })

  test("unmounting a wrapped host puts the element back where the host stood", () => {
    const host = render(() => kit.mount("#p", "Card", {}))
    act(() => kit.unmount(host))
    const p = document.getElementById("p")
    expect(p?.parentElement === document.body).toBe(true)
    expect(p?.nextElementSibling?.id).toBe("box")
    expect(document.querySelector("[data-beui]")).toBeNull()
  })

  test("a re-mount without children keeps the children it had", () => {
    const host = render(() => kit.mount("#more", "Button", { variant: "secondary" }))
    render(() => kit.mount(host, "Button", { variant: "primary" }))
    expect(host.shadowRoot?.textContent).toBe("More")
  })

  test("Accordion, Radio, Select and Checkbox take their data as flat props", () => {
    const acc = render(() => kit.mount("#box", "Accordion", { items: [{ id: "a", title: "One", description: "first" }, { id: "b", title: "Two" }] }, { mode: "inside" }))
    expect(acc.shadowRoot?.textContent).toContain("One")
    expect(acc.shadowRoot?.textContent).toContain("Two")
    document.body.insertAdjacentHTML("beforeend", `<div id="r"></div><div id="s"></div><div id="c"></div>`)
    const radio = render(() => kit.mount("#r", "Radio", { options: [{ value: "x", label: "X" }, { value: "y", label: "Y" }], initial: "y" }, { mode: "inside" }))
    expect(radio.shadowRoot?.querySelectorAll("[role=radio]")).toHaveLength(2)
    const select = render(() => kit.mount("#s", "Select", { options: [{ value: "x", label: "X" }], placeholder: "Pick" }, { mode: "inside" }))
    expect(select.shadowRoot?.textContent).toContain("Pick")
    const box = render(() => kit.mount("#c", "Checkbox", { label: "Done", checked: true }, { mode: "inside" }))
    expect(box.shadowRoot?.textContent).toContain("Done")
  })

  test("Tabs is a block host with one trigger per tab", () => {
    const host = render(() => kit.mount("#box", "Tabs", { tabs: [{ value: "a", label: "New" }, { value: "b", label: "Past" }] }, { mode: "inside" }))
    expect(host.tagName).toBe("DIV")
    expect(host.shadowRoot?.querySelectorAll("button")).toHaveLength(2)
  })
})

describe("__beui.skin", () => {
  const React = require("react") as typeof import("react")
  /** What sucrase makes of a skin: a CommonJS body that requires react and beui and exports the component. */
  const body =
    (target: string | undefined, text: string) =>
    (req: (id: string) => unknown, exports: Record<string, unknown>) => {
      const { createElement } = req("react") as typeof React
      const { Button } = req("beui") as { Button: (p: { children?: unknown }) => unknown }
      if (target !== undefined) exports["target"] = target
      exports["default"] = () => createElement("main", { className: "p-4" }, createElement(Button as never, null, text))
    }

  test("renders the component in one shadow host before the target, hides the target, and adopts the skin's CSS", () => {
    const host = render(() => kit.skin(body("#p", "Hello"), ".p-4{padding:1rem}"))
    expect(host.getAttribute("data-beui")).toBe("Skin")
    expect(host.nextElementSibling?.id).toBe("p")
    const p = document.getElementById("p") as HTMLElement
    expect(getComputedStyle(p).display).toBe("none")
    expect(host.shadowRoot?.querySelector("main")?.className).toBe("p-4")
    expect(host.shadowRoot?.querySelector("button")?.textContent).toBe("Hello")
    expect(host.shadowRoot?.adoptedStyleSheets).toHaveLength(2)
  })

  test("running it again re-renders the same host, swaps the CSS, and unhides a target that is no longer named", () => {
    const first = render(() => kit.skin(body("#p", "One"), ".a{}"))
    const second = render(() => kit.skin(body("#box", "Two"), ".b{}"))
    expect(second).toBe(first)
    expect(document.querySelectorAll('[data-beui="Skin"]')).toHaveLength(1)
    expect(second.shadowRoot?.querySelector("button")?.textContent).toBe("Two")
    expect(getComputedStyle(document.getElementById("p") as HTMLElement).display).not.toBe("none")
    expect(getComputedStyle(document.getElementById("box") as HTMLElement).display).toBe("none")
    expect(second.nextElementSibling?.id).toBe("box")
  })

  test("without a target the skin goes first in the body and hides nothing", () => {
    const host = render(() => kit.skin(body(undefined, "Top"), ""))
    expect(document.body.firstElementChild).toBe(host)
    expect(getComputedStyle(document.getElementById("p") as HTMLElement).display).not.toBe("none")
  })

  test("a module without a default export, or a module that asks for an unknown package, fails plainly", () => {
    expect(() => kit.skin(() => {}, "")).toThrow("default export")
    expect(() => kit.skin((req) => void req("lodash"), "")).toThrow("lodash")
  })

  test("the beui module carries the components a skin may import, and cn", () => {
    for (const name of ["Button", "ButtonLink", "Badge", "TiltCard", "Tabs", "TabsList", "TabsTrigger", "TabsContent", "Select", "Input", "Switch", "Checkbox", "Tooltip", "TextReveal", "NumberTicker", "Accordion", "Loader", "RadioGroup", "cn"]) {
      expect(typeof (beui as Record<string, unknown>)[name]).not.toBe("undefined")
    }
    expect(Object.keys(modules).sort()).toEqual([...MODULE_IDS].sort())
  })

  test("extras add to a module for one skin: the icons a skin imports join @hugeicons/core-free-icons", () => {
    const icon = [["path", { d: "M0 0" }]]
    expect(requireModule("@hugeicons/core-free-icons", { "@hugeicons/core-free-icons": { Search01Icon: icon } })).toEqual({ Search01Icon: icon })
    expect(requireModule("@hugeicons/core-free-icons")).toEqual({})
    expect(typeof (requireModule("@hugeicons/react") as { HugeiconsIcon: unknown }).HugeiconsIcon).toBe("object")
  })

  test("beui offers a focused set of Paper Shaders to generated skins", () => {
    const shaders = [beui.MeshGradient, beui.GrainGradient, beui.StaticMeshGradient, beui.GodRays]
    for (const shader of shaders) expect(shader).toBeDefined()
  })

  test("require answers by id, not by property lookup: Object.prototype's names are not modules", () => {
    for (const id of ["constructor", "toString", "hasOwnProperty", "__proto__"]) expect(() => requireModule(id)).toThrow("no module named")
  })
})
