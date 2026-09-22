import { afterEach, describe, expect, test } from "bun:test"
import { randomToken } from "./random-token"

const originalRandomUUID = crypto.randomUUID

afterEach(() => {
  Object.defineProperty(crypto, "randomUUID", { configurable: true, value: originalRandomUUID })
})

describe("randomToken", () => {
  test("returns unique 128-bit hex tokens", () => {
    const a = randomToken()
    const b = randomToken()
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[0-9a-f]{32}$/)
  })

  test("works when crypto.randomUUID is unavailable", () => {
    Object.defineProperty(crypto, "randomUUID", {
      configurable: true,
      value: () => {
        throw new DOMException("randomUUID is not available in this context")
      }
    })
    expect(randomToken()).toMatch(/^[0-9a-f]{32}$/)
  })
})
