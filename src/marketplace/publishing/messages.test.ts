import { expect, test } from "bun:test"
import type { ForkDraftMemory } from "../forks/memory"
import type { PublisherClient, ReleaseStatus } from "./client"
import { createExtensionPublisher } from "./extension"
import { isPublisherAsk, publisherHandler, type PublisherAsk } from "./messages"

const metadata = {
  name: "Quiet",
  slug: "alex/quiet",
  summary: "A quiet inbox",
  version: "1.0.0",
  approvePermissionWidening: false
}

test("the extension publisher sends the approved revision ID", async () => {
  let sent: PublisherAsk | undefined
  const publisher = createExtensionPublisher(
    async (ask) => {
      sent = ask
      return { type: "publisherError", message: "stop after capture" }
    },
    12
  )

  await expect(
    publisher.publish("draft-1", "revision-7", metadata)
  ).rejects.toThrow("stop after capture")
  expect(sent).toMatchObject({
    type: "publishForkDraft",
    draftId: "draft-1",
    revisionId: "revision-7",
    tabId: 12
  })
})

test("the publisher message boundary requires a revision ID", () => {
  const message = {
    type: "publishForkDraft",
    draftId: "draft-1",
    revisionId: "revision-7",
    tabId: 12,
    metadata
  }
  expect(isPublisherAsk(message)).toBe(true)
  expect(isPublisherAsk({ ...message, revisionId: undefined })).toBe(false)
})

test("the publisher handler rejects a draft that changed after approval", async () => {
  let captures = 0
  let publishes = 0
  const handler = publisherHandler(
    {
      publish: async () => {
        publishes += 1
        throw new Error("publisher must not run")
      }
    } as unknown as PublisherClient,
    {
      read: async () => ({
        drafts: {
          "draft-1": {
            id: "draft-1",
            currentRevision: "revision-8"
          }
        }
      })
    } as unknown as ForkDraftMemory,
    async () => {
      captures += 1
      throw new Error("capture must not run")
    },
    async () => {
      throw new Error("page release must not run")
    }
  )

  const result = await handler({
    type: "publishForkDraft",
    draftId: "draft-1",
    revisionId: "revision-7",
    tabId: 12,
    metadata
  })

  expect(result).toEqual({
    type: "publisherError",
    message: "the confirmed Morph revision has changed"
  })
  expect(captures).toBe(0)
  expect(publishes).toBe(0)
})

const pageSource = { entry: "page.js", style: "style.css", files: { "page.js": "1", "style.css": "" } }

test("the publisher message boundary takes a page release with its source, tab, paths and license", () => {
  const message = { type: "publishPageRelease", tabId: 12, source: pageSource, paths: ["/"], metadata: { ...metadata, license: "MIT" } }
  expect(isPublisherAsk(message)).toBe(true)
  expect(isPublisherAsk({ ...message, paths: ["/", "/login"] })).toBe(true)
  expect(isPublisherAsk({ ...message, paths: [] })).toBe(false)
  expect(isPublisherAsk({ ...message, paths: ["login"] })).toBe(false)
  expect(isPublisherAsk({ ...message, paths: "/" })).toBe(false)
  expect(isPublisherAsk({ ...message, metadata })).toBe(false)
  expect(isPublisherAsk({ ...message, tabId: 0 })).toBe(false)
  expect(isPublisherAsk({ ...message, source: { ...pageSource, files: { "page.js": 1 } } })).toBe(false)
  expect(isPublisherAsk({ ...message, source: { files: pageSource.files } })).toBe(false)
})

test("the extension publisher sends a page release to the worker and reads the release back", async () => {
  let sent: PublisherAsk | undefined
  const release: ReleaseStatus = { id: "sha256:" + "a".repeat(64), state: "completed", slug: "alex/quiet", version: "1.0.0", commit: "1".repeat(40), receipt: "r", retryable: false, error: null }
  const publisher = createExtensionPublisher(async (ask) => {
    sent = ask
    return { type: "pageReleasePublished", release }
  }, 12)
  expect(await publisher.publishPage(pageSource, ["/", "/login"], { ...metadata, license: "MIT" })).toEqual(release)
  expect(sent).toEqual({
    type: "publishPageRelease",
    tabId: 12,
    source: pageSource,
    paths: ["/", "/login"],
    metadata: { ...metadata, license: "MIT" }
  })
})

test("the publisher handler prepares the page on its tab, then publishes it with the pictures", async () => {
  const calls: string[] = []
  const release: ReleaseStatus = { id: "x", state: "completed", slug: "alex/quiet", version: "1.0.0", commit: null, receipt: null, retryable: false, error: null }
  const previews = {
    before: { data: "before", digest: "sha256:" + "a".repeat(64) },
    after: { data: "after", digest: "sha256:" + "b".repeat(64) }
  }
  const prepared = {
    release: { scope: { kind: "page" as const, origin: "https://example.com", paths: ["/"] }, source: pageSource, compiled: { sources: {}, artifacts: { script: "s", css: "c" } } },
    previews
  }
  const handler = publisherHandler(
    {
      publishPage: async (given: unknown, sent: unknown) => {
        calls.push("publish")
        expect(given).toEqual(prepared.release)
        expect(sent).toEqual({ ...metadata, license: "MIT", ...previews })
        return release
      }
    } as unknown as PublisherClient,
    { read: async () => ({ drafts: {} }) } as unknown as ForkDraftMemory,
    async () => {
      throw new Error("fork capture must not run")
    },
    async (tabId, source, paths) => {
      calls.push(`page:${tabId}`)
      expect(source).toEqual(pageSource)
      expect(paths).toEqual(["/", "/login"])
      return prepared
    }
  )
  const result = await handler({
    type: "publishPageRelease",
    tabId: 12,
    source: pageSource,
    paths: ["/", "/login"],
    metadata: { ...metadata, license: "MIT" }
  })
  expect(result).toEqual({ type: "pageReleasePublished", release })
  expect(calls).toEqual(["page:12", "publish"])
})
