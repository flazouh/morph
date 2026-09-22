import { describe, expect, test } from "bun:test"
import { marketplaceApi, type MarketplaceRepository, type PackageDetail, type PackageSummary } from "./http"

const item: PackageSummary = {
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
  ...item,
  author: {
    handle: "alex",
    displayName: "Alex",
    avatarUrl: null
  },
  manifest: {
    schema: 1,
    slug: "alex/hn-quiet",
    version: "1.2.0",
    summary: item.summary,
    license: "MIT",
    author: { handle: "alex" },
    scope: { kind: "page", origin: item.origin, paths: ["/"] },
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
    manifest: "https://raw.githubusercontent.com/flazouh/redesign-marketplace/0123456789abcdef0123456789abcdef01234567/packages/alex/hn-quiet/1.2.0/manifest.json",
    source: "https://github.com/flazouh/redesign-marketplace/tree/0123456789abcdef0123456789abcdef01234567/packages/alex/hn-quiet/1.2.0/source",
    before: "https://raw.githubusercontent.com/flazouh/redesign-marketplace/0123456789abcdef0123456789abcdef01234567/packages/alex/hn-quiet/1.2.0/preview-before.webp",
    after: "https://raw.githubusercontent.com/flazouh/redesign-marketplace/0123456789abcdef0123456789abcdef01234567/packages/alex/hn-quiet/1.2.0/preview-after.webp",
    css: "https://raw.githubusercontent.com/flazouh/redesign-marketplace/0123456789abcdef0123456789abcdef01234567/packages/alex/hn-quiet/1.2.0/style.css",
    view: "https://raw.githubusercontent.com/flazouh/redesign-marketplace/0123456789abcdef0123456789abcdef01234567/packages/alex/hn-quiet/1.2.0/view.json"
  }
}

const repository = (overrides: Partial<MarketplaceRepository> = {}) => {
  const queries: unknown[] = []
  const repo: MarketplaceRepository = {
    list: async (query) => {
      queries.push(query)
      return { items: [item], nextCursor: null }
    },
    get: async () => detail,
    recordInstall: async () => true,
    report: async () => "report-1",
    ...overrides
  }
  return { repo, queries }
}

describe("public marketplace API", () => {
  test("lists compatible packages without authentication", async () => {
    const { repo, queries } = repository()
    const response = await marketplaceApi(repo)(
      new Request("https://api.redesign.test/v1/packages?origin=https%3A%2F%2Fnews.ycombinator.com&sort=popular")
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ items: [item], nextCursor: null })
    expect(queries).toEqual([
      {
        origin: "https://news.ycombinator.com",
        query: null,
        sort: "popular",
        cursor: null,
        limit: 24
      }
    ])
  })

  test("gets a package whose slug contains its author namespace", async () => {
    const { repo } = repository({
      get: async (slug) => (slug === "alex/hn-quiet" ? detail : null)
    })
    const response = await marketplaceApi(repo)(new Request("https://api.redesign.test/v1/packages/alex/hn-quiet"))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(detail)
  })

  test("returns a stable not-found response", async () => {
    const { repo } = repository({ get: async () => null })
    const response = await marketplaceApi(repo)(new Request("https://api.redesign.test/v1/packages/alex/missing"))

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: "not_found" })
  })

  test("rejects unsupported sort values and oversized limits", async () => {
    const { repo } = repository()

    const badSort = await marketplaceApi(repo)(new Request("https://api.redesign.test/v1/packages?sort=random"))
    expect(badSort.status).toBe(400)
    expect(await badSort.json()).toEqual({ error: "invalid_sort" })

    const badLimit = await marketplaceApi(repo)(new Request("https://api.redesign.test/v1/packages?limit=500"))
    expect(badLimit.status).toBe(400)
    expect(await badLimit.json()).toEqual({ error: "invalid_limit" })

    const badCursor = await marketplaceApi(repo)(new Request("https://api.redesign.test/v1/packages?cursor=next"))
    expect(badCursor.status).toBe(400)
    expect(await badCursor.json()).toEqual({ error: "invalid_cursor" })
  })

  test("records an anonymous install without requiring a user account", async () => {
    let installed: string | undefined
    const { repo } = repository({
      recordInstall: async (slug) => {
        installed = slug
        return true
      }
    })

    const response = await marketplaceApi(repo)(
      new Request("https://api.redesign.test/v1/packages/alex/hn-quiet/install", { method: "POST" })
    )

    expect(response.status).toBe(204)
    expect(installed).toBe("alex/hn-quiet")
  })

  test("stores reports with a daily IP hash and no raw address", async () => {
    let captured: unknown
    const { repo } = repository({
      report: async (report) => {
        captured = report
        return "report-42"
      }
    })
    const response = await marketplaceApi(repo, {
      reportSalt: "test-salt",
      now: () => new Date("2026-09-08T20:00:00.000Z")
    })(
      new Request("https://api.redesign.test/v1/packages/alex/hn-quiet/reports", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
        body: JSON.stringify({ category: "privacy", detail: "Reads more data than the listing says." })
      })
    )

    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ id: "report-42" })
    expect(captured).toMatchObject({
      slug: "alex/hn-quiet",
      category: "privacy",
      detail: "Reads more data than the listing says."
    })
    expect(JSON.stringify(captured)).not.toContain("203.0.113.9")
  })

  test("allows browser preflight for public POST routes", async () => {
    const { repo } = repository()
    const response = await marketplaceApi(repo)(
      new Request("https://api.redesign.test/v1/packages/alex/hn-quiet/reports", { method: "OPTIONS" })
    )

    expect(response.status).toBe(204)
    expect(response.headers.get("access-control-allow-methods")).toBe("GET, POST, OPTIONS")
    expect(response.headers.get("access-control-allow-headers")).toBe("Content-Type")
  })
})
