import type {
  PackageDetail,
  PackagePage,
  PackageSummary
} from "./api/http"
import { parseManifest } from "./manifest"

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined

const summary = (value: unknown): PackageSummary | undefined => {
  const item = record(value)
  const paths = item?.paths
  if (
    item === undefined ||
    typeof item.slug !== "string" ||
    typeof item.name !== "string" ||
    typeof item.summary !== "string" ||
    typeof item.origin !== "string" ||
    !Array.isArray(paths) ||
    paths.some((path) => typeof path !== "string") ||
    typeof item.version !== "string" ||
    (
      item.runtime !== "declarative-v1" &&
      item.runtime !== "script-v1" &&
      item.runtime !== "sandbox-v1"
    ) ||
    typeof item.license !== "string" ||
    typeof item.installs !== "number" ||
    typeof item.stars !== "number" ||
    typeof item.updatedAt !== "string"
  ) {
    return undefined
  }
  return {
    slug: item.slug,
    name: item.name,
    summary: item.summary,
    origin: item.origin,
    paths,
    version: item.version,
    runtime: item.runtime,
    license: item.license,
    installs: item.installs,
    stars: item.stars,
    updatedAt: item.updatedAt
  }
}

export const parsePackagePage = (value: unknown): PackagePage | undefined => {
  const result = record(value)
  if (
    result === undefined ||
    !Array.isArray(result.items) ||
    (
      result.nextCursor !== null &&
      typeof result.nextCursor !== "string"
    )
  ) {
    return undefined
  }
  const items: PackageSummary[] = []
  for (const value of result.items) {
    const item = summary(value)
    if (item === undefined) return undefined
    items.push(item)
  }
  return { items, nextCursor: result.nextCursor }
}

const nullableString = (value: unknown): value is string | null =>
  value === null || typeof value === "string"

export const parsePackageDetail = (
  value: unknown
): PackageDetail | undefined => {
  const item = record(value)
  const base = summary(value)
  const author = record(item?.author)
  const source = record(item?.source)
  const files = record(item?.files)
  if (
    item === undefined ||
    base === undefined ||
    author === undefined ||
    typeof author.handle !== "string" ||
    !nullableString(author.displayName) ||
    !nullableString(author.avatarUrl) ||
    source === undefined ||
    typeof source.repository !== "string" ||
    typeof source.commit !== "string" ||
    typeof source.path !== "string" ||
    typeof source.url !== "string" ||
    files === undefined ||
    typeof files.manifest !== "string" ||
    typeof files.source !== "string" ||
    typeof files.before !== "string" ||
    typeof files.after !== "string" ||
    typeof files.css !== "string"
  ) {
    return undefined
  }
  try {
    const manifest = parseManifest(item.manifest)
    let runtimeFile: { readonly view: string } | { readonly script: string }
    if (manifest.runtime === "declarative-v1") {
      if (typeof files.view !== "string") return undefined
      runtimeFile = { view: files.view }
    } else {
      if (typeof files.script !== "string") return undefined
      runtimeFile = { script: files.script }
    }
    return {
      ...base,
      author: {
        handle: author.handle,
        displayName: author.displayName,
        avatarUrl: author.avatarUrl
      },
      manifest,
      source: {
        repository: source.repository,
        commit: source.commit,
        path: source.path,
        url: source.url
      },
      files: {
        manifest: files.manifest,
        source: files.source,
        before: files.before,
        after: files.after,
        css: files.css,
        ...runtimeFile
      }
    }
  } catch {
    return undefined
  }
}
