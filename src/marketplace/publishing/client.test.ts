import { describe, expect, test } from "bun:test"
import type { ForkDraft } from "../forks/model"
import {
  createPublisherClient,
  memoryPublisherTokens,
  PublisherFailure,
  type ReleaseStatus,
  type PublisherToken
} from "./client"

const json = (value: unknown, status = 200): Response =>
  Response.json(value, { status })

const token: PublisherToken = {
  accessToken: "secret-token",
  expiresAt: "2026-09-09T21:00:00.000Z",
  scopes: ["publish"]
}

const draft = {
  id: "draft-1",
  parent: {
    slug: "flazouh/focus",
    version: "1.0.0",
    commit: "0123456789abcdef0123456789abcdef01234567",
    license: "MIT",
    compatibility: { kit: "^1.0.0", chrome: ">=120" }
  },
  parentCapabilities: {},
  scope: {
    kind: "page",
    origin: "https://github.com",
    paths: ["/pulls"]
  },
  currentRevision: "revision-1",
  revisions: [
    {
      id: "revision-1",
      source: { entry: "entry.ts", style: "style.css", files: {} },
      compiled: {
        compiler: "morph-package-1",
        script: "script",
        style: "style",
        sources: {},
        artifacts: {
          script: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
          css: "sha256:2222222222222222222222222222222222222222222222222222222222222222"
        }
      },
      capabilities: {},
      permissions: { added: [], removed: [] },
      createdAt: "2026-09-09T20:00:00.000Z"
    }
  ],
  createdAt: "2026-09-09T20:00:00.000Z",
  updatedAt: "2026-09-09T20:00:00.000Z"
} as unknown as ForkDraft

const completed = {
  id: "release-1",
  state: "completed",
  slug: "alex/focus-blue",
  version: "1.0.0",
  commit: "abcdef0123456789abcdef0123456789abcdef01",
  receipt: "signed-receipt",
  retryable: false,
  error: null
} satisfies ReleaseStatus

describe("extension publisher client", () => {
  test("opens GitHub sign-in, polls pending authorization, and saves one scoped token", async () => {
    const memory = memoryPublisherTokens()
    const opened: string[] = []
    let now = new Date("2026-09-09T20:00:00.000Z")
    let tokenPolls = 0
    const client = createPublisherClient("https://api.test", {
      tokens: memory,
      now: () => now,
      open: async (url) => {
        opened.push(url)
      },
      sleep: async (milliseconds) => {
        now = new Date(now.getTime() + milliseconds)
      },
      fetch: async (input) => {
        const url = String(input)
        if (url.endsWith("/v1/auth/device")) {
          return json({
            deviceCode: "device-secret",
            userCode: "MORPH-12",
            verificationUri: "https://market.test/device",
            expiresAt: "2026-09-09T20:05:00.000Z",
            intervalSeconds: 1
          })
        }
        tokenPolls += 1
        return tokenPolls === 1
          ? json({ error: "authorization_pending" }, 428)
          : json(token)
      }
    })

    expect(await client.signIn()).toEqual(token)
    expect(await memory.read()).toEqual(token)
    expect(opened).toEqual(["https://market.test/device"])
    expect(tokenPolls).toBe(2)
  })

  test("rejects an access token without the required publish scope", async () => {
    const client = createPublisherClient("https://api.test", {
      tokens: memoryPublisherTokens(),
      now: () => new Date("2026-09-09T20:00:00.000Z"),
      open: async () => {},
      sleep: async () => {},
      fetch: async (input) =>
        String(input).endsWith("/v1/auth/device")
          ? json({
              deviceCode: "device-secret",
              userCode: "MORPH-12",
              verificationUri: "https://market.test/device",
              expiresAt: "2026-09-09T20:05:00.000Z",
              intervalSeconds: 1
            })
          : json({
              accessToken: "secret-token",
              expiresAt: "2026-09-09T21:00:00.000Z",
              scopes: []
            })
    })

    await expect(client.signIn()).rejects.toEqual(
      new PublisherFailure(
        "invalid_response",
        "The marketplace returned an invalid access token."
      )
    )
  })

  test("submits the exact local revision and clears a rejected token", async () => {
    const memory = memoryPublisherTokens()
    await memory.write(token)
    let submitted: unknown
    let reject = false
    const client = createPublisherClient("https://api.test", {
      tokens: memory,
      now: () => new Date("2026-09-09T20:00:00.000Z"),
      open: async () => {},
      sleep: async () => {},
      fetch: async (_input, init) => {
        submitted = init?.body === undefined ? undefined : JSON.parse(String(init.body))
        return reject
          ? json({ error: "invalid_token", message: "Sign in again." }, 401)
          : json(completed)
      }
    })

    expect(
      await client.publish(draft, {
        name: "Focus Blue",
        slug: "alex/focus-blue",
        summary: "A blue pull inbox",
        version: "1.0.0",
        before: { data: "data:image/webp;base64,before", digest: `sha256:${"a".repeat(64)}` },
        after: { data: "data:image/webp;base64,after", digest: `sha256:${"b".repeat(64)}` },
        approvePermissionWidening: false
      })
    ).toEqual(completed)
    expect((submitted as { parent: unknown }).parent).toEqual(draft.parent)
    expect((submitted as { license: string }).license).toBe("MIT")
    expect((submitted as { compatibility: unknown }).compatibility).toEqual({
      kit: "^1.0.0",
      chrome: ">=120"
    })
    expect((submitted as { revision: { id: string } }).revision.id).toBe("revision-1")

    reject = true
    await expect(
      client.publish(draft, {
        name: "Focus Blue",
        slug: "alex/focus-blue",
        summary: "A blue pull inbox",
        version: "1.0.0",
        before: { data: "before", digest: `sha256:${"a".repeat(64)}` },
        after: { data: "after", digest: `sha256:${"b".repeat(64)}` },
        approvePermissionWidening: false
      })
    ).rejects.toEqual(new PublisherFailure("invalid_token", "Sign in again."))
    expect(await memory.read()).toBeUndefined()
  })

  test("does not use an expired stored token", async () => {
    const memory = memoryPublisherTokens()
    await memory.write({ ...token, expiresAt: "2026-09-09T19:59:59.000Z" })
    const client = createPublisherClient("https://api.test", {
      tokens: memory,
      now: () => new Date("2026-09-09T20:00:00.000Z"),
      open: async () => {},
      sleep: async () => {},
      fetch: async () => json({ error: "unreachable" }, 500)
    })
    expect(await client.token()).toBeUndefined()
    expect(await memory.read()).toBeUndefined()
  })
})
