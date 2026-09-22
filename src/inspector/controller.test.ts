import { afterEach, describe, expect, test } from "bun:test"
import { Window as HappyWindow } from "happy-dom"
import { createInspectorController, loadInitialHistory } from "./controller"
import type { InspectorController, InspectorPorts, InspectorSend, InspectorWindow } from "./controller"
import { INSPECTOR_SHEET_ID } from "./css"
import type { InspectorAnswer } from "./messages"
import type { ChangeHistory, ChangeRecord, SourceLocation } from "./model"
import {
  clickOn,
  fakeInspectorPort,
  fire,
  flush,
  key,
  openTestShadow,
  pointerAt,
  previewInto,
  savesIn,
  typeInto
} from "./test-fixtures"
import type { TestWindow } from "./test-fixtures"

/**
 * `createInspectorController` is mounted here directly, into a fresh open shadow, with no
 * `host.ts` card in between: what a real page host builds is a closed shadow around the
 * exact same root this file appends into its own open one. Typed as both `InspectorWindow`
 * the controller wants and `TestWindow`'s event constructors the fixtures want: happy-dom's
 * own `Window` type satisfies neither by structural shape, though a real instance answers
 * to both at runtime.
 */
const win = new HappyWindow({ url: "https://app.test/dashboard" }) as unknown as InspectorWindow & TestWindow
const doc = win.document as unknown as Document

// A controller installs document-level click/keydown/scroll listeners for as long as it
// lives, exactly like a real inspect-mode session. Without destroying it, a leftover
// controller from an earlier test keeps intercepting the next test's page events.
let activeController: { destroy(): void } | null = null

afterEach(() => {
  activeController?.destroy()
  activeController = null
  // `wearStyles` (in the applied-CSS path) appends its sheet as a direct child of
  // `<html>`, alongside `<head>`/`<body>`, not inside either: clearing only those two
  // would leave the previous test's applied rules on the page for the next one.
  doc.documentElement.replaceChildren(doc.createElement("head"), doc.createElement("body"))
})

const pageWith = (html: string): void => {
  doc.body.innerHTML = html
}

/** Mounts a controller directly into a fresh open shadow. Loads history through the same
 * `loadInitialHistory` a real host uses, so a restored record seeds the source cache the
 * same way it would in the extension. */
const mount = async (
  send: InspectorSend,
  ports: Partial<Omit<InspectorPorts, "send">> = {}
): Promise<{ readonly shadow: ShadowRoot; readonly controller: InspectorController }> => {
  const { shadow } = openTestShadow(doc)
  const history = await loadInitialHistory(doc, send)
  const controller = createInspectorController(doc, win, history, {
    send,
    onExit: ports.onExit ?? (() => {}),
    onHistoryChange: ports.onHistoryChange ?? (() => {}),
    beginCopyPrompt: ports.beginCopyPrompt ?? (() => ({ ok: true, pending: Promise.resolve() })),
    sendToMorph: ports.sendToMorph ?? (async () => ({ ok: true }))
  })
  shadow.append(controller.root)
  activeController = controller
  return { shadow, controller }
}

const sheetText = (): string => doc.getElementById(INSPECTOR_SHEET_ID)?.textContent ?? ""

describe("hover and selection", () => {
  test("hover draws a non-animated outline and a tag with the tag name and classes", async () => {
    pageWith(`<button id="btn" class="primary large">Click</button>`)
    const { send } = fakeInspectorPort()
    const { shadow } = await mount(send)
    const button = doc.getElementById("btn")!
    button.getBoundingClientRect = () => ({ left: 10, top: 20, width: 100, height: 30, right: 110, bottom: 50, x: 10, y: 20, toJSON: () => ({}) })

    fire(button, pointerAt(win, "pointermove"))

    const outline = shadow.querySelector<HTMLElement>(".mi-outline")!
    const tag = shadow.querySelector<HTMLElement>(".mi-tag")!
    expect(outline.hidden).toBe(false)
    expect(outline.style.left).toBe("10px")
    expect(outline.style.width).toBe("100px")
    expect(tag.hidden).toBe(false)
    expect(tag.textContent).toContain("button.primary.large")
  })

  test("click fixes the selection, opens the panel, and shows computed values for the six properties", async () => {
    pageWith(
      `<main id="app"><div id="card" class="box" style="padding:8px 12px;margin:4px;color:#111111;background-color:#eeeeee;border-radius:6px;font-size:14px;">Card</div></main>`
    )
    const { send } = fakeInspectorPort()
    const { shadow } = await mount(send)
    fire(doc.getElementById("card")!, clickOn(win))
    await flush()

    const panel = shadow.querySelector<HTMLElement>(".mi-panel")!
    expect(panel.hidden).toBe(false)
    expect(shadow.querySelector<HTMLInputElement>("#mi-input-padding")!.value).toBe("8px 12px")
    expect(shadow.querySelector<HTMLInputElement>("#mi-input-margin")!.value).toBe("4px")
    expect(shadow.querySelector<HTMLInputElement>("#mi-input-color")!.value).toBe("#111111")
    expect(shadow.querySelector<HTMLInputElement>("#mi-input-background-color")!.value).toBe("#eeeeee")
    expect(shadow.querySelector<HTMLInputElement>("#mi-input-border-radius")!.value).toBe("6px")
    expect(shadow.querySelector<HTMLInputElement>("#mi-input-font-size")!.value).toBe("14px")

    const crumbs = shadow.querySelectorAll<HTMLButtonElement>(".mi-crumb")
    expect(crumbs.length).toBeGreaterThanOrEqual(2)
    expect(crumbs[crumbs.length - 1]!.getAttribute("aria-current")).toBe("true")
    expect(crumbs[crumbs.length - 1]!.textContent).toContain("div.box")
  })

  test("clicking a page element never navigates it; the click is intercepted", async () => {
    pageWith(`<a id="link" href="https://example.com">Go</a>`)
    const { send } = fakeInspectorPort()
    await mount(send)
    const link = doc.getElementById("link")!
    const event = clickOn(win)
    link.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })

  test("a breadcrumb button selects an ancestor", async () => {
    pageWith(`<main id="app"><section id="outer"><span id="inner">x</span></section></main>`)
    const { send } = fakeInspectorPort()
    const { shadow } = await mount(send)
    fire(doc.getElementById("inner")!, clickOn(win))
    await flush()

    const crumbs = shadow.querySelectorAll<HTMLButtonElement>(".mi-crumb")
    const outerCrumb = Array.from(crumbs).find((c) => c.textContent?.includes("section"))!
    outerCrumb.click()
    await flush()

    const nowCrumbs = shadow.querySelectorAll<HTMLButtonElement>(".mi-crumb")
    expect(nowCrumbs[nowCrumbs.length - 1]!.textContent).toContain("section")
  })

  test("arrow keys select parent, first child, previous sibling, and next sibling", async () => {
    pageWith(
      `<main id="app"><section id="parent"><span id="one">1</span><span id="two">2</span><span id="three">3</span></section></main>`
    )
    const { send } = fakeInspectorPort()
    const { shadow } = await mount(send)
    fire(doc.getElementById("two")!, clickOn(win))
    await flush()

    const crumbText = (): string | null => {
      const crumbs = shadow.querySelectorAll<HTMLButtonElement>(".mi-crumb")
      return crumbs[crumbs.length - 1]?.textContent ?? null
    }

    fire(doc, key(win, "ArrowUp"))
    await flush()
    expect(crumbText()).toContain("section")

    fire(doc, key(win, "ArrowDown"))
    await flush()
    expect(crumbText()).toContain("span")

    // Back to #two by walking down to the first child, then to its siblings.
    fire(doc.getElementById("two")!, clickOn(win))
    await flush()
    fire(doc, key(win, "ArrowLeft"))
    await flush()
    expect(crumbText()).toContain("span")

    fire(doc.getElementById("two")!, clickOn(win))
    await flush()
    fire(doc, key(win, "ArrowRight"))
    await flush()
    expect(crumbText()).toContain("span")
  })

  test("Escape asks the host to exit, and the applied change stays on the page", async () => {
    pageWith(`<main id="app"><div id="card" style="color:#111111;">Card</div></main>`)
    const { send } = fakeInspectorPort()
    let exits = 0
    const { shadow } = await mount(send, { onExit: () => { exits += 1 } })
    fire(doc.getElementById("card")!, clickOn(win))
    await flush()

    const colorInput = shadow.querySelector<HTMLInputElement>("#mi-input-color")!
    previewInto(win, colorInput, "#00dadb")
    await flush()
    expect(sheetText()).toContain("#00dadb")

    fire(doc, key(win, "Escape"))
    await flush()

    expect(exits).toBe(1)
    expect(sheetText()).toContain("#00dadb")
  })

})

