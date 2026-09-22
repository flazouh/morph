/**
 * The extension's publisher client against the server's release API, in one process.
 *
 * Each side has its own tests, and each passed while the fork body the client sent was one
 * the server refused: the client put the two pictures at the top level, the server read
 * them under `previews`. This is the test that would have caught it, so it stays.
 */
import { expect, test } from "bun:test"
import type { DeviceAuth } from "../api/auth"
import { COMPILER, rootSubmissionOf, setup, submissionOf } from "../api/publishing.fake"
import { releaseApi } from "../api/release-http"
import type { ForkDraft } from "../forks/model"
import { createPublisherClient, memoryPublisherTokens, type PublisherToken } from "./client"

const token: PublisherToken = { accessToken: "secret", expiresAt: "2026-09-09T21:00:00.000Z", scopes: ["publish"] }

const auth: DeviceAuth = {
  authenticate: async () => ({
    kind: "authenticated",
    user: { id: "u-fork", githubId: "1", handle: "alex", bannedAt: null },
    tokenId: "token-1",
    scopes: ["publish"]
  }),
  issue: async () => ({ kind: "invalid_scope" }),
  approve: async () => ({ kind: "invalid_code" }),
  deny: async () => ({ kind: "invalid_code" }),
  exchange: async () => ({ kind: "invalid_code" }),
  revoke: async () => ({ kind: "invalid" })
}

const clientAgainst = (api: ReturnType<typeof releaseApi>) => {
  const tokens = memoryPublisherTokens()
  return {
    tokens,
    client: createPublisherClient("https://api.test", {
      tokens,
      now: () => new Date("2026-09-09T20:00:00.000Z"),
      open: async () => {},
      sleep: async () => {},
      fetch: async (input, init) => {
        const response = await api(new Request(String(input), init))
        if (response === null) throw new Error(`no route for ${String(input)}`)
        return response
      }
    })
  }
}

test("a page release the client sends is one the server publishes", async () => {
  const { publisher, versions } = setup()
  const { client, tokens } = clientAgainst(releaseApi(auth, publisher, async () => null))
  await tokens.write(token)
  const submission = await rootSubmissionOf()

  const status = await client.publishPage(
    { scope: { ...submission.scope, kind: "page" }, source: submission.source, compiled: { sources: submission.sources, artifacts: submission.artifacts } },
    {
      name: submission.name,
      slug: submission.slug,
      summary: submission.summary,
      version: submission.version,
      license: submission.license,
      before: submission.previews.before,
      after: submission.previews.after,
      approvePermissionWidening: false
    }
  )
  expect(status.state).toBe("completed")
  expect(status.slug).toBe("alex/quiet-page")
  expect(versions.get("alex/quiet-page@1.0.0")?.runtime).toBe("script-v1")
})

test("a fork release the client sends is one the server publishes", async () => {
  const { publisher, versions } = setup()
  const { client, tokens } = clientAgainst(releaseApi(auth, publisher, async () => null))
  await tokens.write(token)
  const submission = await submissionOf()
  const draft: ForkDraft = {
    id: "draft-1",
    parent: { ...submission.parent, license: submission.license, compatibility: submission.compatibility },
    runtime: "sandbox-v1",
  parentCapabilities: submission.capabilities,
    scope: submission.scope,
    currentRevision: "revision-1",
    revisions: [
      {
        id: "revision-1",
        source: submission.source,
        compiled: { compiler: COMPILER, script: "", style: "", sources: submission.sources, artifacts: submission.artifacts },
        capabilities: submission.capabilities,
        permissions: { added: [], removed: [] },
        createdAt: "2026-09-09T20:00:00.000Z"
      }
    ],
    createdAt: "2026-09-09T20:00:00.000Z",
    updatedAt: "2026-09-09T20:00:00.000Z"
  }

  const status = await client.publish(draft, {
    name: submission.name,
    slug: submission.slug,
    summary: submission.summary,
    version: submission.version,
    before: submission.previews.before,
    after: submission.previews.after,
    approvePermissionWidening: false
  })
  expect(status.state).toBe("completed")
  expect(versions.get("alex/quiet-fork@1.0.0")?.runtime).toBe("sandbox-v1")
})
