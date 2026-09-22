import { describe, expect, test } from "bun:test"
import type { MarketplaceAnswer } from "./messages"
import { reloadInstalledPage } from "./reload"

const changed: MarketplaceAnswer = { type: "packageRemoved", slug: "alex/hn-quiet" }

describe("marketplace page reload", () => {
  test("reloads the sender tab when the command came from a tab", async () => {
    const calls: string[] = []

    await reloadInstalledPage(changed, 21, {
      active: async () => {
        calls.push("active")
        return 22
      },
      reload: async (tabId) => {
        calls.push(`reload:${tabId}`)
      }
    })

    expect(calls).toEqual(["reload:21"])
  })

  test("reloads the active tab when a side panel has no sender tab", async () => {
    const calls: string[] = []

    await reloadInstalledPage(changed, undefined, {
      active: async () => {
        calls.push("active")
        return 22
      },
      reload: async (tabId) => {
        calls.push(`reload:${tabId}`)
      }
    })

    expect(calls).toEqual(["active", "reload:22"])
  })

  test("does nothing when the answer did not change an installed page", async () => {
    const calls: string[] = []

    await reloadInstalledPage({ type: "marketplaceError", message: "download failed" }, undefined, {
      active: async () => {
        calls.push("active")
        return 22
      },
      reload: async (tabId) => {
        calls.push(`reload:${tabId}`)
      }
    })

    expect(calls).toEqual([])
  })
})