describe("rich controls", () => {
  test("a numeric property gets a slider with a parsed pixel value and a unit-preserving edit", async () => {
    pageWith(`<div id="card" style="padding:8px;">Card</div>`)
    const { send } = fakeInspectorPort()
    const { shadow } = await mount(send)
    fire(doc.getElementById("card")!, clickOn(win))
    await flush()

    const slider = shadow.querySelector<HTMLInputElement>("#mi-slider-padding")!
    expect(slider.type).toBe("range")
    expect(slider.value).toBe("8")
    expect(slider.getAttribute("aria-label")).toBe("Padding slider")

    previewInto(win, slider, "24")
    await flush()
    expect(sheetText()).toContain("padding: 24px")

    slider.dispatchEvent(new win.Event("change", { bubbles: true }))
    await flush()
    expect(shadow.querySelector<HTMLInputElement>("#mi-input-padding")!.value).toBe("24px")
  })

  test("a rem value keeps its unit when its slider moves", async () => {
    pageWith(`<div id="card" style="font-size:1.25rem;">Card</div>`)
    const { send } = fakeInspectorPort()
    const { shadow } = await mount(send)
    fire(doc.getElementById("card")!, clickOn(win))
    await flush()

    const slider = shadow.querySelector<HTMLInputElement>("#mi-slider-font-size")!
    expect(slider.value).toBe("20")
    previewInto(win, shadow.querySelector<HTMLInputElement>("#mi-input-font-size")!, "1.5rem")
    await flush()
    expect(sheetText()).toContain("font-size: 1.5rem")
  })

  test("a multi-length value has no slider and keeps its text control", async () => {
    pageWith(`<div id="card" style="padding:8px 12px;">Card</div>`)
    const { send } = fakeInspectorPort()
    const { shadow } = await mount(send)
    fire(doc.getElementById("card")!, clickOn(win))
    await flush()

    expect(shadow.querySelector<HTMLInputElement>("#mi-slider-padding")!.hidden).toBe(true)
    expect(shadow.querySelector<HTMLInputElement>("#mi-input-padding")!.value).toBe("8px 12px")
  })

  test("a bare zero length keeps its slider and writes back as pixels", async () => {
    pageWith(`<div id="card" style="margin:0px;">Card</div>`)
    const { send } = fakeInspectorPort()
    const { shadow } = await mount(send)
    fire(doc.getElementById("card")!, clickOn(win))
    await flush()

    const input = shadow.querySelector<HTMLInputElement>("#mi-input-margin")!
    typeInto(win, input, "0")
    await flush()

    const slider = shadow.querySelector<HTMLInputElement>("#mi-slider-margin")!
    expect(slider.hidden).toBe(false)
    expect(slider.value).toBe("0")
    expect(sheetText()).toContain("margin: 0 !important")
  })

  test("a page with no color tokens shows no token row", async () => {
    pageWith(`<div id="card">Card</div>`)
    const { send } = fakeInspectorPort()
    const { shadow } = await mount(send)
    fire(doc.getElementById("card")!, clickOn(win))
    await flush()

    expect(shadow.querySelector<HTMLElement>('.mi-tokens[data-mi-tokens-for="color"]')!.hidden).toBe(true)
  })

  test("a relative length keeps text-only editing because a slider cannot represent it", async () => {
    pageWith(`<div id="card">Card</div>`)
    const { send } = fakeInspectorPort()
    const { shadow } = await mount(send)
    fire(doc.getElementById("card")!, clickOn(win))
    await flush()

    const input = shadow.querySelector<HTMLInputElement>("#mi-input-font-size")!
    typeInto(win, input, "5vw")
    await flush()

    expect(shadow.querySelector<HTMLInputElement>("#mi-slider-font-size")!.hidden).toBe(true)
    expect(input.value).toBe("5vw")
    expect(sheetText()).toContain("font-size: 5vw")
  })

  test("hidden rich controls use display none so a hidden control cannot be dragged", async () => {
    pageWith(`<div id="card" style="padding:8px 12px;">Card</div>`)
    const { send } = fakeInspectorPort()
    const { shadow } = await mount(send)
    fire(doc.getElementById("card")!, clickOn(win))
    await flush()

    const slider = shadow.querySelector<HTMLInputElement>("#mi-slider-padding")!
    expect(slider.hidden).toBe(true)
    expect(shadow.querySelector<HTMLStyleElement>(".mi-root style")!.textContent).toContain(".mi-slider[hidden]")
    expect(shadow.querySelector<HTMLStyleElement>(".mi-root style")!.textContent).toContain(".mi-picker[hidden]")
    expect(shadow.querySelector<HTMLStyleElement>(".mi-root style")!.textContent).toContain(".mi-tokens[hidden]")
  })

  test("a hidden slider input cannot collapse a multi-length value", async () => {
    pageWith(`<div id="card" style="padding:8px 12px;">Card</div>`)
    const { send } = fakeInspectorPort()
    const { shadow } = await mount(send)
    fire(doc.getElementById("card")!, clickOn(win))
    await flush()

    const slider = shadow.querySelector<HTMLInputElement>("#mi-slider-padding")!
    previewInto(win, slider, "24")
    await flush()

    expect(shadow.querySelector<HTMLInputElement>("#mi-input-padding")!.value).toBe("8px 12px")
    expect(sheetText()).toBe("")
  })

  test("a hidden picker input cannot write a stale color", async () => {
    pageWith(`<div id="card">Card</div>`)
    const { send } = fakeInspectorPort()
    const { shadow } = await mount(send)
    fire(doc.getElementById("card")!, clickOn(win))
    await flush()

    const picker = shadow.querySelector<HTMLInputElement>("#mi-color-color")!
    previewInto(win, picker, "#00dadb")
    await flush()

    expect(shadow.querySelector<HTMLInputElement>("#mi-input-color")!.value).toBe("")
    expect(sheetText()).toBe("")
  })

  test("typing a partial hex keeps the typed text until it becomes a complete color", async () => {
    pageWith(`<div id="card">Card</div>`)
    const { send } = fakeInspectorPort()
    const { shadow } = await mount(send)
    fire(doc.getElementById("card")!, clickOn(win))
    await flush()

    const input = shadow.querySelector<HTMLInputElement>("#mi-input-color")!
    previewInto(win, input, "#fff")
    await flush()

    expect(input.value).toBe("#fff")
    expect(sheetText()).toContain("color: #fff")
  })

  test("a token row scrolls instead of pushing later properties out of the panel", async () => {
    pageWith(`<div id="card">Card</div>`)
    doc.head!.innerHTML = `<style>:root { ${Array.from({ length: 30 }, (_, index) => `--color-${index}: #ff0000;`).join(" ")} }</style>`
    const { send } = fakeInspectorPort()
    const { shadow } = await mount(send)
    fire(doc.getElementById("card")!, clickOn(win))
    await flush()

    const style = shadow.querySelector<HTMLStyleElement>(".mi-root style")!
    expect(style.textContent).toContain("max-height")
    expect(style.textContent).toContain("overflow: auto")
    expect(shadow.querySelectorAll('.mi-tokens[data-mi-tokens-for="color"] .mi-token')).toHaveLength(30)
  })

  test("a color property gets a color picker, swatch tokens, and a normalized hex text value", async () => {
    pageWith(`<div id="card" style="color:rgb(17, 17, 17);">Card</div>`)
    doc.head!.innerHTML = `<style>:root { --brand: #ff0000; --gap: 8px; }</style>`
    const { send } = fakeInspectorPort()
    const { shadow } = await mount(send)
    fire(doc.getElementById("card")!, clickOn(win))
    await flush()

    const picker = shadow.querySelector<HTMLInputElement>("#mi-color-color")!
    expect(picker.type).toBe("color")
    expect(picker.value).toBe("#111111")
    expect(picker.getAttribute("aria-label")).toBe("Text color picker")
    expect(shadow.querySelector<HTMLInputElement>("#mi-input-color")!.value).toBe("#111111")

    const tokens = Array.from(shadow.querySelectorAll<HTMLButtonElement>('.mi-tokens[data-mi-tokens-for="color"] .mi-token'))
    expect(tokens.map((token) => token.textContent)).toEqual(["--brand"])
    expect(tokens.some((token) => token.textContent === "--gap")).toBe(false)

    previewInto(win, picker, "#00dadb")
    await flush()
    expect(sheetText()).toContain("color: #00dadb")
    expect(shadow.querySelector<HTMLInputElement>("#mi-input-color")!.value).toBe("#00dadb")

    tokens[0]!.click()
    await flush()
    expect(sheetText()).toContain("color: var(--brand)")
    expect(shadow.querySelector<HTMLInputElement>("#mi-input-color")!.value).toBe("var(--brand)")
  })

  test("a var() color shows its token as current and keeps the picker on the resolved color", async () => {
    pageWith(`<div id="card">Card</div>`)
    doc.head!.innerHTML = `<style>:root { --brand: #ff0000; }</style>`
    const saved: ChangeRecord = {
      url: doc.location.href,
      tailwind: false,
      changes: [{ selector: "#card", property: "color", before: "rgb(0, 0, 0)", after: "var(--brand)" }],
      sources: {}
    }
    const { send } = fakeInspectorPort(saved)
    const { shadow } = await mount(send)
    fire(doc.getElementById("card")!, clickOn(win))
    await flush()

    const token = shadow.querySelector<HTMLButtonElement>('.mi-tokens[data-mi-tokens-for="color"] .mi-token')!
    expect(token.getAttribute("aria-pressed")).toBe("true")
    expect(shadow.querySelector<HTMLInputElement>("#mi-input-color")!.value).toBe("var(--brand)")
    expect(shadow.querySelector<HTMLInputElement>("#mi-color-color")!.value).toBe("#ff0000")
  })

  test("a color the picker cannot parse keeps the text control without a picker", async () => {
    pageWith(`<div id="card">Card</div>`)
    const { send } = fakeInspectorPort()
    const { shadow } = await mount(send)
    fire(doc.getElementById("card")!, clickOn(win))
    await flush()

    const input = shadow.querySelector<HTMLInputElement>("#mi-input-color")!
    typeInto(win, input, "color(display-p3 1 0 0)")
    await flush()

    expect(shadow.querySelector<HTMLInputElement>("#mi-color-color")!.hidden).toBe(true)
    expect(input.value).toBe("color(display-p3 1 0 0)")
  })
})

