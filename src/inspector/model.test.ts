import { describe, expect, test } from "bun:test"
import { STYLE_PROPERTIES } from "./model"

describe("inspector model", () => {
  test("lists the six supported properties in control order", () => {
    expect(STYLE_PROPERTIES).toEqual([
      "padding",
      "margin",
      "color",
      "background-color",
      "border-radius",
      "font-size"
    ])
  })
})
