import type { PackageDetail, PackagePage, PackageQuery, ReportCategory } from "./api/http"
import { parsePackageDetail, parsePackagePage } from "./package-decode"

export const MARKETPLACE_API = "https://api-production-0261.up.railway.app"

export class MarketplaceFailure extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string) {
    super(`Marketplace request failed: ${code} (${status})`)
    this.status = status
    this.code = code
  }
}

export interface MarketplaceClient {
  readonly list: (query?: Partial<PackageQuery>) => Promise<PackagePage>
  readonly get: (slug: string) => Promise<PackageDetail>
  readonly recordInstall: (slug: string) => Promise<void>
  readonly report: (slug: string, category: ReportCategory, detail: string) => Promise<{ readonly id: string }>
}

export type MarketplaceFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

const errorCode = (value: unknown): string => {
  const error = record(value)?.error
  return typeof error === "string" ? error : "request_failed"
}

export const createMarketplaceClient = (baseUrl: string = MARKETPLACE_API, fetcher: MarketplaceFetch = fetch): MarketplaceClient => {
  const base = baseUrl.replace(/\/+$/, "")
  const request = async (path: string, init?: RequestInit): Promise<unknown> => {
    const response = await fetcher(`${base}${path}`, init)
    const value = response.status === 204 ? null : ((await response.json().catch(() => null)) as unknown)
    if (!response.ok) throw new MarketplaceFailure(response.status, errorCode(value))
    return value
  }
  const packagePath = (slug: string): string => {
    const parts = slug.split("/")
    if (parts.length !== 2 || parts.some((part) => part === "")) throw new MarketplaceFailure(400, "invalid_slug")
    return `/v1/packages/${parts.map(encodeURIComponent).join("/")}`
  }

  return {
    list: async (query = {}) => {
      const parameters = new URLSearchParams()
      if (query.origin !== undefined && query.origin !== null) parameters.set("origin", query.origin)
      if (query.query !== undefined && query.query !== null) parameters.set("q", query.query)
      if (query.sort !== undefined) parameters.set("sort", query.sort)
      if (query.cursor !== undefined && query.cursor !== null) parameters.set("cursor", query.cursor)
      if (query.limit !== undefined) parameters.set("limit", String(query.limit))
      const result = parsePackagePage(await request(`/v1/packages${parameters.size === 0 ? "" : `?${parameters}`}`))
      if (result === undefined) throw new MarketplaceFailure(502, "invalid_response")
      return result
    },
    get: async (slug) => {
      const result = parsePackageDetail(await request(packagePath(slug)))
      if (result === undefined) throw new MarketplaceFailure(502, "invalid_response")
      return result
    },
    recordInstall: async (slug) => {
      await request(`${packagePath(slug)}/install`, { method: "POST" })
    },
    report: async (slug, category, reportDetail) => {
      const result = record(
        await request(`${packagePath(slug)}/reports`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ category, detail: reportDetail })
        })
      )
      if (result === undefined || typeof result.id !== "string") throw new MarketplaceFailure(502, "invalid_response")
      return { id: result.id }
    }
  }
}