describe("edit history", () => {
  test("undo, redo, row removal, and discard all update the applied page styles", async () => {
    pageWith(`<div id="card">Card</div>`)
    const { send } = fakeInspectorPort()
    const { shadow } = await mount(send)
    fire(doc.getElementById("card")!, clickOn(win))
    await flush()

    const bg = shadow.querySelector<HTMLInputElement>("#mi-input-background-color")!
    previewInto(win, bg, "#00dadb")
    await flush()
    expect(sheetText()).toContain("#00dadb")

    shadow.querySelector<HTMLButtonElement>('[aria-label="Undo change"]')!.click()
    await flush()
    expect(sheetText()).not.toContain("#00dadb")

    shadow.querySelector<HTMLButtonElement>('[aria-label="Redo change"]')!.click()
    await flush()
    expect(sheetText()).toContain("#00dadb")

    shadow.querySelector<HTMLButtonElement>('[aria-label="Remove change"]')!.click()
    await flush()
    expect(sheetText()).not.toContain("#00dadb")

    previewInto(win, bg, "#ee343b")
    await flush()
    expect(sheetText()).toContain("#ee343b")

    shadow.querySelector<HTMLButtonElement>('[aria-label="Discard all changes"]')!.click()
    await flush()
    expect(sheetText()).toBe("")
  })

  test("a multi-character field edit is one undo step and one saved record", async () => {
    pageWith(`<div id="card" style="font-size:14px;">Card</div>`)
    const { send, calls, recordOf } = fakeInspectorPort()
    const { shadow } = await mount(send)
    fire(doc.getElementById("card")!, clickOn(win))
    await flush()

    const size = shadow.querySelector<HTMLInputElement>("#mi-input-font-size")!
    typeInto(win, size, "20px")
    await flush()
    const before = savesIn(calls)

    previewInto(win, size, "2")
    previewInto(win, size, "24")
    previewInto(win, size, "24p")
    previewInto(win, size, "24px")
    await flush()

    // Every keystroke previews on the page; none of them writes storage.
    expect(sheetText()).toContain("font-size: 24px")
    expect(savesIn(calls)).toBe(before)

    size.dispatchEvent(new win.Event("change", { bubbles: true }))
    await flush()

    expect(savesIn(calls)).toBe(before + 1)
    expect(recordOf()?.changes).toEqual([
      { selector: "#card", property: "font-size", before: "14px", after: "24px" }
    ])

    // One undo step for the whole burst: back to the whole prior value, not one character of it.
    shadow.querySelector<HTMLButtonElement>('[aria-label="Undo change"]')!.click()
    await flush()
    expect(recordOf()?.changes).toEqual([
      { selector: "#card", property: "font-size", before: "14px", after: "20px" }
    ])
    expect(sheetText()).toContain("font-size: 20px")
  })

  test("blur accepts a field edit that fired no change event", async () => {
    pageWith(`<div id="card" style="font-size:14px;">Card</div>`)
    const { send, calls, recordOf } = fakeInspectorPort()
    const { shadow } = await mount(send)
    fire(doc.getElementById("card")!, clickOn(win))
    await flush()

    const size = shadow.querySelector<HTMLInputElement>("#mi-input-font-size")!
    const before = savesIn(calls)

    previewInto(win, size, "20px")
    await flush()
    expect(savesIn(calls)).toBe(before)

    size.dispatchEvent(new win.Event("blur"))
    await flush()

    expect(savesIn(calls)).toBe(before + 1)
    expect(recordOf()?.changes[0]?.after).toBe("20px")
  })

  test("moving to another field accepts the previous one exactly once", async () => {
    pageWith(`<div id="card" style="font-size:14px;margin:4px;">Card</div>`)
    const { send, calls, recordOf } = fakeInspectorPort()
    const { shadow } = await mount(send)
    fire(doc.getElementById("card")!, clickOn(win))
    await flush()

    const before = savesIn(calls)
    previewInto(win, shadow.querySelector<HTMLInputElement>("#mi-input-font-size")!, "20px")
    previewInto(win, shadow.querySelector<HTMLInputElement>("#mi-input-margin")!, "8px")
    await flush()

    expect(savesIn(calls)).toBe(before + 1)

    shadow.querySelector<HTMLInputElement>("#mi-input-margin")!.dispatchEvent(new win.Event("change", { bubbles: true }))
    await flush()

    expect(savesIn(calls)).toBe(before + 2)
    expect(recordOf()?.changes).toHaveLength(2)
  })

  test("destroying the controller with an unaccepted preview still saves it", async () => {
    pageWith(`<div id="card" style="font-size:14px;">Card</div>`)
    const { send, recordOf } = fakeInspectorPort()
    const { shadow, controller } = await mount(send)
    fire(doc.getElementById("card")!, clickOn(win))
    await flush()

    previewInto(win, shadow.querySelector<HTMLInputElement>("#mi-input-font-size")!, "20px")
    await flush()
    expect(recordOf()).toBeNull()

    // A field the reader was still typing in must reach storage: destroying the controller
    // (as leaving inspect mode or a page navigation both do) would otherwise lose the edit.
    controller.destroy()
    await flush()

    expect(recordOf()?.changes[0]?.after).toBe("20px")
  })

  test("a value containing ; { or } is rejected before history, storage, the change list, or the page preview, with an actionable status", async () => {
    pageWith(`<div id="card" style="color:#111111;">Card</div>`)
    const { send, calls, recordOf } = fakeInspectorPort()
    const { shadow } = await mount(send)
    fire(doc.getElementById("card")!, clickOn(win))
    await flush()

    const colorInput = shadow.querySelector<HTMLInputElement>("#mi-input-color")!
    const status = shadow.querySelector<HTMLElement>(".mi-status")!
    const before = savesIn(calls)

    previewInto(win, colorInput, "#00dadb")
    await flush()
    expect(sheetText()).toContain("#00dadb")

    previewInto(win, colorInput, "red;} .evil{color:red")
    await flush()

    // The page keeps showing the last valid value; the unsafe one never reaches it.
    expect(sheetText()).toContain("#00dadb")
    expect(sheetText()).not.toContain("evil")
    // The change list still shows only the earlier valid edit, never the rejected one.
    const changeRows = shadow.querySelectorAll<HTMLElement>(".mi-change")
    expect(changeRows).toHaveLength(1)
    expect(changeRows[0]!.textContent).toContain("#00dadb")
    expect(changeRows[0]!.textContent).not.toContain("evil")
    expect(status.textContent).not.toBe("")
    expect(status.dataset.miError).toBe("true")

    colorInput.dispatchEvent(new win.Event("change", { bubbles: true }))
    await flush()
    // The field's acceptance still saves, but only the last valid value ever reaches it.
    expect(savesIn(calls)).toBe(before + 1)
    expect(recordOf()?.changes).toEqual([
      { selector: "#card", property: "color", before: "#111111", after: "#00dadb" }
    ])

    // Fixing the value resumes editing and clears the status.
    previewInto(win, colorInput, "#ee343b")
    await flush()
    expect(sheetText()).toContain("#ee343b")
    expect(status.textContent).toBe("")
  })

  test("an empty or blank value is rejected before history, storage, and handoff, and the last valid preview stays", async () => {
    pageWith(`<div id="card" style="color:#111111;">Card</div>`)
    const { send, calls, recordOf } = fakeInspectorPort()
    const { shadow } = await mount(send)
    fire(doc.getElementById("card")!, clickOn(win))
    await flush()

    const colorInput = shadow.querySelector<HTMLInputElement>("#mi-input-color")!
    const status = shadow.querySelector<HTMLElement>(".mi-status")!
    previewInto(win, colorInput, "#00dadb")
    await flush()
    const saves = savesIn(calls)

    for (const blank of ["", "   ", "\t"]) {
      previewInto(win, colorInput, blank)
      await flush()

      expect(sheetText()).toContain("#00dadb")
      expect(status.textContent).toMatch(/value/i)
      expect(status.dataset.miError).toBe("true")
      const rows = shadow.querySelectorAll<HTMLElement>(".mi-change")
      expect(rows).toHaveLength(1)
      expect(rows[0]!.textContent).toContain("#00dadb")
    }

    colorInput.dispatchEvent(new win.Event("change", { bubbles: true }))
    await flush()
    expect(savesIn(calls)).toBe(saves + 1)
    expect(recordOf()?.changes).toEqual([
      { selector: "#card", property: "color", before: "#111111", after: "#00dadb" }
    ])

    previewInto(win, colorInput, "#ee343b")
    await flush()
    expect(sheetText()).toContain("#ee343b")
    expect(status.textContent).toBe("")
  })

  test("leaving a field empty puts its last valid value back and keeps the error", async () => {
    pageWith(`<div id="card" style="color:#111111;">Card</div>`)
    const { send } = fakeInspectorPort()
    const { shadow } = await mount(send)
    fire(doc.getElementById("card")!, clickOn(win))
    await flush()

    const colorInput = shadow.querySelector<HTMLInputElement>("#mi-input-color")!
    const status = shadow.querySelector<HTMLElement>(".mi-status")!
    previewInto(win, colorInput, "#00dadb")
    await flush()

    previewInto(win, colorInput, "")
    await flush()
    // Still empty while the reader is typing a replacement: clearing the field is how a
    // value gets replaced, so nothing may put characters back under the caret.
    expect(colorInput.value).toBe("")
    expect(status.dataset.miError).toBe("true")

    colorInput.dispatchEvent(new win.Event("change", { bubbles: true }))
    await flush()

    // Leaving it settles the field on what the page actually shows, error still up.
    expect(colorInput.value).toBe("#00dadb")
    expect(status.textContent).toMatch(/value/i)
    expect(status.dataset.miError).toBe("true")
  })

  test("leaving a field empty with no valid edit yet puts the element's own value back", async () => {
    pageWith(`<div id="card" style="color:#111111;">Card</div>`)
    const { send, recordOf } = fakeInspectorPort()
    const { shadow } = await mount(send)
    fire(doc.getElementById("card")!, clickOn(win))
    await flush()

    const colorInput = shadow.querySelector<HTMLInputElement>("#mi-input-color")!
    const before = colorInput.value

    previewInto(win, colorInput, "   ")
    await flush()
    colorInput.dispatchEvent(new win.Event("blur", { bubbles: true }))
    await flush()

    expect(colorInput.value).toBe(before)
    expect(shadow.querySelectorAll(".mi-change")).toHaveLength(0)
    expect(recordOf()?.changes ?? []).toEqual([])
  })

  test("a save the worker refuses is reported inline while the controller is live", async () => {
    pageWith(`<div id="card" style="color:#111111;">Card</div>`)
    const send: InspectorSend = async (ask) =>
      ask.type === "saveInspector"
        ? { type: "inspectorError", message: "session storage is unavailable" }
        : ask.type === "loadInspector"
          ? { type: "inspectorLoaded", record: null }
          : ask.type === "clearInspector"
            ? { type: "inspectorCleared" }
            : { type: "inspectorSourceResolved", source: null }
    const { shadow } = await mount(send)
    fire(doc.getElementById("card")!, clickOn(win))
    await flush()

    typeInto(win, shadow.querySelector<HTMLInputElement>("#mi-input-color")!, "#00dadb")
    await flush()

    const status = shadow.querySelector<HTMLElement>(".mi-status")!
    expect(status.dataset.miError).toBe("true")
    expect(status.textContent).toContain("session storage is unavailable")
    // The edit is still on the page: only the record behind it failed to persist.
    expect(sheetText()).toContain("#00dadb")
  })

  test("a save that rejects is reported inline and never becomes an unhandled rejection", async () => {
    pageWith(`<div id="card" style="color:#111111;">Card</div>`)
    const send: InspectorSend = async (ask) => {
      if (ask.type === "saveInspector") throw new Error("the extension context is gone")
      if (ask.type === "loadInspector") return { type: "inspectorLoaded", record: null }
      if (ask.type === "clearInspector") return { type: "inspectorCleared" }
      return { type: "inspectorSourceResolved", source: null }
    }
    const rejections: unknown[] = []
    const watch = (event: { reason?: unknown }): void => {
      rejections.push(event.reason)
    }
    process.on("unhandledRejection", watch)
    try {
      const { shadow } = await mount(send)
      fire(doc.getElementById("card")!, clickOn(win))
      await flush()

      typeInto(win, shadow.querySelector<HTMLInputElement>("#mi-input-color")!, "#00dadb")
      await flush()

      const status = shadow.querySelector<HTMLElement>(".mi-status")!
      expect(status.dataset.miError).toBe("true")
      expect(status.textContent).toMatch(/could not save/i)
      expect(rejections).toEqual([])
    } finally {
      process.off("unhandledRejection", watch)
    }
  })

  test("a save that fails after teardown is swallowed instead of touching a destroyed panel", async () => {
    pageWith(`<div id="card" style="color:#111111;">Card</div>`)
    let refuse: ((answer: InspectorAnswer) => void) | undefined
    const send: InspectorSend = async (ask) => {
      if (ask.type === "saveInspector") {
        return new Promise<InspectorAnswer>((resolve) => {
          refuse = resolve
        })
      }
      if (ask.type === "loadInspector") return { type: "inspectorLoaded", record: null }
      if (ask.type === "clearInspector") return { type: "inspectorCleared" }
      return { type: "inspectorSourceResolved", source: null }
    }
    const { shadow, controller } = await mount(send)
    fire(doc.getElementById("card")!, clickOn(win))
    await flush()

    previewInto(win, shadow.querySelector<HTMLInputElement>("#mi-input-color")!, "#00dadb")
    await flush()
    // The panel goes with the controller, so hold on to the element it would report into.
    const status = shadow.querySelector<HTMLElement>(".mi-status")!
    expect(status.textContent).toBe("")

    // `destroy` accepts the open burst, which is the save that is still in flight.
    controller.destroy()
    await flush()

    refuse?.({ type: "inspectorError", message: "session storage is unavailable" })
    await flush()

    expect(status.textContent).toBe("")
  })

  test("selecting a different element clears a stale unsafe-value status", async () => {
    pageWith(`<div id="card" style="color:#111111;">Card</div><div id="other">Other</div>`)
    const { send } = fakeInspectorPort()
    const { shadow } = await mount(send)
    fire(doc.getElementById("card")!, clickOn(win))
    await flush()

    const colorInput = shadow.querySelector<HTMLInputElement>("#mi-input-color")!
    const status = shadow.querySelector<HTMLElement>(".mi-status")!
    previewInto(win, colorInput, "red;} .evil{color:red")
    await flush()
    expect(status.textContent).not.toBe("")

    fire(doc.getElementById("other")!, clickOn(win))
    await flush()

    expect(status.textContent).toBe("")
  })

  test("reselecting the same element through its own breadcrumb keeps an unrelated handoff status visible", async () => {
    pageWith(`<div id="card" style="color:#111111;">Card</div>`)
    const { send } = fakeInspectorPort()
    const { shadow } = await mount(send)
    fire(doc.getElementById("card")!, clickOn(win))
    await flush()

    typeInto(win, shadow.querySelector<HTMLInputElement>("#mi-input-color")!, "#00dadb")
    await flush()
    shadow.querySelector<HTMLButtonElement>('[aria-label="Copy prompt"]')!.click()
    await flush()

    const status = shadow.querySelector<HTMLElement>(".mi-status")!
    expect(status.textContent).toMatch(/copied/i)

    // The element's own "current" breadcrumb re-runs `select` on the exact same element:
    // a re-render, not a selection change, so an unrelated status must survive it.
    shadow.querySelector<HTMLButtonElement>('.mi-crumb[aria-current="true"]')!.click()
    await flush()

    expect(status.textContent).toMatch(/copied/i)
  })
})

