import { describe, expect, test } from "bun:test"
import { takePage } from "./takeover"

describe("page takeover", () => {
  test("hides GitHub's dashboard slot and restores it", () => {
    const slot = document.createElement("div")
    slot.setAttribute("data-testid", "pulls-dashboard-surface-layout")
    const native = document.createElement("section")
    native.textContent = "GitHub inbox"
    slot.append(native)
    document.body.append(slot)

    const taken = takePage(document, {
      slot: '[data-testid="pulls-dashboard-surface-layout"]',
      fallback: 'react-app[app-name="dashboard-surface"]'
    })

    expect(taken?.parent).toBe(slot)
    expect(native.hidden).toBe(true)
    taken?.restore()
    expect(native.hidden).toBe(false)
    slot.remove()
  })

  test("returns nothing when the slot is missing", () => {
    expect(
      takePage(document, {
        slot: '[data-testid="pulls-dashboard-surface-layout"]'
      })
    ).toBeUndefined()
  })
})
