import { describe, expect, test } from "bun:test"
import { applyChange, removeChange } from "./changes"
import { handoffPrompt } from "./handoff"
import type { ChangeHistory, ChangeRecord, SourceLocation, StyleChange } from "./model"

const source = (precision: SourceLocation["precision"]): SourceLocation => ({
  file: "src/Card.tsx",
  line: 12,
  column: 4,
  component: "Card",
  precision
})

const change = (
  selector: string,
  property: StyleChange["property"],
  before: string,
  after: string
): StyleChange => ({ selector, property, before, after })

const record = (
  changes: ReadonlyArray<StyleChange>,
  tailwind = false,
  sources: Record<string, SourceLocation> = {}
): ChangeRecord => ({ url: "https://example.com/settings", tailwind, changes, sources })

describe("handoffPrompt", () => {
  test("reports an empty record without element sections", () => {
    expect(handoffPrompt(record([]))).toBe([
      "Apply these visual changes in the source code.",
      "Page: https://example.com/settings",
      "Tailwind: not detected",
      "",
      "No visual changes."
    ].join("\n"))
  })

  test("formats one element with unknown source", () => {
    expect(handoffPrompt(record([
      change("#card", "padding", "8px", "12px")
    ]))).toBe([
      "Apply these visual changes in the source code.",
      "Page: https://example.com/settings",
      "Tailwind: not detected",
      "",
      "Selector: #card",
      "Source: unknown",
      "Before:",
      "#card {",
      "  padding: 8px;",
      "}",
      "After:",
      "#card {",
      "  padding: 12px;",
      "}"
    ].join("\n"))
  })

  test("groups many elements and uses stable declaration order", () => {
    const prompt = handoffPrompt(record([
      change("#card", "font-size", "16px", "18px"),
      change("#title", "color", "black", "red"),
      change("#card", "padding", "8px", "12px")
    ]))
    expect(prompt.indexOf("Selector: #card")).toBeLessThan(prompt.indexOf("Selector: #title"))
    expect(prompt.indexOf("  padding: 8px;")).toBeLessThan(prompt.indexOf("  font-size: 16px;"))
  })

  test("labels authored, transformed, and unknown precision exactly", () => {
    const prompt = handoffPrompt(record(
      [
        change("#authored", "padding", "8px", "12px"),
        change("#generated", "color", "black", "red"),
        change("#uncertain", "margin", "0", "4px")
      ],
      false,
      {
        "#authored": source("authored"),
        "#generated": source("transformed"),
        "#uncertain": source("unknown")
      }
    ))
    expect(prompt).toContain("Source: src/Card.tsx:12:4 (Card, authored)")
    expect(prompt).toContain("Source: src/Card.tsx:12:4 (Card, transformed, not authored)")
    expect(prompt).toContain("Source: src/Card.tsx:12:4 (Card, unknown precision)")
  })

  test("shows missing line, column, and component without fabricated values", () => {
    const location: SourceLocation = {
      file: "src/global.css",
      line: null,
      column: null,
      component: null,
      precision: "transformed"
    }
    expect(handoffPrompt(record(
      [change("body", "margin", "8px", "0")],
      false,
      { body: location }
    ))).toContain("Source: src/global.css (transformed, not authored)")
  })

  test("reads each selector's own entry from one shared source map", () => {
    const card: SourceLocation = {
      file: "src/Card.tsx",
      line: 12,
      column: 4,
      component: "Card",
      precision: "authored"
    }
    const title: SourceLocation = {
      file: "src/Title.tsx",
      line: 3,
      column: 1,
      component: "Title",
      precision: "transformed"
    }
    const prompt = handoffPrompt(record(
      [
        change("#card", "padding", "8px", "12px"),
        change("#title", "color", "black", "red"),
        change("#plain", "margin", "0", "4px")
      ],
      false,
      { "#card": card, "#title": title }
    ))
    expect(prompt).toContain("Selector: #card\nSource: src/Card.tsx:12:4 (Card, authored)")
    expect(prompt).toContain("Selector: #title\nSource: src/Title.tsx:3:1 (Title, transformed, not authored)")
    expect(prompt).toContain("Selector: #plain\nSource: unknown")
  })

  test("two selectors that resolve to one location both name it", () => {
    const shared: SourceLocation = {
      file: "src/List.tsx",
      line: 20,
      column: 6,
      component: "List",
      precision: "authored"
    }
    const prompt = handoffPrompt(record(
      [
        change("#one", "padding", "8px", "12px"),
        change("#two", "padding", "8px", "16px")
      ],
      false,
      { "#one": shared, "#two": shared }
    ))
    expect(prompt.match(/Source: src\/List\.tsx:20:6 \(List, authored\)/g)).toHaveLength(2)
  })

  test("states when Tailwind is detected", () => {
    expect(handoffPrompt(record([], true))).toContain("Tailwind: detected; prefer utility classes")
  })

  test("does not include a removed row", () => {
    const initial: ChangeHistory = {
      present: record([]),
      past: [],
      future: []
    }
    const withPadding = applyChange(initial, change("#card", "padding", "8px", "12px"))
    const withColor = applyChange(withPadding, change("#card", "color", "black", "red"))
    const removed = removeChange(withColor, "#card", "color")
    const prompt = handoffPrompt(removed.present)
    expect(prompt).not.toContain("color:")
    expect(prompt.match(/Selector:/g)).toHaveLength(1)
  })
})
