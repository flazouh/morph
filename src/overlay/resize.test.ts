import { describe, expect, test } from "bun:test"
import { applyRect, moveRect, resizeRect, resolveDisplayRect, type ResizeBounds, type ResizeCorner } from "./resize"

const start = { left: 400, top: 200, width: 400, height: 500 }
const bounds: ResizeBounds = {
  left: 24,
  top: 24,
  right: 1176,
  bottom: 876,
  minWidth: 320,
  minHeight: 360
}

describe("chat corner resizing", () => {
  const cases: ReadonlyArray<{
    corner: ResizeCorner
    delta: { x: number; y: number }
    expected: typeof start
  }> = [
    {
      corner: "north-west",
      delta: { x: -100, y: -80 },
      expected: { left: 300, top: 120, width: 500, height: 580 }
    },
    {
      corner: "north-east",
      delta: { x: 100, y: -80 },
      expected: { left: 400, top: 120, width: 500, height: 580 }
    },
    {
      corner: "south-west",
      delta: { x: -100, y: 80 },
      expected: { left: 300, top: 200, width: 500, height: 580 }
    },
    {
      corner: "south-east",
      delta: { x: 100, y: 80 },
      expected: { left: 400, top: 200, width: 500, height: 580 }
    }
  ]

  for (const { corner, delta, expected } of cases) {
    test(`${corner} expands in its drag direction`, () => {
      expect(resizeRect(start, delta, corner, bounds)).toEqual(expected)
    })
  }

  test("a corner cannot cross the minimum size or viewport margin", () => {
    expect(resizeRect(start, { x: 1000, y: 1000 }, "north-west", bounds)).toEqual({
      left: 480,
      top: 340,
      width: 320,
      height: 360
    })
    expect(resizeRect(start, { x: 1000, y: 1000 }, "south-east", bounds)).toEqual({
      left: 400,
      top: 200,
      width: 776,
      height: 676
    })
  })

  test("a viewport smaller than the preferred minimum remains resizable", () => {
    expect(
      resizeRect(
        { left: 24, top: 24, width: 252, height: 252 },
        { x: -100, y: -100 },
        "north-west",
        { left: 24, top: 24, right: 276, bottom: 276, minWidth: 320, minHeight: 360 }
      )
    ).toEqual({ left: 24, top: 24, width: 252, height: 252 })
  })
})

describe("chat repositioning", () => {
  test("moves the card by the pointer delta without changing its size", () => {
    expect(moveRect(start, { x: -140, y: 90 }, bounds)).toEqual({
      left: 260,
      top: 290,
      width: 400,
      height: 500
    })
  })

  test("keeps the complete card inside the viewport margin", () => {
    expect(moveRect(start, { x: -1000, y: 1000 }, bounds)).toEqual({
      left: 24,
      top: 376,
      width: 400,
      height: 500
    })
  })

  test("resolveDisplayRect widens the rect to the settings minimum and anchors to the same right edge", () => {
    const placement = { left: 700, top: 100, width: 380, height: 720 }
    const display = resolveDisplayRect(placement, 600, 24)
    // right edge = 700 + 380 = 1080; new left = 1080 - 600 = 480
    expect(display).toEqual({ left: 480, top: 100, width: 600, height: 720 })
  })

  test("resolveDisplayRect leaves the rect alone when it is already wider than the settings minimum", () => {
    const placement = { left: 200, top: 100, width: 760, height: 820 }
    expect(resolveDisplayRect(placement, 600, 24)).toBe(placement)
  })

  test("resolveDisplayRect clamps the left edge to the viewport inset", () => {
    // Placement is at the far-left edge; widening must not push left below inset.
    const placement = { left: 24, top: 100, width: 380, height: 720 }
    const display = resolveDisplayRect(placement, 600, 24)
    expect(display.left).toBe(24)
    expect(display.width).toBe(600)
  })

  test("applies only fixed-position geometry to the card", () => {
    const host = document.createElement("div")
    host.style.cssText = "visibility:visible;transition:none;"

    applyRect(host, start)

    expect(host.style.cssText).toContain("visibility: visible")
    expect(host.style.cssText).toContain("transition: none")
    expect(host.style.left).toBe("400px")
    expect(host.style.top).toBe("200px")
    expect(host.style.width).toBe("400px")
    expect(host.style.height).toBe("500px")
    expect(host.style.right).toBe("auto")
    expect(host.style.bottom).toBe("auto")
    expect(host.style.transform).toBe("none")
  })
})
