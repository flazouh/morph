import { expect, test } from "bun:test"
import { isInvalidatedExtensionContext } from "./context"

test("only Chrome's exact invalidated-context error requests recovery", () => {
  expect(isInvalidatedExtensionContext(new Error("Extension context invalidated."))).toBe(true)
  expect(isInvalidatedExtensionContext(new Error("Storage failed after Extension context invalidated."))).toBe(false)
  expect(isInvalidatedExtensionContext("Extension context invalidated.")).toBe(false)
})
