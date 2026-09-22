import { describe, expect, test } from "bun:test"
import { applyChange, discard, redo, removeChange, undo } from "./changes"
import type { ChangeHistory, ChangeRecord, SourceLocation, StyleChange } from "./model"

const record = (
  changes: ReadonlyArray<StyleChange> = [],
  sources: Record<string, SourceLocation> = {}
): ChangeRecord => ({
  url: "https://example.com/settings",
  tailwind: false,
  changes,
  sources
})

const history = (
  changes: ReadonlyArray<StyleChange> = [],
  sources: Record<string, SourceLocation> = {}
): ChangeHistory => ({
  present: record(changes, sources),
  past: [],
  future: []
})

const change = (
  selector: string,
  property: StyleChange["property"],
  before: string,
  after: string
): StyleChange => ({ selector, property, before, after })

describe("applyChange", () => {
  test("keeps empty history empty for an unchanged value", () => {
    const initial = history()
    expect(applyChange(initial, change("#save", "padding", "8px", "8px"))).toBe(initial)
  })

  test("adds one change and saves the prior snapshot", () => {
    const initial = history()
    const next = applyChange(initial, change("#save", "padding", "8px", "12px"))
    expect(next.present.changes).toEqual([change("#save", "padding", "8px", "12px")])
    expect(next.past).toEqual([initial.present])
    expect(next.future).toEqual([])
  })

  test("keeps many changes in application order", () => {
    const first = applyChange(history(), change("#save", "padding", "8px", "12px"))
    const second = applyChange(first, change("#title", "color", "black", "red"))
    expect(second.present.changes).toEqual([
      change("#save", "padding", "8px", "12px"),
      change("#title", "color", "black", "red")
    ])
  })

  test("updates a duplicate selector and property without adding a row", () => {
    const first = applyChange(history(), change("#save", "padding", "8px", "12px"))
    const second = applyChange(first, change("#save", "padding", "12px", "16px"))
    expect(second.present.changes).toEqual([change("#save", "padding", "8px", "16px")])
  })

  test("removes a row when its value returns to the original before value", () => {
    const first = applyChange(history(), change("#save", "padding", "8px", "12px"))
    const second = applyChange(first, change("#save", "padding", "12px", "8px"))
    expect(second.present.changes).toEqual([])
  })
})

describe("history actions", () => {
  test("remove drops only the requested row and can be undone", () => {
    const initial = history([
      change("#save", "padding", "8px", "12px"),
      change("#save", "color", "black", "red")
    ])
    const removed = removeChange(initial, "#save", "padding")
    expect(removed.present.changes).toEqual([change("#save", "color", "black", "red")])
    expect(undo(removed).present).toEqual(initial.present)
  })

  test("remove returns the same history when no row matches", () => {
    const initial = history([change("#save", "padding", "8px", "12px")])
    expect(removeChange(initial, "#title", "padding")).toBe(initial)
  })

  test("undo and redo move through snapshots and clear redo after a new change", () => {
    const one = applyChange(history(), change("#save", "padding", "8px", "12px"))
    const two = applyChange(one, change("#title", "color", "black", "red"))
    const undone = undo(two)
    expect(undone.present).toEqual(one.present)
    expect(redo(undone).present).toEqual(two.present)
    expect(applyChange(undone, change("#title", "font-size", "16px", "18px")).future).toEqual([])
  })

  test("undo or redo at the end returns the same history", () => {
    const initial = history()
    expect(undo(initial)).toBe(initial)
    expect(redo(initial)).toBe(initial)
  })

  test("discard clears all rows and history but keeps page metadata", () => {
    const changed = applyChange(history(), change("#save", "padding", "8px", "12px"))
    expect(discard(changed)).toEqual({
      present: record(),
      past: [],
      future: []
    })
  })

  test("discard drops the source map with the rows it described", () => {
    const source: SourceLocation = {
      file: "src/Card.tsx",
      line: 12,
      column: 4,
      component: "Card",
      precision: "authored"
    }
    const changed = history([change("#save", "padding", "8px", "12px")], { "#save": source })
    expect(discard(changed).present.sources).toEqual({})
  })
})
