import { describe, expect, test } from "bun:test"
import { createExtensionForkDrafts, MarketplaceCommandFailure } from "../extension"
import {
  forkDraftHandler,
  isForkDraftAsk,
  type ForkDraftAsk
} from "../messages"
import type { ForkEditor } from "./editor"
import type { ForkDraft, ForkParent } from "./model"

const parent = {
  runtime: "sandbox-v1",
  slug: "alex/quiet",
  version: "1.0.0",
  commit: "abc",
  license: "MIT",
  compatibility: { kit: "^1.0.0", chrome: ">=120" },
  scope: { kind: "page", origin: "https://example.com", paths: ["/"] },
  source: {
    entry: "entry.ts",
    style: "style.css",
    files: { "entry.ts": "export const start = () => 1", "style.css": "" }
  },
  compiled: {
    compiler: "test",
    script: "script",
    style: "",
    sources: {},
    artifacts: { script: "sha256:script", css: "sha256:css" }
  },
  capabilities: {
    page: { read: [], navigate: [], traverse: false },
    network: [],
    storage: false,
    context: { viewer: false, theme: false, route: false },
    assets: [],
    secureForms: []
  }
} as const satisfies ForkParent

const draft = {
  id: "local-1",
  runtime: "sandbox-v1" as const,
  parent: {
    slug: parent.slug,
    version: parent.version,
    commit: parent.commit,
    license: parent.license,
    compatibility: parent.compatibility
  },
  parentCapabilities: parent.capabilities,
  scope: parent.scope,
  revisions: [
    {
      id: "revision-1",
      createdAt: "2026-09-09T20:00:00.000Z",
      source: parent.source,
      compiled: parent.compiled,
      capabilities: parent.capabilities,
      permissions: { added: [], removed: [] }
    }
  ],
  currentRevision: "revision-1",
  createdAt: "2026-09-09T20:00:00.000Z",
  updatedAt: "2026-09-09T20:00:00.000Z"
} satisfies ForkDraft

describe("local fork extension messages", () => {
  test("the extension client sends every draft operation through the service worker", async () => {
    const asks: ForkDraftAsk[] = []
    const client = createExtensionForkDrafts(
      async (ask) => {
        asks.push(ask)
        if (ask.type === "listForkDrafts") return { type: "forkDrafts", drafts: [draft] }
        if (ask.type === "discardForkDraft") {
          return { type: "forkDraftDiscarded", draftId: ask.draftId }
        }
        return { type: "forkDraft", draft }
      },
      7
    )

    await client.ensure(parent)
    await client.edit(parent, parent.source, parent.capabilities)
    await client.rollback(draft.id, draft.currentRevision)
    await client.rename(draft.id, "Quiet copy")
    await client.discard(draft.id)
    expect(await client.list()).toEqual([draft])
    expect(asks.map((ask) => ask.type)).toEqual([
      "ensureForkDraft",
      "editForkDraft",
      "rollbackForkDraft",
      "renameForkDraft",
      "discardForkDraft",
      "listForkDrafts"
    ])
    expect(asks[1]).toHaveProperty("tabId", 7)
  })

  test("the service-worker handler returns errors as values", async () => {
    const editor = {
      ensure: async () => draft,
      edit: async () => {
        throw new Error("compile failed")
      },
      rollback: async () => draft,
      rename: async () => draft,
      discard: async () => {},
      list: async () => [draft]
    } satisfies ForkEditor
    const handle = forkDraftHandler(editor)

    expect(
      await handle({
        type: "editForkDraft",
        parent,
        source: parent.source,
        capabilities: parent.capabilities,
        tabId: 7
      })
    ).toEqual({ type: "forkDraftError", message: "compile failed" })
  })

  test("the boundary refuses malformed asks and the client refuses malformed answers", async () => {
    expect(isForkDraftAsk({ type: "editForkDraft", parent: null })).toBe(false)
    expect(isForkDraftAsk({ type: "rollbackForkDraft", draftId: "a" })).toBe(false)

    const client = createExtensionForkDrafts(
      async () => ({
        type: "forkDraftError",
        message: "sandbox failed"
      }),
      7
    )
    await expect(client.ensure(parent)).rejects.toEqual(
      new MarketplaceCommandFailure("sandbox failed")
    )
  })
})
