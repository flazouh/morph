import type { MarketplaceClient } from "./client"
import type { InstalledLibrary } from "./installer"
import type { PackageSummary } from "./api/http"
import { scopeMatches } from "./sandbox/installed"

export interface PackageMatch {
  readonly package: PackageSummary
  readonly reason: string
  readonly installed: boolean
}

export const summaryMatches = (
  item: Pick<PackageSummary, "origin" | "paths">,
  location: Pick<Location, "origin" | "pathname">
): boolean =>
  scopeMatches(item, location)

export const currentPageDiscovery = (
  client: Pick<MarketplaceClient, "list">
): {
  readonly find: (
    location: Pick<Location, "origin" | "pathname">,
    installed: InstalledLibrary
  ) => Promise<ReadonlyArray<PackageMatch>>
} => {
  const origins = new Map<string, Promise<ReadonlyArray<PackageSummary>>>()
  const forOrigin = (origin: string): Promise<ReadonlyArray<PackageSummary>> => {
    const existing = origins.get(origin)
    if (existing !== undefined) return existing
    const loading = client
      .list({ origin, limit: 48 })
      .then((page) => page.items)
      .catch((error) => {
        origins.delete(origin)
        throw error
      })
    origins.set(origin, loading)
    return loading
  }

  return {
    find: async (location, installed) =>
      (await forOrigin(location.origin))
        .filter((item) => summaryMatches(item, location))
        .map((item) => ({
          package: item,
          reason: `Matches ${location.pathname}`,
          installed: installed.active[item.slug]?.version === item.version
        }))
  }
}
