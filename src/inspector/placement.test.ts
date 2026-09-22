import { describe, expect, test } from "bun:test"
import { cornerStyle, pickCorner } from "./placement"

const VIEWPORT = { width: 1200, height: 800 }
const PANEL = { width: 280, height: 320 }
const INSET = 16

describe("pickCorner", () => {
  test("keeps the default bottom-right corner when the selection sits away from it", () => {
    const target = { left: 40, top: 40, width: 100, height: 40 }
    expect(pickCorner(target, VIEWPORT, PANEL, INSET)).toBe("bottom-right")
  })

  test("moves to bottom-left when the selection covers the bottom-right corner", () => {
    const target = { left: 1000, top: 550, width: 200, height: 250 }
    expect(pickCorner(target, VIEWPORT, PANEL, INSET)).toBe("bottom-left")
  })

  test("moves to top-right when the selection covers both bottom corners", () => {
    const target = { left: 0, top: 460, width: 1200, height: 200 }
    expect(pickCorner(target, VIEWPORT, PANEL, INSET)).toBe("top-right")
  })

  test("stays on the default corner when only bottom-left is covered", () => {
    const target = { left: 40, top: 550, width: 200, height: 250 }
    expect(pickCorner(target, VIEWPORT, PANEL, INSET)).toBe("bottom-right")
  })

  test("falls back to bottom-right when the selection covers the whole viewport", () => {
    const target = { left: 0, top: 0, width: 1200, height: 800 }
    expect(pickCorner(target, VIEWPORT, PANEL, INSET)).toBe("bottom-right")
  })

  test("a selection that only touches the edge of a corner rect does not count as covering it", () => {
    // The panel's left edge sits at 1200 - 16 - 280 = 904. A target ending exactly there
    // does not overlap the panel rect.
    const target = { left: 700, top: 40, width: 204, height: 40 }
    expect(pickCorner(target, VIEWPORT, PANEL, INSET)).toBe("bottom-right")
  })
})

describe("cornerStyle", () => {
  test("bottom-right anchors right and bottom, leaving top and left free", () => {
    expect(cornerStyle("bottom-right", INSET)).toEqual({
      top: "auto",
      right: `${INSET}px`,
      bottom: `${INSET}px`,
      left: "auto"
    })
  })

  test("top-left anchors top and left, leaving right and bottom free", () => {
    expect(cornerStyle("top-left", INSET)).toEqual({
      top: `${INSET}px`,
      right: "auto",
      bottom: "auto",
      left: `${INSET}px`
    })
  })

  test("bottom-left and top-right anchor their own two edges", () => {
    expect(cornerStyle("bottom-left", INSET)).toEqual({
      top: "auto",
      right: "auto",
      bottom: `${INSET}px`,
      left: `${INSET}px`
    })
    expect(cornerStyle("top-right", INSET)).toEqual({
      top: `${INSET}px`,
      right: `${INSET}px`,
      bottom: "auto",
      left: "auto"
    })
  })
})
