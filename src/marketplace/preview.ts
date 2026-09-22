import type { PackageDetail } from "./api/http"
import { preparePackageRecords } from "./installer"
import type { SandboxCapabilities } from "./manifest"

export type MarketplacePreviewAsk =
  | { readonly type: "previewMarketplacePackage"; readonly detail: PackageDetail }
  | { readonly type: "stopMarketplacePreview" }

export type MarketplacePreviewAnswer =
  | { readonly type: "marketplacePackagePreviewed"; readonly slug: string }
  | { readonly type: "marketplacePreviewStopped" }
  | { readonly type: "marketplacePreviewError"; readonly message: string }

export interface PagePackagePreview {
  readonly id: string
  readonly slug: string
  readonly scope: PackageDetail["manifest"]["scope"]
  readonly js: string
  readonly css: string
  readonly capabilities: SandboxCapabilities
}

export type PagePreviewAsk =
  | { readonly type: "showMarketplacePreview"; readonly preview: PagePackagePreview }
  | { readonly type: "clearMarketplacePreview" }

/** The page's answer to a preview ask; the worker adds the slug before it answers the card. */
export type PagePreviewAnswer =
  | { readonly type: "marketplacePackagePreviewed" }
  | { readonly type: "marketplacePreviewStopped" }
  | { readonly type: "marketplacePreviewError"; readonly message: string }

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

export const isMarketplacePreviewAsk = (
  value: unknown
): value is MarketplacePreviewAsk => {
  const message = record(value)
  if (message?.type === "stopMarketplacePreview") return true
  return message?.type === "previewMarketplacePackage" && record(message.detail) !== undefined
}

export const isPagePreviewAsk = (value: unknown): value is PagePreviewAsk => {
  const message = record(value)
  if (message?.type === "clearMarketplacePreview") return true
  const preview = record(message?.preview)
  const scope = record(preview?.scope)
  return (
    message?.type === "showMarketplacePreview" &&
    typeof preview?.id === "string" &&
    typeof preview.slug === "string" &&
    typeof preview.js === "string" &&
    typeof preview.css === "string" &&
    record(preview.capabilities) !== undefined &&
    typeof scope?.origin === "string" &&
    Array.isArray(scope.paths) &&
    scope.paths.every((path) => typeof path === "string")
  )
}

export const prepareMarketplacePreview = async (
  detail: PackageDetail,
  fetcher: typeof fetch
): Promise<PagePackagePreview> => {
  if (detail.manifest.runtime !== "sandbox-v1") {
    throw new Error("this Morph runtime cannot be previewed without installation")
  }
  const records = await preparePackageRecords(detail, fetcher)
  const sandbox = records
    .map((item) => item.payload)
    .find(
      (
        payload
      ): payload is Extract<(typeof records)[number]["payload"], { kind: "sandbox" }> =>
        payload.kind === "sandbox"
    )
  if (sandbox === undefined) throw new Error("the Morph has no sandbox preview")
  return {
    id: crypto.randomUUID(),
    slug: detail.slug,
    scope: detail.manifest.scope,
    js: sandbox.js,
    css: sandbox.css,
    capabilities: sandbox.capabilities
  }
}
