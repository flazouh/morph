import { makeAsyncCache } from "./async-cache"
import type { SourceLocation } from "./model"
import { parseSourceMapReference, resolveSourceMap } from "./source-map"
import type { GeneratedSource } from "./source"

interface SourceResponse {
  readonly ok: boolean
  text(): Promise<string>
}

export type SourceFetch = (url: string) => Promise<SourceResponse>

export type ResolveSource = (
  generated: GeneratedSource,
  page: string
) => Promise<SourceLocation>

export interface SourceResolverOptions {
  readonly now?: () => number
  readonly ttlMs?: number
  readonly maxEntries?: number
}

const dataText = (url: string): string => {
  const comma = url.indexOf(",")
  if (!url.startsWith("data:") || comma < 0) {
    throw new Error("invalid inline source map")
  }
  const metadata = url.slice(5, comma)
  const body = url.slice(comma + 1)
  if (!metadata.split(";").includes("base64")) return decodeURIComponent(body)
  const binary = atob(body)
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

const transformed = (source: GeneratedSource): SourceLocation => ({
  file: source.url,
  line: source.line,
  column: source.column,
  component: source.component,
  precision: "transformed"
})

export const createSourceResolver = (
  fetch: SourceFetch,
  {
    now = Date.now,
    ttlMs = 2_000,
    maxEntries = 64
  }: SourceResolverOptions = {}
): ResolveSource => {
  const scripts = makeAsyncCache<string>({ now, ttlMs, maxEntries })
  const maps = makeAsyncCache<unknown>({ now, ttlMs, maxEntries })

  const fetchText = async (url: string): Promise<string> => {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`request failed for ${url}`)
    return response.text()
  }

  const scriptAt = (url: string): Promise<string> =>
    scripts.get(url, () => fetchText(url))

  const mapAt = (url: string): Promise<unknown> => {
    if (url.startsWith("data:")) {
      return Promise.resolve().then(() => JSON.parse(dataText(url)) as unknown)
    }
    return maps.get(
      url,
      () => fetchText(url).then((text) => JSON.parse(text) as unknown)
    )
  }

  return async (source, page) => {
    let generated = source
    try {
      generated = { ...source, url: new URL(source.url, page).href }
    } catch {
      // Keep the page's value. The fetch will fail safely and return it as transformed.
    }
    const fallback = transformed(generated)
    try {
      const script = await scriptAt(generated.url)
      const mapUrl = parseSourceMapReference(script, generated.url)
      if (mapUrl === null) return fallback
      const map = await mapAt(mapUrl)
      return resolveSourceMap(map, generated, mapUrl) ?? fallback
    } catch {
      return fallback
    }
  }
}