describe("panel placement", () => {
  test("the panel picks a viewport corner that does not cover the selected element", async () => {
    pageWith(`<div id="card">Card</div>`)
    const { send } = fakeInspectorPort()
    const { shadow } = await mount(send)
    const card = doc.getElementById("card")!
    // Sits right where the default bottom-right panel corner would be drawn.
    card.getBoundingClientRect = () => ({
      left: 900,
      top: 600,
      width: 100,
      height: 100,
      right: 1000,
      bottom: 700,
      x: 900,
      y: 600,
      toJSON: () => ({})
    })

    fire(card, clickOn(win))
    await flush()

    const panel = shadow.querySelector<HTMLElement>(".mi-panel")!
    expect(panel.style.right).toBe("auto")
    expect(panel.style.left).toBe("16px")
  })

  test("scrolling or resizing the viewport recomputes the panel's corner placement", async () => {
    pageWith(`<div id="card">Card</div>`)
    const { send } = fakeInspectorPort()
    const { shadow } = await mount(send)
    const card = doc.getElementById("card")!

    fire(card, clickOn(win))
    await flush()

    const panel = shadow.querySelector<HTMLElement>(".mi-panel")!
    expect(panel.style.right).toBe("16px") // the default corner, with nothing in the way

    // The page scrolls; the same element's fixed-viewport rect now sits over that corner.
    card.getBoundingClientRect = () => ({
      left: 900,
      top: 600,
      width: 100,
      height: 100,
      right: 1000,
      bottom: 700,
      x: 900,
      y: 600,
      toJSON: () => ({})
    })
    win.dispatchEvent(new win.Event("scroll"))
    await flush()

    expect(panel.style.right).toBe("auto")
    expect(panel.style.left).toBe("16px")
  })

  test("scrolling or resizing the viewport also moves the hover outline and tag", async () => {
    pageWith(`<button id="btn" class="primary">Click</button>`)
    const { send } = fakeInspectorPort()
    const { shadow } = await mount(send)
    const button = doc.getElementById("btn")!
    button.getBoundingClientRect = () => ({ left: 10, top: 20, width: 100, height: 30, right: 110, bottom: 50, x: 10, y: 20, toJSON: () => ({}) })

    fire(button, pointerAt(win, "pointermove"))

    const outline = shadow.querySelector<HTMLElement>(".mi-outline")!
    const tag = shadow.querySelector<HTMLElement>(".mi-tag")!
    expect(outline.style.left).toBe("10px")
    expect(tag.style.left).toBe("10px")

    button.getBoundingClientRect = () => ({ left: 40, top: 80, width: 100, height: 30, right: 140, bottom: 110, x: 40, y: 80, toJSON: () => ({}) })
    win.dispatchEvent(new win.Event("scroll"))
    await flush()

    expect(outline.style.left).toBe("40px")
    expect(outline.style.top).toBe("80px")
    expect(tag.style.left).toBe("40px")
  })
})

