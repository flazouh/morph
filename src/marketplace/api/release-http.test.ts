import { expect, test } from "bun:test"
import type { DeviceAuth } from "./auth"
import { releaseApi } from "./release-http"
import { rootSubmissionOf, setup, submissionOf } from "./publishing.fake"

const auth = (authenticated = true): DeviceAuth => ({
  authenticate: async () => authenticated
    ? {
        kind: "authenticated",
        user: {
          id: "u-fork",
          githubId: "1",
          handle: "alex",
          bannedAt: null
        },
        tokenId: "token-1",
        scopes: ["publish"]
      }
    : { kind: "invalid" },
  issue: async () => ({ kind: "invalid_scope" }),
  approve: async () => ({ kind: "invalid_code" }),
  deny: async () => ({ kind: "invalid_code" }),
  exchange: async () => ({ kind: "invalid_code" }),
  revoke: async () => ({ kind: "invalid" })
})

const noSession = async () => null

const clientBody = async () => {
  const release = await submissionOf()
  return {
    name: release.name,
    slug: release.slug,
    summary: release.summary,
    version: release.version,
    license: release.license,
    compatibility: release.compatibility,
    scope: release.scope,
    parent: release.parent,
    previews: release.previews,
    approvePermissionWidening: false,
    revision: {
      source: release.source,
      compiled: {
        sources: release.sources,
        artifacts: release.artifacts
      },
      capabilities: release.capabilities,
      permissions: { added: [], removed: [] }
    }
  }
}

