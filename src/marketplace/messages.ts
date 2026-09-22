import type { PackageDetail } from "./api/http"
import { checkPageSource } from "./compiler/page"
import { checkSource, type PackageSource } from "./compiler/source"
import type { ForkEditor } from "./forks/editor"
import type { ForkDraft, ForkParent } from "./forks/model"
import { parseSandboxCapabilities, type SandboxCapabilities } from "./manifest"
import type { InstalledLibrary, InstalledRelease, MarketplaceInstaller } from "./installer"

export type MarketplaceAsk =
  | { readonly type: "installPackage"; readonly detail: PackageDetail }
  | { readonly type: "rollbackPackage"; readonly slug: string }
  | { readonly type: "removePackage"; readonly slug: string }
  | { readonly type: "listInstalledPackages" }

export type MarketplaceAnswer =
  | { readonly type: "packageInstalled"; readonly release: InstalledRelease }
  | { readonly type: "packageRolledBack"; readonly release: InstalledRelease }
  | { readonly type: "packageRemoved"; readonly slug: string }
  | { readonly type: "installedPackages"; readonly library: InstalledLibrary }
  | { readonly type: "marketplaceError"; readonly message: string }

export type ForkDraftAsk =
  | { readonly type: "ensureForkDraft"; readonly parent: ForkParent }
  | {
      readonly type: "editForkDraft"
      readonly parent: ForkParent
      readonly source: PackageSource
      /** A sandbox fork names what it may do; a page fork names nothing. */
      readonly capabilities?: SandboxCapabilities
      readonly tabId: number
    }
  | { readonly type: "rollbackForkDraft"; readonly draftId: string; readonly revisionId: string; readonly tabId: number }
  | { readonly type: "renameForkDraft"; readonly draftId: string; readonly name: string }
  | { readonly type: "discardForkDraft"; readonly draftId: string; readonly tabId: number }
  | { readonly type: "listForkDrafts" }

export type ForkDraftAnswer =
  | { readonly type: "forkDraft"; readonly draft: ForkDraft }
  | { readonly type: "forkDrafts"; readonly drafts: ReadonlyArray<ForkDraft> }
  | { readonly type: "forkDraftDiscarded"; readonly draftId: string }
  | { readonly type: "forkDraftError"; readonly message: string }

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

/** The source and capability contract of one runtime: a sandbox program, or a page's own code. */
const validSourceFor = (runtime: unknown, source: unknown, capabilities: unknown): boolean => {
  try {
    if (runtime === "script-v1") {
      if (capabilities !== undefined) return false
      checkPageSource(source as PackageSource)
      return true
    }
    checkSource(source as PackageSource)
    parseSandboxCapabilities(capabilities)
    return true
  } catch {
    return false
  }
}

const validParent = (value: unknown): value is ForkParent => {
  const parent = record(value)
  const compiled = record(parent?.compiled)
  const artifacts = record(compiled?.artifacts)
  const sources = record(compiled?.sources)
  const scope = record(parent?.scope)
  if (parent?.runtime !== "sandbox-v1" && parent?.runtime !== "script-v1") return false
  if (!validSourceFor(parent.runtime, parent.source, parent.capabilities)) return false
  return (
    typeof parent?.slug === "string" &&
    typeof parent.version === "string" &&
    typeof parent.commit === "string" &&
    (scope?.kind === "page" || scope?.kind === "site") &&
    typeof scope.origin === "string" &&
    Array.isArray(scope.paths) &&
    scope.paths.every((path) => typeof path === "string") &&
    typeof compiled?.compiler === "string" &&
    typeof compiled.script === "string" &&
    typeof compiled.style === "string" &&
    sources !== undefined &&
    Object.values(sources).every((digest) => typeof digest === "string") &&
    typeof artifacts?.script === "string" &&
    typeof artifacts.css === "string"
  )
}



export const isMarketplaceAsk = (value: unknown): value is MarketplaceAsk => {
  const message = record(value)
  if (message === undefined || typeof message.type !== "string") return false
  if (message.type === "listInstalledPackages") return true
  if (message.type === "installPackage") return record(message.detail) !== undefined
  return (message.type === "rollbackPackage" || message.type === "removePackage") && typeof message.slug === "string"
}

export const isForkDraftAsk = (value: unknown): value is ForkDraftAsk => {
  const message = record(value)
  if (message === undefined || typeof message.type !== "string") return false
  if (message.type === "listForkDrafts") return true
  if (message.type === "ensureForkDraft") return validParent(message.parent)
  if (message.type === "editForkDraft") {
    return (
      validParent(message.parent) &&
      validSourceFor(record(message.parent)?.runtime, message.source, message.capabilities) &&
      Number.isInteger(message.tabId) &&
      (message.tabId as number) > 0
    )
  }
  if (message.type === "rollbackForkDraft") {
    return (
      typeof message.draftId === "string" &&
      typeof message.revisionId === "string" &&
      Number.isInteger(message.tabId) &&
      (message.tabId as number) > 0
    )
  }
  if (message.type === "renameForkDraft") {
    return typeof message.draftId === "string" && typeof message.name === "string"
  }
  return (
    message.type === "discardForkDraft" &&
    typeof message.draftId === "string" &&
    Number.isInteger(message.tabId) &&
    (message.tabId as number) > 0
  )
}

export const changesInstalledPage = (answer: MarketplaceAnswer): boolean =>
  answer.type === "packageInstalled" || answer.type === "packageRolledBack" || answer.type === "packageRemoved"

export const marketplaceHandler =
  (installer: MarketplaceInstaller) =>
  async (message: MarketplaceAsk): Promise<MarketplaceAnswer> => {
    try {
      switch (message.type) {
        case "installPackage":
          return { type: "packageInstalled", release: await installer.install(message.detail) }
        case "rollbackPackage":
          return { type: "packageRolledBack", release: await installer.rollback(message.slug) }
        case "removePackage":
          await installer.remove(message.slug)
          return { type: "packageRemoved", slug: message.slug }
        case "listInstalledPackages":
          return { type: "installedPackages", library: await installer.list() }
      }
    } catch (error) {
      return { type: "marketplaceError", message: error instanceof Error ? error.message : "Marketplace operation failed" }
    }
  }

export const forkDraftHandler =
  (editor: ForkEditor) =>
  async (message: ForkDraftAsk): Promise<ForkDraftAnswer> => {
    try {
      switch (message.type) {
        case "ensureForkDraft":
          return { type: "forkDraft", draft: await editor.ensure(message.parent) }
        case "editForkDraft":
          return {
            type: "forkDraft",
            draft: await editor.edit(message.parent, message.source, message.capabilities, message.tabId)
          }
        case "rollbackForkDraft":
          return {
            type: "forkDraft",
            draft: await editor.rollback(message.draftId, message.revisionId, message.tabId)
          }
        case "renameForkDraft":
          return {
            type: "forkDraft",
            draft: await editor.rename(message.draftId, message.name)
          }
        case "discardForkDraft":
          await editor.discard(message.draftId, message.tabId)
          return { type: "forkDraftDiscarded", draftId: message.draftId }
        case "listForkDrafts":
          return { type: "forkDrafts", drafts: await editor.list() }
      }
    } catch (error) {
      return {
        type: "forkDraftError",
        message: error instanceof Error ? error.message : "Local Morph draft operation failed"
      }
    }
  }
