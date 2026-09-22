export interface MarketplaceAppRoutes {
  readonly auth: (request: Request) => Promise<Response | null>
  readonly releases: (request: Request) => Promise<Response | null>
  readonly catalog: (request: Request) => Promise<Response>
  readonly web: (request: Request) => Promise<Response>
}

export const marketplaceApp =
  (routes: MarketplaceAppRoutes) =>
  async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const handled =
      await routes.auth(request) ??
      await routes.releases(request)
    if (handled !== null) return handled
    if (url.pathname === "/health" || url.pathname.startsWith("/v1/")) {
      return routes.catalog(request)
    }
    return routes.web(request)
  }
