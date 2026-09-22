import { describe, expect, test } from "bun:test"
import { cssFor } from "./css"
import type { ChangeRecord, StyleChange } from "./model"

const change = (
  selector: string,
  property: StyleChange["property"],
  after: string
): StyleChange => ({ selector, property, before: "before", after })

const record = (changes: ReadonlyArray<StyleChange>): ChangeRecord => ({
  url: "https://example.com",
  tailwind: false,
  changes,
  sources: {}
})

describe("cssFor", () => {
  test("returns no CSS for an empty record", () => {
    expect(cssFor(record([]))).toBe("")
  })

  test("groups declarations by selector", () => {
    expect(cssFor(record([
      change("#card", "padding", "12px"),
      change("#title", "color", "red"),
      change("#card", "margin", "4px")
    ]))).toBe([
      "#card {",
      "  padding: 12px !important;",
      "  margin: 4px !important;",
      "}",
      "",
      "#title {",
      "  color: red !important;",
      "}"
    ].join("\n"))
  })

  test("uses stable property order and the latest duplicate value", () => {
    expect(cssFor(record([
      change("#card", "font-size", "18px"),
      change("#card", "color", "red"),
      change("#card", "padding", "8px"),
      change("#card", "color", "blue")
    ]))).toBe([
      "#card {",
      "  padding: 8px !important;",
      "  color: blue !important;",
      "  font-size: 18px !important;",
      "}"
    ].join("\n"))
  })

  test("keeps escaped generated selectors intact", () => {
    const selector = '[data-testid="settings\\ panel"] > button.sm\\:hover'
    expect(cssFor(record([change(selector, "padding", "8px")]))).toContain(`${selector} {`)
  })

  test("drops invalid selectors instead of creating another rule", () => {
    expect(cssFor(record([
      change("button { color: red; }", "padding", "8px"),
      change("#safe", "margin", "4px")
    ]))).toBe("#safe {\n  margin: 4px !important;\n}")
  })

  test.each(["red; background: url(x)", "calc(1px) { color: red", "red } body { color: blue"])(
    "drops a declaration with unsafe value %s",
    (value) => {
      expect(cssFor(record([
        change("#card", "color", value),
        change("#card", "padding", "8px")
      ]))).toBe("#card {\n  padding: 8px !important;\n}")
    }
  )
})
