import type { PackageSource } from "../compiler/source"
import type { ForkDraftMemory } from "../forks/memory"
import type {
  PageRelease,
  PageReleaseMetadata,
  PublishMetadata,
  PublisherClient,
  PublishPreview,
  PublisherToken,
  ReleaseStatus
} from "./client"

export type PublishRequestMetadata = Omit<PublishMetadata, "before" | "after">
export type PageReleaseRequestMetadata = Omit<PageReleaseMetadata, "before" | "after">

export type PublisherAsk =
  | { readonly type: "publisherSession" }
  | { readonly type: "startPublisherSignIn" }
  | { readonly type: "revokePublisherSession" }
  | {
      readonly type: "publishForkDraft"
      readonly draftId: string
      readonly revisionId: string
      readonly tabId: number
      readonly metadata: PublishRequestMetadata
    }
  | {
      /** A page redesign, as a new root package. The tool sends the source it applied. */
      readonly type: "publishPageRelease"
      readonly tabId: number
      readonly source: PackageSource
      /** The paths the package covers: every page of the site the thread redesigned. */
      readonly paths: ReadonlyArray<string>
      readonly metadata: PageReleaseRequestMetadata
    }
  | { readonly type: "getReleaseStatus"; readonly releaseId: string }

export type PublisherAnswer =
  | { readonly type: "publisherSession"; readonly token: PublisherToken | null }
  | { readonly type: "forkDraftPublished"; readonly release: ReleaseStatus }
  | { readonly type: "pageReleasePublished"; readonly release: ReleaseStatus }
  | { readonly type: "releaseStatus"; readonly release: ReleaseStatus }
  | { readonly type: "publisherSessionRevoked" }
  | { readonly type: "publisherError"; readonly message: string; readonly code?: string }

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const validMetadata = (value: unknown): value is PublishRequestMetadata => {
  const metadata = record(value)
  return (
    typeof metadata?.name === "string" &&
    typeof metadata.slug === "string" &&
    typeof metadata.summary === "string" &&
    typeof metadata.version === "string" &&
    typeof metadata.approvePermissionWidening === "boolean"
  )
}

const validSource = (value: unknown): value is PackageSource => {
  const source = record(value)
  const files = record(source?.files)
  return (
    typeof source?.entry === "string" &&
    typeof source.style === "string" &&
    files !== undefined &&
    Object.values(files).every((content) => typeof content === "string")
  )
}

const validTab = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 0

/** One absolute path per page the package covers, and at least one. */
const validPaths = (value: unknown): value is ReadonlyArray<string> =>
  Array.isArray(value) && value.length > 0 && value.every((path) => typeof path === "string" && path.startsWith("/"))

export const isPublisherAsk = (value: unknown): value is PublisherAsk => {
  const message = record(value)
  if (
    message?.type === "publisherSession" ||
    message?.type === "startPublisherSignIn" ||
    message?.type === "revokePublisherSession"
  ) {
    return true
  }
  if (message?.type === "getReleaseStatus") {
    return typeof message.releaseId === "string"
  }
  if (message?.type === "publishPageRelease") {
    return (
      validTab(message.tabId) &&
      validSource(message.source) &&
      validPaths(message.paths) &&
      validMetadata(message.metadata) &&
      typeof (message.metadata as Record<string, unknown>).license === "string"
    )
  }
  return (
    message?.type === "publishForkDraft" &&
    typeof message.draftId === "string" &&
    typeof message.revisionId === "string" &&
    validTab(message.tabId) &&
    validMetadata(message.metadata)
  )
}

export const publisherHandler =
  (
    publisher: PublisherClient,
    drafts: ForkDraftMemory,
    capture: (
      draftId: string,
      tabId: number
    ) => Promise<{ readonly before: PublishPreview; readonly after: PublishPreview }>,
    /** A page redesign compiled and pictured on its tab, ready for `publishPage`. */
    page: (
      tabId: number,
      source: PackageSource,
      paths: ReadonlyArray<string>
    ) => Promise<{ readonly release: PageRelease; readonly previews: { readonly before: PublishPreview; readonly after: PublishPreview } }>
  ) =>
  async (message: PublisherAsk): Promise<PublisherAnswer> => {
    try {
      switch (message.type) {
        case "publisherSession":
          return { type: "publisherSession", token: (await publisher.token()) ?? null }
        case "startPublisherSignIn":
          return { type: "publisherSession", token: await publisher.signIn() }
        case "revokePublisherSession":
          await publisher.revoke()
          return { type: "publisherSessionRevoked" }
        case "getReleaseStatus":
          return {
            type: "releaseStatus",
            release: await publisher.status(message.releaseId)
          }
        case "publishForkDraft": {
          const draft = (await drafts.read()).drafts[message.draftId]
          if (draft === undefined) throw new Error("the local Morph draft does not exist")
          if (draft.currentRevision !== message.revisionId) {
            throw new Error("the confirmed Morph revision has changed")
          }
          const previews = await capture(draft.id, message.tabId)
          return {
            type: "forkDraftPublished",
            release: await publisher.publish(draft, { ...message.metadata, ...previews })
          }
        }
        case "publishPageRelease": {
          const { release, previews } = await page(message.tabId, message.source, message.paths)
          return {
            type: "pageReleasePublished",
            release: await publisher.publishPage(release, { ...message.metadata, ...previews })
          }
        }
      }
    } catch (error) {
      return {
        type: "publisherError",
        message: error instanceof Error ? error.message : "Morph publishing failed",
        ...(
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          typeof error.code === "string"
            ? { code: error.code }
            : {}
        )
      }
    }
  }
