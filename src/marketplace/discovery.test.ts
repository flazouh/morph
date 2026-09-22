import { describe, expect, test } from "bun:test"
import type { PackageSummary } from "./api/http"
import { currentPageDiscovery, summaryMatches } from "./discovery"

const item = (
  slug: string,
  origin: string,
  paths: ReadonlyArray<string>,
  version = "1.0.0"
): PackageSummary => ({
  slug,
  name: slug,
  summary: "Quiet",
  origin,
  paths,
  version,
  runtime: "sandbox-v1",
  license: "MIT",
  installs: 0,
  stars: 0,
  updatedAt: "2026-09-09T20:00:00.000Z"
})

describe("current-page marketplace discovery", () => {
  test("matches the exact origin and pathname locally", () => {
    const summary = item("alex/one", "https://example.com", ["/one"])
    expect(summaryMatches(summary, new URL("https://example.com/one?private=yes"))).toBe(true)
    expect(summaryMatches(summary, new URL("https://example.com/two"))).toBe(false)
    expect(summaryMatches(summary, new URL("https://other.example/one"))).toBe(false)
  })

  test("queries one time per origin and never sends the browsing path", async () => {
    const queries: unknown[] = []
    const discovery = currentPageDiscovery({
      list: async (query) => {
        queries.push(query)
        return {
          items: [
            item("alex/one", "https://example.com", ["/one"]),
            item("alex/two", "https://example.com", ["/two"])
          ],
          nextCursor: null
        }
      }
    })
    const installed = { active: {}, history: {} }

    expect((await discovery.find(new URL("https://example.com/one?token=secret"), installed)).map((match) => match.package.slug)).toEqual(["alex/one"])
    expect((await discovery.find(new URL("https://example.com/two"), installed)).map((match) => match.package.slug)).toEqual(["alex/two"])
    expect(queries).toEqual([{ origin: "https://example.com", limit: 48 }])
    expect(JSON.stringify(queries)).not.toContain("one")
    expect(JSON.stringify(queries)).not.toContain("token")
  })

  test("marks only the installed current version", async () => {
    const current = item("alex/one", "https://example.com", ["/one"], "2.0.0")
    const discovery = currentPageDiscovery({
      list: async () => ({ items: [current], nextCursor: null })
    })
    const matches = await discovery.find(new URL("https://example.com/one"), {
      active: {
        "alex/one": {
          slug: "alex/one",
          version: "1.0.0"
        } as never
      },
      history: {}
    })
    expect(matches[0]?.installed).toBe(false)
  })
})
