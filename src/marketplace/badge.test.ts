import { describe, expect, test } from "bun:test"
import { badgeFor, markTab, NO_BADGE, type BadgePorts } from "./badge"
import type { PackageMatch } from "./discovery"
import type { InstalledLibrary } from "./installer"

const match = (slug: string, installed: boolean): PackageMatch =>
  ({ package: { slug, name: slug, version: "1.0.0" }, reason: "Matches /", installed }) as unknown as PackageMatch

const library = { active: {} } as unknown as InstalledLibrary

const ports = (
  found: ReadonlyArray<PackageMatch> | Error
): BadgePorts & { readonly shown: Array<readonly [number, { readonly text: string; readonly title: string }]>; readonly asked: Array<string> } => {
  const shown: Array<readonly [number, { readonly text: string; readonly title: string }]> = []
  const asked: Array<string> = []
  return {
    shown,
    asked,
    library: async () => library,
    find: async (location) => {
      asked.push(location.pathname)
      if (found instanceof Error) throw found
      return found
    },
    show: async (tabId, badge) => {
      shown.push([tabId, badge])
    }
  }
}

describe("badgeFor", () => {
  test("counts what the reader could add, and says so", () => {
    expect(badgeFor(1)).toEqual({ text: "1", title: "1 Morph for this page" })
    expect(badgeFor(3)).toEqual({ text: "3", title: "3 Morphs for this page" })
  })

  test("a long list is a short badge", () => {
    expect(badgeFor(12)).toEqual({ text: "9+", title: "12 Morphs for this page" })
  })

  test("nothing to add is no badge at all", () => {
    expect(badgeFor(0)).toEqual(NO_BADGE)
    expect(NO_BADGE.text).toBe("")
  })
})

describe("markTab", () => {
  test("a page with Morphs the reader does not have wears their count", async () => {
    const port = ports([match("a/one", false), match("a/two", false), match("a/three", true)])
    expect(await markTab(port, 7, "https://f5bot.com/tiers")).toBe(2)
    expect(port.asked).toEqual(["/tiers"])
    expect(port.shown).toEqual([[7, { text: "2", title: "2 Morphs for this page" }]])
  })

  test("a Morph the reader already installed is not news, so it is not counted", async () => {
    const port = ports([match("a/one", true)])
    expect(await markTab(port, 7, "https://f5bot.com/")).toBe(0)
    expect(port.shown).toEqual([[7, NO_BADGE]])
  })

  test("a page the extension cannot act on is never looked up", async () => {
    for (const url of [undefined, "", "about:blank", "chrome://extensions", "chrome-extension://abc/panel.html", "file:///tmp/x.html"]) {
      const port = ports([match("a/one", false)])
      expect(await markTab(port, 7, url)).toBe(0)
      expect(port.asked).toEqual([])
      expect(port.shown).toEqual([[7, NO_BADGE]])
    }
  })

  test("a marketplace that cannot answer clears the badge, so no count outlives its page", async () => {
    const port = ports(new Error("offline"))
    expect(await markTab(port, 7, "https://f5bot.com/")).toBe(0)
    expect(port.shown).toEqual([[7, NO_BADGE]])
  })

  test("a badge that cannot be drawn is not an error the caller has to handle", async () => {
    const port = {
      ...ports([match("a/one", false)]),
      show: async () => {
        throw new Error("the tab went away")
      }
    }
    expect(await markTab(port, 7, "https://f5bot.com/")).toBe(1)
  })
})