describe("editability and selection targets", () => {
  test("selecting the document root and body works, and the applied rule targets html or body", async () => {
    pageWith(`<div id="card">Card</div>`)
    doc.body.style.margin = "0px"
    const { send } = fakeInspectorPort()
    const { shadow } = await mount(send)

    fire(doc.body, clickOn(win))
    await flush()
    const bgInput = shadow.querySelector<HTMLInputElement>("#mi-input-background-color")!
    previewInto(win, bgInput, "#00dadb")
    await flush()
    expect(sheetText()).toContain("body {")

    fire(doc.documentElement, clickOn(win))
    await flush()
    const marginInput = shadow.querySelector<HTMLInputElement>("#mi-input-margin")!
    previewInto(win, marginInput, "0px")
    await flush()
    expect(sheetText()).toContain("html {")
  })

  test("duplicate selectors: editing one of two identical siblings only targets that one", async () => {
    pageWith(`<main id="app"><section class="card">One</section><section class="card">Two</section></main>`)
    const { send } = fakeInspectorPort()
    const { shadow } = await mount(send)
    const second = doc.querySelectorAll("section.card")[1] as HTMLElement

    fire(second, clickOn(win))
    await flush()
    const bgInput = shadow.querySelector<HTMLInputElement>("#mi-input-background-color")!
    previewInto(win, bgInput, "#00dadb")
    await flush()

    const css = sheetText()
    expect(css).toContain("section.card:nth-of-type(2)")
    expect(css).not.toContain("section.card {")
  })

  test("selecting an element removed from the DOM after picking it clears the panel without throwing", async () => {
    pageWith(`<div id="card">Card</div>`)
    const { send } = fakeInspectorPort()
    const { shadow } = await mount(send)
    const card = doc.getElementById("card")!
    fire(card, clickOn(win))
    await flush()
    expect(shadow.querySelector<HTMLElement>(".mi-panel")!.hidden).toBe(false)

    card.remove()
    await flush()
    await flush()

    expect(shadow.querySelector<HTMLElement>(".mi-panel")!.hidden).toBe(true)
  })

  test("an element inside an open shadow root shows a warning and disables the inputs", async () => {
    pageWith(`<div id="shadow-host"></div>`)
    const { send } = fakeInspectorPort()
    const { shadow } = await mount(send)
    const hostEl = doc.getElementById("shadow-host")!
    const pageShadow = hostEl.attachShadow({ mode: "open" })
    const inner = doc.createElement("p")
    inner.textContent = "inside"
    pageShadow.append(inner)

    fire(inner, clickOn(win))
    await flush()

    const warning = shadow.querySelector<HTMLElement>(".mi-warning")!
    expect(warning.hidden).toBe(false)
    expect(warning.textContent).toContain("shadow root")
    expect(shadow.querySelector<HTMLInputElement>("#mi-input-color")!.disabled).toBe(true)
  })

  test("an iframe element shows a warning instead of a property panel", async () => {
    pageWith(`<iframe id="frame"></iframe>`)
    const { send } = fakeInspectorPort()
    const { shadow } = await mount(send)
    fire(doc.getElementById("frame")!, clickOn(win))
    await flush()

    const warning = shadow.querySelector<HTMLElement>(".mi-warning")!
    expect(warning.hidden).toBe(false)
    expect(warning.textContent).toContain("iframe")
  })

  test("an arrow key typed in a page form control does not move the selection", async () => {
    pageWith(
      `<main id="app"><section id="parent"><span id="one">1</span><span id="two">2</span></section><input id="field"></main>`
    )
    const { send } = fakeInspectorPort()
    const { shadow } = await mount(send)
    fire(doc.getElementById("two")!, clickOn(win))
    await flush()

    const countBefore = shadow.querySelectorAll<HTMLButtonElement>(".mi-crumb").length

    fire(doc.getElementById("field")!, key(win, "ArrowUp"))
    await flush()

    // ArrowUp would select the parent, shortening the breadcrumb by one. Typing in the
    // page's own field must move the caret, not the inspector's selection.
    expect(shadow.querySelectorAll<HTMLButtonElement>(".mi-crumb").length).toBe(countBefore)
  })

  test("an arrow key typed in a panel field does not move the selection", async () => {
    pageWith(`<main id="app"><section id="parent"><span id="one">1</span><span id="two">2</span></section></main>`)
    const { send } = fakeInspectorPort()
    const { shadow } = await mount(send)
    fire(doc.getElementById("two")!, clickOn(win))
    await flush()

    const countBefore = shadow.querySelectorAll<HTMLButtonElement>(".mi-crumb").length

    fire(shadow.querySelector<HTMLInputElement>("#mi-input-padding")!, key(win, "ArrowUp"))
    await flush()

    expect(shadow.querySelectorAll<HTMLButtonElement>(".mi-crumb").length).toBe(countBefore)
  })

  /**
   * Escape is deliberately not gated by the form-control check: it is the way out of
   * inspect mode from anywhere, including a field the reader is typing in.
   */
  test("Escape leaves inspect mode from a page form control and from a panel field alike", async () => {
    pageWith(`<main id="app"><span id="two">2</span><input id="field"></main>`)
    const { send } = fakeInspectorPort()
    let exits = 0
    const { shadow } = await mount(send, {
      onExit: () => {
        exits += 1
      }
    })
    fire(doc.getElementById("two")!, clickOn(win))
    await flush()

    fire(doc.getElementById("field")!, key(win, "Escape"))
    await flush()
    expect(exits).toBe(1)

    fire(shadow.querySelector<HTMLInputElement>("#mi-input-padding")!, key(win, "Escape"))
    await flush()
    expect(exits).toBe(2)
  })

  test("the inspector stylesheet disables its own transitions under reduced motion", async () => {
    pageWith(`<div id="card">Card</div>`)
    const { send } = fakeInspectorPort()
    const { shadow } = await mount(send)
    const style = shadow.querySelector<HTMLStyleElement>(".mi-root style")!
    expect(style.textContent).toContain("prefers-reduced-motion: reduce")
    expect(style.textContent).toContain("transition: none")
  })
})

