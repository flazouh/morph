import { useEffect, useState } from "react"
import type { MarketplaceClient } from "../client"
import type { PackageQuery, PackageSummary } from "../api/http"

export type CatalogState =
  | { readonly status: "loading"; readonly items: ReadonlyArray<PackageSummary> }
  | { readonly status: "ready"; readonly items: ReadonlyArray<PackageSummary> }
  | { readonly status: "error"; readonly items: ReadonlyArray<PackageSummary> }

export function useCatalog(
  client: Pick<MarketplaceClient, "list">,
  query: Partial<PackageQuery>
): { readonly state: CatalogState; readonly retry: () => void } {
  const [state, setState] = useState<CatalogState>({ status: "loading", items: [] })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let current = true
    setState((value) => ({ status: "loading", items: value.items }))
    void client.list(query).then(
      (page) => {
        if (current) setState({ status: "ready", items: page.items })
      },
      () => {
        if (current) setState((value) => ({ status: "error", items: value.items }))
      }
    )
    return () => {
      current = false
    }
  }, [attempt, client, query])

  return { state, retry: () => setAttempt((value) => value + 1) }
}