test("release HTTP publishes the exact authenticated fork and reads its status", async () => {
  const { publisher } = setup()
  const api = releaseApi(auth(), publisher, noSession)
  const response = await api(new Request("https://api.test/v1/releases", {
    method: "POST",
    headers: {
      Authorization: "Bearer token",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(await clientBody())
  }))
  expect(response?.status).toBe(201)
  const published = await response!.json() as { id: string; state: string; commit: string }
  expect(published.state).toBe("completed")
  expect(published.commit).toMatch(/^[a-f0-9]{40}$/)

  const status = await api(new Request(
    `https://api.test/v1/releases/${encodeURIComponent(published.id)}`,
    { headers: { Authorization: "Bearer token" } }
  ))
  expect(status?.status).toBe(200)
  expect(await status!.json()).toMatchObject({
    id: published.id,
    state: "completed",
    slug: "alex/quiet-fork"
  })
})

const post = (body: unknown): Request =>
  new Request("https://api.test/v1/releases", {
    method: "POST",
    headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
    body: JSON.stringify(body)
  })

test("release HTTP publishes a page redesign as a script-v1 root package", async () => {
  const { publisher, versions } = setup()
  const api = releaseApi(auth(), publisher, noSession)
  const release = await rootSubmissionOf()
  const body = {
    runtime: "script-v1",
    name: release.name,
    slug: release.slug,
    summary: release.summary,
    version: release.version,
    license: release.license,
    compatibility: release.compatibility,
    scope: release.scope,
    previews: release.previews,
    approvePermissionWidening: false,
    revision: {
      source: release.source,
      compiled: { sources: release.sources, artifacts: release.artifacts },
      permissions: { added: [], removed: [] }
    }
  }
  const response = await api(post(body))
  expect(response?.status).toBe(201)
  expect(await response!.json()).toMatchObject({ state: "completed", slug: "alex/quiet-page" })
  expect(versions.get("alex/quiet-page@1.0.0")?.runtime).toBe("script-v1")

  // A page package declares no capabilities, and a half-written parent is no parent at all.
  expect((await api(post({ ...body, parent: { slug: "alex/quiet" } })))?.status).toBe(400)
  expect((await api(post({ ...body, revision: { ...body.revision, capabilities: {} } })))?.status).toBe(400)
  expect((await api(post({ ...body, runtime: "declarative-v1" })))?.status).toBe(400)
  expect((await api(post({ ...body, runtime: "sandbox-v1" })))?.status).toBe(400)
  // A page source has to pass the page contract: page.js with another script beside it is refused.
  expect((await api(post({
    ...body,
    revision: { ...body.revision, source: { ...release.source, files: { ...release.source.files, "extra.ts": "" } } }
  })))?.status).toBe(400)
})

test("release web routes require a session, hide other owners, and resume retryable runs", async () => {
  const world = setup()
  const submission = await submissionOf()
  const published = await world.publisher.publish(submission)
  if (published.run === null) throw new Error("expected release run")
  const releaseId = published.run.contentKey
  const sessions = async (request: Request) =>
    request.headers.get("cookie") === "morph_session=owner"
      ? { id: "u-fork", handle: "alex" }
      : request.headers.get("cookie") === "morph_session=other"
        ? { id: "u-other", handle: "other" }
        : null
  const api = releaseApi(auth(), world.publisher, sessions)

  expect((await api(new Request(
    `https://api.test/v1/releases/${encodeURIComponent(releaseId)}/public`
  )))?.status).toBe(401)
  expect((await api(new Request(
    `https://api.test/v1/releases/${encodeURIComponent(releaseId)}/public`,
    { headers: { cookie: "morph_session=other" } }
  )))?.status).toBe(404)

  const status = await api(new Request(
    `https://api.test/v1/releases/${encodeURIComponent(releaseId)}/public`,
    { headers: { cookie: "morph_session=owner" } }
  ))
  expect(status?.status).toBe(200)
  expect(await status!.json()).toMatchObject({
    id: releaseId,
    state: "completed",
    sourceUrl: `https://github.com/flazouh/morph-packages/tree/${published.run.commit}/${published.run.path}`
  })

  const retried = await api(new Request(
    `https://api.test/v1/releases/${encodeURIComponent(releaseId)}/retry`,
    { method: "POST", headers: { cookie: "morph_session=owner" } }
  ))
  expect(retried?.status).toBe(201)
  expect(await retried!.json()).toMatchObject({ id: releaseId, state: "completed" })
})

test("release HTTP refuses missing auth, another namespace, and large input", async () => {
  const { publisher } = setup()
  expect((await releaseApi(auth(false), publisher, noSession)(
    new Request("https://api.test/v1/releases", { method: "POST" })
  ))?.status).toBe(401)

  const body = await clientBody()
  expect((await releaseApi(auth(), publisher, noSession)(
    new Request("https://api.test/v1/releases", {
      method: "POST",
      headers: {
        Authorization: "Bearer token",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ ...body, slug: "someone-else/fork" })
    })
  ))?.status).toBe(400)

  expect((await releaseApi(auth(), publisher, noSession)(
    new Request("https://api.test/v1/releases", {
      method: "POST",
      headers: {
        Authorization: "Bearer token"
      },
      body: "x".repeat(3_000_001)
    })
  ))?.status).toBe(413)
})

test("release HTTP rejects an incomplete nested submission before publishing", async () => {
  let publishCalls = 0
  const { publisher } = setup()
  const api = releaseApi(auth(), {
    ...publisher,
    publish: async (submission) => {
      publishCalls += 1
      return publisher.publish(submission)
    }
  }, noSession)
  const body = await clientBody()
  const response = await api(new Request("https://api.test/v1/releases", {
    method: "POST",
    headers: {
      Authorization: "Bearer token",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      ...body,
      revision: {
        ...body.revision,
        compiled: { ...body.revision.compiled, sources: null }
      }
    })
  }))

  expect(response?.status).toBe(400)
  expect(await response!.json()).toEqual({ error: "invalid_release" })
  expect(publishCalls).toBe(0)
})

test("release HTTP ignores requests outside release routes", async () => {
  const { publisher } = setup()
  const response = await releaseApi(auth(false), publisher, noSession)(
    new Request("https://api.test/health")
  )

  expect(response).toBeNull()
})
