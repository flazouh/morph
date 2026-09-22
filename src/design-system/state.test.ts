import { describe, expect, test } from "bun:test"
import { initialPreview, reducePreview } from "./state"

describe("design system chat preview", () => {
  test("expand toggles between the corner and center layouts", () => {
    const expanded = reducePreview(initialPreview, { type: "toggleExpandedChat" })
    expect(expanded).toMatchObject({ open: true, mode: "expanded" })
    expect(reducePreview(expanded, { type: "toggleExpandedChat" })).toEqual(initialPreview)
  })

  test("minimize keeps the prior layout for the reopen widget", () => {
    const expanded = reducePreview(initialPreview, { type: "toggleExpandedChat" })
    const minimized = reducePreview(expanded, { type: "minimizeChat" })
    expect(minimized).toMatchObject({ open: true, mode: "minimized", restoreMode: "expanded" })
    expect(reducePreview(minimized, { type: "restoreChat" })).toMatchObject({ open: true, mode: "expanded" })
  })

  test("close removes the card and reopen starts at its corner size", () => {
    const closed = reducePreview(initialPreview, { type: "closeChat" })
    expect(closed.open).toBe(false)
    expect(reducePreview(closed, { type: "openChat" })).toEqual(initialPreview)
  })

  test("restore does nothing unless the chat is minimized", () => {
    const expanded = reducePreview(initialPreview, { type: "toggleExpandedChat" })
    expect(reducePreview(initialPreview, { type: "restoreChat" })).toBe(initialPreview)
    expect(reducePreview(initialPreview, { type: "reloadChat" })).toBe(initialPreview)
    expect(reducePreview(expanded, { type: "restoreChat" })).toBe(expanded)
  })
})
