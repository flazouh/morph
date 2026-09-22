import type { MarketplaceClient } from "./client"
import type { PackageDetail } from "./api/http"
import type { PackageSource } from "./compiler/source"
import { parseForkDraft, parseForkDraftLibrary } from "./forks/memory"
import type { ForkDraft, ForkParent } from "./forks/model"
import {
  parseInstalledLibrary,
  parseInstalledRelease,
  type InstalledLibrary,
  type InstalledRelease
} from "./installer"
import type { SandboxCapabilities } from "./manifest"
import type { ForkDraftAsk, MarketplaceAsk } from "./messages"
import { isMarketplacePreviewAsk, type MarketplacePreviewAsk } from "./preview"
import { ask } from "../bridge/messaging"

type CatalogPort = Pick<MarketplaceClient, "get" | "recordInstall">
type MarketplaceMessagePort = (ask: MarketplaceAsk | MarketplacePreviewAsk) => Promise<unknown>
type ForkMessagePort = (ask: ForkDraftAsk) => Promise<unknown>

export class MarketplaceCommandFailure extends Error {
  constructor(message: string) {
    super(message)
    this.name = "MarketplaceCommandFailure"
  }
}

export interface ExtensionMarketplace {
  readonly detail: (slug: string) => Promise<PackageDetail>
  readonly list: () => Promise<InstalledLibrary>
  readonly install: (slug: string) => Promise<InstalledRelease>
  readonly update: (slug: string) => Promise<InstalledRelease>
  readonly rollback: (slug: string) => Promise<InstalledRelease>
  readonly remove: (slug: string) => Promise<void>
  readonly preview: (slug: string) => Promise<void>
  readonly stopPreview: () => Promise<void>
}

export interface ExtensionForkDrafts {
  readonly ensure: (parent: ForkParent) => Promise<ForkDraft>
  readonly edit: (
    parent: ForkParent,
    source: PackageSource,
    /** A page package asks for none, so a write to one carries none. */
    capabilities: SandboxCapabilities | undefined
  ) => Promise<ForkDraft>
  readonly rollback: (draftId: string, revisionId: string) => Promise<ForkDraft>
  readonly rename: (draftId: string, name: string) => Promise<ForkDraft>
  readonly discard: (draftId: string) => Promise<void>
  readonly list: () => Promise<ReadonlyArray<ForkDraft>>
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

const invalidResponse = (): MarketplaceCommandFailure =>
  new MarketplaceCommandFailure("The extension returned an invalid marketplace response.")

const response = (value: unknown, expectedType: string): Record<string, unknown> => {
  const answer = record(value)
  if (
    (
      answer?.type === "marketplaceError" ||
      answer?.type === "forkDraftError" ||
      answer?.type === "marketplacePreviewError"
    ) &&
    typeof answer.message === "string"
  ) {
    throw new MarketplaceCommandFailure(answer.message)
  }
  if (answer?.type !== expectedType) throw invalidResponse()
  return answer
}

const forkDraft = (answer: Record<string, unknown>): ForkDraft => {
  const draft = parseForkDraft(answer.draft)
  if (draft === undefined) throw invalidResponse()
  return draft
}

const installedRelease = (answer: Record<string, unknown>): InstalledRelease => {
  const release = parseInstalledRelease(answer.release)
  if (release === undefined) throw invalidResponse()
  return release
}

const installedLibrary = (answer: Record<string, unknown>): InstalledLibrary => {
  const library = parseInstalledLibrary(answer.library)
  if (library === undefined) throw invalidResponse()
  return library
}

export const createExtensionMarketplace = (
  client: CatalogPort,
  send: MarketplaceMessagePort = (message) =>
    isMarketplacePreviewAsk(message) ? ask("marketplacePreview", message) : ask("marketplace", message)
): ExtensionMarketplace => {
  const apply = async (slug: string, countInstall: boolean): Promise<InstalledRelease> => {
    const detail = await client.get(slug)
    const answer = response(await send({ type: "installPackage", detail }), "packageInstalled")
    const release = installedRelease(answer)
    if (countInstall) await client.recordInstall(slug).catch(() => {})
    return release
  }

  return {
    detail: (slug) => client.get(slug),
    list: async () => installedLibrary(response(await send({ type: "listInstalledPackages" }), "installedPackages")),
    install: async (slug) => apply(slug, true),
    update: async (slug) => apply(slug, false),
    rollback: async (slug) =>
      installedRelease(response(await send({ type: "rollbackPackage", slug }), "packageRolledBack")),
    remove: async (slug) => {
      const answer = response(await send({ type: "removePackage", slug }), "packageRemoved")
      if (answer.slug !== slug) throw invalidResponse()
    },
    preview: async (slug) => {
      const detail = await client.get(slug)
      const answer = response(
        await send({ type: "previewMarketplacePackage", detail }),
        "marketplacePackagePreviewed"
      )
      if (answer.slug !== slug) throw invalidResponse()
    },
    stopPreview: async () => {
      response(await send({ type: "stopMarketplacePreview" }), "marketplacePreviewStopped")
    }
  }
}

export const createExtensionForkDrafts = (
  send: ForkMessagePort = (message) => ask("forkDraft", message),
  tabId?: number
): ExtensionForkDrafts => {
  const targetTab = (): number => {
    if (tabId === undefined) throw new MarketplaceCommandFailure("The Morph draft has no page tab.")
    return tabId
  }
  return {
  ensure: async (parent) =>
    forkDraft(response(await send({ type: "ensureForkDraft", parent }), "forkDraft")),
  edit: async (parent, source, capabilities) =>
    forkDraft(
      response(
        await send({
          type: "editForkDraft",
          parent,
          source,
          ...(capabilities === undefined ? {} : { capabilities }),
          tabId: targetTab()
        }),
        "forkDraft"
      )
    ),
  rollback: async (draftId, revisionId) =>
    forkDraft(
      response(
        await send({ type: "rollbackForkDraft", draftId, revisionId, tabId: targetTab() }),
        "forkDraft"
      )
    ),
  rename: async (draftId, name) =>
    forkDraft(
      response(await send({ type: "renameForkDraft", draftId, name }), "forkDraft")
    ),
  discard: async (draftId) => {
    const answer = response(
      await send({ type: "discardForkDraft", draftId, tabId: targetTab() }),
      "forkDraftDiscarded"
    )
    if (answer.draftId !== draftId) throw invalidResponse()
  },
  list: async () => {
    const answer = response(await send({ type: "listForkDrafts" }), "forkDrafts")
    if (!Array.isArray(answer.drafts)) throw invalidResponse()
    const drafts = parseForkDraftLibrary({
      drafts: Object.fromEntries(
        answer.drafts.flatMap((value) => {
          const draft = parseForkDraft(value)
          return draft === undefined ? [] : [[draft.id, draft]]
        })
      )
    })
    if (Object.keys(drafts.drafts).length !== answer.drafts.length) {
      throw invalidResponse()
    }
    return Object.values(drafts.drafts)
  }
  }
}
