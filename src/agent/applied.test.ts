import { describe, expect, test } from "bun:test"
import { appliedPathOf, appliedOf, hasApplied, isApplied, readApplied } from "./applied"

describe("appliedPathOf", () => {
  test("reads the path a tool result applied to", () => {
    expect(appliedPathOf({ path: "/login", skin: { "page.tsx": "x" } })).toBe("/login")
    expect(appliedPathOf({ path: "/" })).toBe("/")
  })

  test("a path that is not one absolute path is no path at all", () => {
    for (const path of [undefined, null, 3, "", "login", "https://f5bot.com/login", "//host/x"]) {
      expect(appliedPathOf({ path, skin: {} })).toBeUndefined()
    }
    expect(appliedPathOf(undefined)).toBeUndefined()
  })
})

describe("hasApplied", () => {
  test("true when any page wears something", () => {
    expect(hasApplied({ "/": { css: "body{}" } })).toBe(true)
    expect(hasApplied({ "/": {}, "/login": { skin: { "page.tsx": "x" } } })).toBe(true)
  })

  test("false when no page does", () => {
    expect(hasApplied({})).toBe(false)
    expect(hasApplied({ "/": {}, "/login": {} })).toBe(false)
  })
})

describe("readApplied", () => {
  test("this build's shape reads as it is", () => {
    expect(readApplied({ css: "body{}", skin: { "page.tsx": "x" }, script: "1" })).toEqual({ css: "body{}", skin: { "page.tsx": "x" }, script: "1" })
    expect(readApplied({})).toEqual({})
  })

  test("a thread recorded before 2026-09-14 carries one tagged script slot, and reads as the slot it meant", () => {
    expect(readApplied({ script: { kind: "js", source: "1" } })).toEqual({ script: "1" })
    expect(readApplied({ css: "a{}", script: { kind: "skin", files: { "page.tsx": "x" } } })).toEqual({ css: "a{}", skin: { "page.tsx": "x" } })
  })

  test("anything else applied nothing", () => {
    for (const value of [undefined, null, 3, "css", { css: 1 }, { skin: "not files" }, { script: { kind: "other" } }]) {
      expect(readApplied(value)).toEqual({})
    }
    expect(isApplied(readApplied({ css: 1 }))).toBe(false)
  })

  test("a crew script fills one slot", () => {
    expect(appliedOf({ kind: "js", source: "1" })).toEqual({ script: "1" })
    expect(appliedOf({ kind: "skin", files: { "page.tsx": "" } })).toEqual({ skin: { "page.tsx": "" } })
  })
})
