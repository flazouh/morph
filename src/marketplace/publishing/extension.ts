import type {
  PublisherToken,
  ReleaseStatus
} from "./client"
import { parsePublisherToken, parseReleaseStatus } from "./decode"
import { ask } from "../../bridge/messaging"
import type { PackageSource } from "../compiler/source"
import type {
  PageReleaseRequestMetadata,
  PublishRequestMetadata,
  PublisherAnswer,
  PublisherAsk
} from "./messages"

export interface ExtensionPublisher {
  readonly session: () => Promise<PublisherToken | undefined>
  readonly signIn: () => Promise<PublisherToken>
  readonly publish: (
    draftId: string,
    revisionId: string,
    metadata: PublishRequestMetadata
  ) => Promise<ReleaseStatus>
  /** A page redesign, from the source the thread applied, as a new root package. */
  readonly publishPage: (
    source: PackageSource,
    paths: ReadonlyArray<string>,
    metadata: PageReleaseRequestMetadata
  ) => Promise<ReleaseStatus>
  readonly status: (releaseId: string) => Promise<ReleaseStatus>
  readonly revoke: () => Promise<void>
}

type PublisherMessagePort = (ask: PublisherAsk) => Promise<unknown>

export class ExtensionPublisherFailure extends Error {
  constructor(
    message: string,
    readonly code?: string
  ) {
    super(message)
  }
}

const sendDefault: PublisherMessagePort = (message) => ask("publisher", message)

const answer = (
  value: unknown,
  expected: PublisherAnswer["type"]
): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ExtensionPublisherFailure(
      "The extension returned an invalid publisher response."
    )
  }
  const result = value as Record<string, unknown>
  if (result.type === "publisherError" && typeof result.message === "string") {
    throw new ExtensionPublisherFailure(
      result.message,
      typeof result.code === "string" ? result.code : undefined
    )
  }
  if (result.type !== expected) {
    throw new ExtensionPublisherFailure(
      "The extension returned an invalid publisher response."
    )
  }
  return result
}

export const createExtensionPublisher = (
  send: PublisherMessagePort = sendDefault,
  tabId?: number
): ExtensionPublisher => {
  const targetTab = (): number => {
    if (tabId === undefined) {
      throw new ExtensionPublisherFailure("The Morph release has no page tab.")
    }
    return tabId
  }
  return {
    session: async () => {
      const result = answer(await send({ type: "publisherSession" }), "publisherSession")
      if (result.token === null) return undefined
      const token = parsePublisherToken(result.token)
      if (token === undefined) {
        throw new ExtensionPublisherFailure(
          "The extension returned an invalid publisher response."
        )
      }
      return token
    },
    signIn: async () => {
      const token = parsePublisherToken(answer(
        await send({ type: "startPublisherSignIn" }),
        "publisherSession"
      ).token)
      if (token === undefined) {
        throw new ExtensionPublisherFailure(
          "The extension returned an invalid publisher response."
        )
      }
      return token
    },
    publish: async (draftId, revisionId, metadata) => {
      const release = parseReleaseStatus(answer(
        await send({
          type: "publishForkDraft",
          draftId,
          revisionId,
          metadata,
          tabId: targetTab()
        }),
        "forkDraftPublished"
      ).release)
      if (release === undefined) {
        throw new ExtensionPublisherFailure(
          "The extension returned an invalid publisher response."
        )
      }
      return release
    },
    publishPage: async (source, paths, metadata) => {
      const release = parseReleaseStatus(answer(
        await send({ type: "publishPageRelease", tabId: targetTab(), source, paths, metadata }),
        "pageReleasePublished"
      ).release)
      if (release === undefined) {
        throw new ExtensionPublisherFailure(
          "The extension returned an invalid publisher response."
        )
      }
      return release
    },
    status: async (releaseId) => {
      const release = parseReleaseStatus(answer(
        await send({ type: "getReleaseStatus", releaseId }),
        "releaseStatus"
      ).release)
      if (release === undefined) {
        throw new ExtensionPublisherFailure(
          "The extension returned an invalid publisher response."
        )
      }
      return release
    },
    revoke: async () => {
      answer(
        await send({ type: "revokePublisherSession" }),
        "publisherSessionRevoked"
      )
    }
  }
}
