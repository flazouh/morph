import { describe, expect, test } from "bun:test"
import { changesInstalledPage, isMarketplaceAsk, marketplaceHandler } from "./messages"

describe("marketplace extension messages", () => {
  test("accepts only known message shapes", () => {
    expect(isMarketplaceAsk({ type: "listInstalledPackages" })).toBe(true)
    expect(isMarketplaceAsk({ type: "rollbackPackage", slug: "alex/hn-quiet" })).toBe(true)
    expect(isMarketplaceAsk({ type: "removePackage" })).toBe(false)
    expect(isMarketplaceAsk({ type: "runCode", js: "alert(1)" })).toBe(false)
  })

  test("returns a stable error answer", async () => {
    const handle = marketplaceHandler({
      install: async () => {
        throw new Error("digest mismatch")
      },
      rollback: async () => {
        throw new Error("unused")
      },
      remove: async () => {},
      list: async () => ({ active: {}, history: {} })
    })

    expect(await handle({ type: "installPackage", detail: {} as never })).toEqual({
      type: "marketplaceError",
      message: "digest mismatch"
    })
  })

  test("reloads only after operations that change installed page code", () => {
    expect(changesInstalledPage({ type: "packageRemoved", slug: "alex/hn-quiet" })).toBe(true)
    expect(changesInstalledPage({ type: "installedPackages", library: { active: {}, history: {} } })).toBe(false)
    expect(changesInstalledPage({ type: "marketplaceError", message: "failed" })).toBe(false)
  })
})