describe("source resolution", () => {
  test("a source that resolves before the first edit lands in the record's source map", async () => {
    pageWith(`<div id="card">Card</div>`)
    const resolved: SourceLocation = { file: "src/App.tsx", line: 4, column: 2, component: "Card", precision: "authored" }
    const { send, recordOf } = fakeInspectorPort(null, resolved)
    const { shadow } = await mount(send)

    // Pick the element and let the lookup settle before any edit exists.
    fire(doc.getElementById("card")!, clickOn(win))
    await flush()

    typeInto(win, shadow.querySelector<HTMLInputElement>("#mi-input-background-color")!, "#00dadb")
    await flush()

    expect(recordOf()?.sources).toEqual({ "#card": resolved })
    // The change row itself carries no source metadata any more.
    expect(Object.keys(recordOf()!.changes[0]!).sort()).toEqual(["after", "before", "property", "selector"])
    expect(recordOf()?.changes[0]?.after).toBe("#00dadb")
  })

  test("a source that resolves after a typing burst reaches the saved record", async () => {
    pageWith(`<div id="card">Card</div>`)
    const resolved: SourceLocation = { file: "src/App.tsx", line: 4, column: 2, component: "Card", precision: "authored" }
    const { send, recordOf } = fakeInspectorPort(null, resolved)
    const { shadow } = await mount(send)
    const card = doc.getElementById("card")!

    // Select and edit in the same tick, before the async "resolveInspectorSource"
    // answer settles, so the first saved record carries no source yet.
    fire(card, clickOn(win))
    typeInto(win, shadow.querySelector<HTMLInputElement>("#mi-input-background-color")!, "#00dadb")
    expect(recordOf()?.sources).toEqual({})

    await flush()

    expect(recordOf()?.sources).toEqual({ "#card": resolved })
  })

  test("the source map survives undo and redo, and holds one entry per changed selector", async () => {
    pageWith(`<main id="app"><div id="card">Card</div><div id="title">Title</div></main>`)
    const resolved: SourceLocation = { file: "src/App.tsx", line: 4, column: 2, component: "Card", precision: "authored" }
    const { send, recordOf } = fakeInspectorPort(null, resolved)
    const { shadow } = await mount(send)

    fire(doc.getElementById("card")!, clickOn(win))
    await flush()
    typeInto(win, shadow.querySelector<HTMLInputElement>("#mi-input-background-color")!, "#00dadb")
    await flush()

    fire(doc.getElementById("title")!, clickOn(win))
    await flush()
    typeInto(win, shadow.querySelector<HTMLInputElement>("#mi-input-margin")!, "4px")
    await flush()

    // Two selectors, one map: each one keeps its own entry.
    expect(recordOf()?.sources).toEqual({ "#card": resolved, "#title": resolved })

    shadow.querySelector<HTMLButtonElement>('[aria-label="Undo change"]')!.click()
    await flush()
    expect(recordOf()?.changes).toHaveLength(1)
    expect(recordOf()?.sources).toEqual({ "#card": resolved })

    shadow.querySelector<HTMLButtonElement>('[aria-label="Redo change"]')!.click()
    await flush()
    expect(recordOf()?.changes).toHaveLength(2)
    expect(recordOf()?.sources).toEqual({ "#card": resolved, "#title": resolved })
  })

  test("a restored record keeps the source map it was saved with", async () => {
    pageWith(`<div id="card">Card</div>`)
    const resolved: SourceLocation = { file: "src/App.tsx", line: 4, column: 2, component: "Card", precision: "authored" }
    const saved: ChangeRecord = {
      url: doc.location.href,
      tailwind: false,
      changes: [{ selector: "#card", property: "padding", before: "0px", after: "12px" }],
      sources: { "#card": resolved }
    }
    // The fake resolves nothing new, so only the restored map can supply the source.
    const { send, recordOf } = fakeInspectorPort(saved, null)
    const { shadow } = await mount(send)

    fire(doc.getElementById("card")!, clickOn(win))
    await flush()
    typeInto(win, shadow.querySelector<HTMLInputElement>("#mi-input-background-color")!, "#00dadb")
    await flush()

    expect(recordOf()?.changes).toHaveLength(2)
    expect(recordOf()?.sources).toEqual({ "#card": resolved })
  })

  test("the resolved component name reaches the panel, whichever adapter found it", async () => {
    for (const component of ["Card", "AppHeader"]) {
      pageWith(`<div id="card">Card</div>`)
      const resolved: SourceLocation = {
        file: "src/App.tsx",
        line: 4,
        column: 2,
        component,
        precision: "authored"
      }
      const { send } = fakeInspectorPort(null, resolved)
      const { shadow } = await mount(send)

      fire(doc.getElementById("card")!, clickOn(win))
      // The lookup is a round trip through the MAIN world, so the pick itself claims nothing.
      expect(shadow.querySelector<HTMLElement>(".mi-component")!.hidden).toBe(true)

      await flush()

      const label = shadow.querySelector<HTMLElement>(".mi-component")!
      expect(label.hidden).toBe(false)
      expect(label.querySelector<HTMLElement>(".mi-component-name")!.textContent).toBe(component)

      activeController?.destroy()
      activeController = null
      doc.documentElement.replaceChildren(doc.createElement("head"), doc.createElement("body"))
    }
  })

  test("an element whose source has no component name shows no component in the panel", async () => {
    pageWith(`<main id="app"><div id="card">Card</div><div id="title">Title</div></main>`)
    const { send } = fakeInspectorPort(null, {
      file: "src/App.tsx",
      line: 4,
      column: 2,
      component: null,
      precision: "transformed"
    })
    const { shadow } = await mount(send)

    fire(doc.getElementById("card")!, clickOn(win))
    await flush()

    expect(shadow.querySelector<HTMLElement>(".mi-component")!.hidden).toBe(true)
  })

  test("a restored record's own source map names the component with no new lookup", async () => {
    pageWith(`<div id="card">Card</div>`)
    const resolved: SourceLocation = {
      file: "src/App.tsx",
      line: 4,
      column: 2,
      component: "Card",
      precision: "authored"
    }
    const saved: ChangeRecord = {
      url: doc.location.href,
      tailwind: false,
      changes: [{ selector: "#card", property: "padding", before: "0px", after: "12px" }],
      sources: { "#card": resolved }
    }
    // The fake resolves nothing new, so only the restored map can name this component.
    const { send, calls } = fakeInspectorPort(saved, null)
    const { shadow } = await mount(send)

    fire(doc.getElementById("card")!, clickOn(win))
    await flush()

    expect(shadow.querySelector<HTMLElement>(".mi-component-name")!.textContent).toBe("Card")
    expect(calls.filter((ask) => ask.type === "resolveInspectorSource")).toEqual([])
  })

  test("hover never claims a component name the isolated world cannot read", async () => {
    // A React element carries its fiber on a runtime key, out of reach of this world.
    pageWith(`<button id="btn" class="primary">Click</button>`)
    const button = doc.getElementById("btn")!
    ;(button as unknown as Record<string, unknown>)["__reactFiber$abc"] = {
      _debugOwner: { type: { name: "Card" } }
    }
    const { send } = fakeInspectorPort(null, {
      file: "src/App.tsx",
      line: 4,
      column: 2,
      component: "Card",
      precision: "authored"
    })
    const { shadow } = await mount(send)

    fire(button, pointerAt(win, "pointermove"))

    const tag = shadow.querySelector<HTMLElement>(".mi-tag")!
    expect(tag.textContent).toBe("button.primary")
    expect(tag.querySelector(".mi-tag-component")).toBeNull()
  })

  test("a stale source answer after the controller is destroyed does not save stale state", async () => {
    pageWith(`<div id="card">Card</div>`)
    let resolveFirst: ((source: SourceLocation | null) => void) | undefined
    let record: ChangeRecord | null = null
    const recordOf = (): ChangeRecord | null => record
    const calls: Array<Parameters<InspectorSend>[0]> = []
    const send: InspectorSend = async (ask) => {
      calls.push(ask)
      switch (ask.type) {
        case "loadInspector":
          return { type: "inspectorLoaded", record }
        case "saveInspector":
          record = ask.record
          return { type: "inspectorSaved" }
        case "clearInspector":
          record = null
          return { type: "inspectorCleared" }
        case "resolveInspectorSource":
          return new Promise((resolve) => {
            resolveFirst = (source) => resolve({ type: "inspectorSourceResolved", source })
          })
      }
    }

    const { shadow, controller } = await mount(send)
    const card = doc.getElementById("card")!
    fire(card, clickOn(win))
    typeInto(win, shadow.querySelector<HTMLInputElement>("#mi-input-background-color")!, "#00dadb")
    await flush() // the change is saved with no source; the lookup is still in flight

    // Destroying the controller is what leaving inspect mode, or a host replace, both do.
    controller.destroy()
    await flush()
    const callsAfterDestroy = calls.length

    // The stale lookup settles long after teardown.
    resolveFirst?.({ file: "src/App.tsx", line: 1, column: 1, component: "Card", precision: "authored" })
    await flush()

    // A destroyed controller must not update or save anything from a stale answer.
    expect(calls.length).toBe(callsAfterDestroy)
    expect(recordOf()?.sources).toEqual({})
  })
})

