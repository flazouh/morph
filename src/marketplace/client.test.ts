import { describe, expect, test } from "bun:test"
import { createMarketplaceClient, MarketplaceFailure } from "./client"
import type { PackageDetail, PackageSummary } from "./api/http"

const summary: PackageSummary = {
  slug: "alex/hn-quiet",
  name: "HN Quiet",
  summary: "A calm Hacker News front page",
  origin: "https://news.ycombinator.com",
  paths: ["/"],
  version: "1.2.0",
  runtime: "declarative-v1",
  license: "MIT",
  installs: 42,
  stars: 7,
  updatedAt: "2026-09-08T20:00:00.000Z"
}

const detail: PackageDetail = {
  ...summary,
  author: { handle: "alex", displayName: "Alex", avatarUrl: null },
  manifest: {
    schema: 1,
    slug: summary.slug,
    version: summary.version,
    summary: summary.summary,
    license: summary.license,
    author: { handle: "alex" },
    scope: { kind: "page", origin: summary.origin, paths: ["/"] },
    runtime: "declarative-v1",
    entry: "view.redesign.json",
    files: {
      "view.redesign.json": "sha256:181fdd46f214709a8305029595836c65c6d2f5ff4a46b6c7269ccbf367099c9d"
    },
    compatibility: { kit: "^1.0.0", chrome: ">=135" },
    artifacts: {
      view: "sha256:7c81d724c975349a70227461ca767a0986f3843f3b95d6cf85ea81887f38c075",
      css: "sha256:9e94873f7504a4da7c134e840970618457481c0b89289a0f9da3d5979d2e5fbe"
    },
    previews: {
      before: "sha256:390ba68063fdc12a200b359589947cc5d6cf1b882b1c59e6b5b9a4dabb37fc69",
      after: "sha256:0d9f8bf1b4bb01a819b4426c305c949101355ce635be9a83ad3cc0b0ec4674f0"
    },
    permissions: { page: ["read:text", "read:attributes", "navigate"], network: [] }
  },
  source: {
    repository: "flazouh/redesign-marketplace",
    commit: "0123456789abcdef0123456789abcdef01234567",
    path: "packages/alex/hn-quiet/1.2.0",
    url: "https://github.com/flazouh/redesign-marketplace/tree/0123456789abcdef0123456789abcdef01234567/packages/alex/hn-quiet/1.2.0"
  },
  files: {
    manifest: "https://raw.githubusercontent.com/flazouh/redesign-marketplace/version/manifest.json",
    source: "https://github.com/flazouh/redesign-marketplace/tree/version/source",
    before: "https://raw.githubusercontent.com/flazouh/redesign-marketplace/version/preview-before.webp",
    after: "https://raw.githubusercontent.com/flazouh/redesign-marketplace/version/preview-after.webp",
    css: "https://raw.githubusercontent.com/flazouh/redesign-marketplace/version/style.css",
    view: "https://raw.githubusercontent.com/flazouh/redesign-marketplace/version/view.json"
  }
}

describe("marketplace client", () => {
  test("lists packages with encoded filters", async () => {
    const requests: string[] = []
    const client = createMarketplaceClient("https://api.redesign.test", async (input) => {
      requests.push(String(input))
      return Response.json({ items: [], nextCursor: null })
    })

    expect(
      await client.list({
        origin: "https://news.ycombinator.com",
        query: "quiet news",
        sort: "popular",
        limit: 12
      })
    ).toEqual({ items: [], nextCursor: null })
    expect(requests).toEqual([
      "https://api.redesign.test/v1/packages?origin=https%3A%2F%2Fnews.ycombinator.com&q=quiet+news&sort=popular&limit=12"
    ])
  })

  test("gets namespaced package details", async () => {
    const requests: string[] = []
    const client = createMarketplaceClient("https://api.redesign.test/", async (input) => {
      requests.push(String(input))
      return Response.json(detail)
    })

    expect(await client.get("alex/hn-quiet")).toEqual(detail)
    expect(requests).toEqual(["https://api.redesign.test/v1/packages/alex/hn-quiet"])
  })

  test("returns the API error code without leaking its response body", async () => {
    const client = createMarketplaceClient("https://api.redesign.test", async () =>
      Response.json({ error: "not_found", detail: "private database text" }, { status: 404 })
    )

    try {
      await client.get("alex/missing")
      throw new Error("expected the request to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(MarketplaceFailure)
      expect(error).toMatchObject({ status: 404, code: "not_found" })
      expect(String(error)).not.toContain("private database text")
    }
  })

  test("records installs and submits public reports", async () => {
    const requests: Array<{ readonly url: string; readonly init?: RequestInit }> = []
    const client = createMarketplaceClient("https://api.redesign.test", async (input, init) => {
      requests.push({ url: String(input), init })
      return init?.body === undefined ? new Response(null, { status: 204 }) : Response.json({ id: "report-1" }, { status: 201 })
    })

    await client.recordInstall("alex/hn-quiet")
    expect(await client.report("alex/hn-quiet", "broken", "Story links no longer render after a reload.")).toEqual({ id: "report-1" })
    expect(requests).toEqual([
      {
        url: "https://api.redesign.test/v1/packages/alex/hn-quiet/install",
        init: { method: "POST" }
      },
      {
        url: "https://api.redesign.test/v1/packages/alex/hn-quiet/reports",
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ category: "broken", detail: "Story links no longer render after a reload." })
        }
      }
    ])
  })
})
