import type { PackageRuntime, RedesignManifest } from "../manifest"

export type PackageSort = "popular" | "recent" | "stars"

export interface PackageSummary {
  readonly slug: string
  readonly name: string
  readonly summary: string
  readonly origin: string
  readonly paths: ReadonlyArray<string>
  readonly version: string
  readonly runtime: PackageRuntime
  readonly license: string
  readonly installs: number
  readonly stars: number
  readonly updatedAt: string
}

export interface PackageDetail extends PackageSummary {
  readonly author: {
    readonly handle: string
    readonly displayName: string | null
    readonly avatarUrl: string | null
  }
  readonly manifest: RedesignManifest
  readonly source: {
    readonly repository: string
    readonly commit: string
    readonly path: string
    readonly url: string
  }
  readonly files: {
    readonly manifest: string
    readonly source: string
    readonly before: string
    readonly after: string
    readonly css: string
    readonly view?: string
    readonly script?: string
  }
}

export interface PackageQuery {
  readonly origin: string | null
  readonly query: string | null
  readonly sort: PackageSort
  readonly cursor: string | null
  readonly limit: number
}

export interface PackagePage {
  readonly items: ReadonlyArray<PackageSummary>
  readonly nextCursor: string | null
}

export type ReportCategory = "malware" | "privacy" | "license" | "spam" | "broken"

export interface PackageReport {
  readonly slug: string
  readonly category: ReportCategory
  readonly detail: string
  readonly reporterHash: string
}

export interface MarketplaceRepository {
  readonly list: (query: PackageQuery) => Promise<PackagePage>
  readonly get: (slug: string) => Promise<PackageDetail | null>
  readonly recordInstall: (slug: string) => Promise<boolean>
  readonly report: (report: PackageReport) => Promise<string | null>
}

export interface MarketplaceApiOptions {
  readonly reportSalt?: string
  readonly now?: () => Date
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
} as const

const headers = {
  ...corsHeaders,
  "Content-Type": "application/json; charset=utf-8"
} as const

const json = (value: unknown, status = 200): Response => Response.json(value, { status, headers })

const origin = (value: string | null): string | null | undefined => {
  if (value === null) return null
  try {
    const url = new URL(value)
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value ? value : undefined
  } catch {
    return undefined
  }
}

const limit = (value: string | null): number | undefined => {
  if (value === null) return 24
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 48 ? parsed : undefined
}

const sort = (value: string | null): PackageSort | undefined => {
  if (value === null || value === "popular") return "popular"
  if (value === "recent" || value === "stars") return value
  return undefined
}

const cursor = (value: string | null): string | null | undefined => {
  if (value === null) return null
  return /^(0|[1-9]\d*)$/.test(value) && Number(value) <= 10_000 ? value : undefined
}

const packageSlug = (pathname: string): string | null => {
  const match = /^\/v1\/packages\/([^/]+)\/([^/]+)$/.exec(pathname)
  if (match === null) return null
  try {
    return `${decodeURIComponent(match[1] ?? "")}/${decodeURIComponent(match[2] ?? "")}`
  } catch {
    return null
  }
}

const packageAction = (pathname: string): { readonly slug: string; readonly action: "install" | "reports" } | null => {
  const match = /^\/v1\/packages\/([^/]+)\/([^/]+)\/(install|reports)$/.exec(pathname)
  if (match === null) return null
  try {
    return {
      slug: `${decodeURIComponent(match[1] ?? "")}/${decodeURIComponent(match[2] ?? "")}`,
      action: match[3] as "install" | "reports"
    }
  } catch {
    return null
  }
}

const reportCategory = (value: unknown): value is ReportCategory =>
  value === "malware" || value === "privacy" || value === "license" || value === "spam" || value === "broken"

const reporterHash = async (request: Request, salt: string, now: Date): Promise<string> => {
  const address = (request.headers.get("x-forwarded-for") ?? "unknown").split(",")[0]?.trim() || "unknown"
  const day = now.toISOString().slice(0, 10)
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}:${day}:${address}`))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

export const marketplaceApi =
  (repository: MarketplaceRepository, options: MarketplaceApiOptions = {}) =>
  async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders })

    if (request.method === "GET" && url.pathname === "/health") return json({ ok: true })

    if (request.method === "GET" && url.pathname === "/v1/packages") {
      const packageOrigin = origin(url.searchParams.get("origin"))
      if (packageOrigin === undefined) return json({ error: "invalid_origin" }, 400)
      const packageSort = sort(url.searchParams.get("sort"))
      if (packageSort === undefined) return json({ error: "invalid_sort" }, 400)
      const pageLimit = limit(url.searchParams.get("limit"))
      if (pageLimit === undefined) return json({ error: "invalid_limit" }, 400)
      const pageCursor = cursor(url.searchParams.get("cursor"))
      if (pageCursor === undefined) return json({ error: "invalid_cursor" }, 400)
      const query = url.searchParams.get("q")
      if (query !== null && query.length > 100) return json({ error: "invalid_query" }, 400)

      return json(
        await repository.list({
          origin: packageOrigin,
          query,
          sort: packageSort,
          cursor: pageCursor,
          limit: pageLimit
        })
      )
    }

    const slug = request.method === "GET" ? packageSlug(url.pathname) : null
    if (slug !== null) {
      const item = await repository.get(slug)
      return item === null ? json({ error: "not_found" }, 404) : json(item)
    }

    const action = request.method === "POST" ? packageAction(url.pathname) : null
    if (action?.action === "install") {
      return (await repository.recordInstall(action.slug))
        ? new Response(null, { status: 204, headers: corsHeaders })
        : json({ error: "not_found" }, 404)
    }
    if (action?.action === "reports") {
      if (options.reportSalt === undefined) return json({ error: "reports_unavailable" }, 503)
      const body = await request.json().catch(() => null)
      if (typeof body !== "object" || body === null || !("category" in body) || !("detail" in body)) return json({ error: "invalid_report" }, 400)
      if (!reportCategory(body.category) || typeof body.detail !== "string" || body.detail.trim().length < 10 || body.detail.length > 2_000) {
        return json({ error: "invalid_report" }, 400)
      }
      const id = await repository.report({
        slug: action.slug,
        category: body.category,
        detail: body.detail.trim(),
        reporterHash: await reporterHash(request, options.reportSalt, (options.now ?? (() => new Date()))())
      })
      return id === null ? json({ error: "not_found" }, 404) : json({ id }, 201)
    }

    if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405)
    return json({ error: "not_found" }, 404)
  }