describe("closed-shadow retargeting", () => {
  test("clicking a panel control never selects the shadow host, even when the observed target is retargeted to it", async () => {
    pageWith(`<main id="app"><div id="card" class="target" style="color:#111111;">Card</div></main>`)
    const { send } = fakeInspectorPort()
    const { shadow, host } = await mountWithHost(send)
    fire(doc.getElementById("card")!, clickOn(win))
    await flush()

    const crumbsBefore = shadow.querySelectorAll(".mi-crumb").length

    const colorInput = shadow.querySelector<HTMLInputElement>("#mi-input-color")!
    previewInto(win, colorInput, "#00dadb")
    await flush()

    const undoButton = shadow.querySelector<HTMLButtonElement>('[aria-label="Undo change"]')!
    // A real composed click dispatched from a control inside the shadow tree, with
    // `composedPath()` overridden to the truncated array a real closed shadow root
    // delivers to a document-level listener: everything below the host collapses away.
    const event = clickOn(win)
    Object.defineProperty(event, "composedPath", { value: () => [host, doc] })
    undoButton.dispatchEvent(event)
    await flush()

    // The button's own handler still ran: the color edit was undone.
    expect(sheetText()).not.toContain("#00dadb")
    // But the retargeted click was not read as a page pick of the host: the panel
    // still shows #card, not a new (and much shorter) selection at the host.
    const crumbsAfter = shadow.querySelectorAll(".mi-crumb")
    expect(crumbsAfter.length).toBe(crumbsBefore)
    expect(crumbsAfter[crumbsAfter.length - 1]!.textContent).toContain("target")
  })
})

/** Like `mount`, but also returns the shadow host, for the one test that needs to name it
 * as the retargeted `composedPath()` origin. */
const mountWithHost = async (
  send: InspectorSend
): Promise<{ readonly shadow: ShadowRoot; readonly host: Element; readonly controller: InspectorController }> => {
  const { host, shadow } = openTestShadow(doc)
  const history = await loadInitialHistory(doc, send)
  const controller = createInspectorController(doc, win, history, {
    send,
    onExit: () => {},
    onHistoryChange: () => {},
    beginCopyPrompt: () => ({ ok: true, pending: Promise.resolve() }),
    sendToMorph: async () => ({ ok: true })
  })
  shadow.append(controller.root)
  activeController = controller
  return { host, shadow, controller }
}
