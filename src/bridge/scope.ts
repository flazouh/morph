import type { Kind } from "./persisted"

/** A page identity uses its origin and path. It never uses its query or hash. */
export const pageKey = (url: string): string => {
  const parsed = new URL(url)
  return `${parsed.origin}${parsed.pathname}`
}

/** A site identity is its origin. */
export const siteKey = (url: string): string => new URL(url).origin

/** The path a page is at, as a release names it: no origin, no query, no hash. */
export const pathOf = (url: string): string => new URL(url).pathname

/** A root script uses a host-wide match and an exact in-script path guard. */
export const patternOf = (url: string, kind: Kind = "script"): string => {
  const { origin, pathname } = new URL(url)
  if ((kind === "script" || kind === "skin" || kind === "declarative") && (pathname === "/" || pathname === "")) return `${origin}/*`
  if (pathname === "/" || pathname === "") return `${origin}/`
  return `${pageKey(url)}*`
}

/** Design records cover a site. All other records cover one page path. */
export const scopeOf = (url: string, kind: Kind): { readonly id: string; readonly matches: string } =>
  kind === "design"
    ? { id: `redesign:design:${siteKey(url)}`, matches: `${siteKey(url)}/*` }
    : { id: `redesign:${kind}:${pageKey(url)}`, matches: patternOf(url, kind) }
