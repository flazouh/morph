import { describe, expect, test } from "bun:test"
import { digestOfBytes } from "../compiler/digest"
import { releaseGitHub } from "./github-release"
import { bytesOfFile, gitHubFake } from "./github-release.fake"
import { GitHubWriteError } from "./publishing"
import { RELEASE_PATH as PUBLISHED_PATH, setup, sourceOf, submissionOf } from "./publishing.fake"
import { base64Of, webpOf } from "./release-content.fake"
import { digestOfFile, type ReleaseFile } from "./release-content"

const RELEASE_PATH = "packages/alex/quiet-fork/1.0.0"
const TOKEN = "ghp-release-token"

/** The tree `releaseFilesOf` builds: text, two images, and the source it was built from. */
const releaseFiles = (): Readonly<Record<string, ReleaseFile>> => ({
  "manifest.json": `${JSON.stringify({ slug: "alex/quiet-fork", version: "1.0.0" }, null, 2)}\n`,
  "script.js": "export const start = () => \"quiet\"\n",
  "style.css": ".quiet { color: red }\n",
  "preview-before.webp": { base64: base64Of(webpOf()) },
  "preview-after.webp": { base64: base64Of(webpOf({ fill: 7 })) },
  "source/entry.ts": "export const start = () => \"quiet\"\n",
  "source/style.css": ".quiet { color: red }\n"
})

const adapterOf = (github: ReturnType<typeof gitHubFake>) =>
  releaseGitHub({ token: TOKEN, fetch: github.fetch })

const writesOf = (github: ReturnType<typeof gitHubFake>): ReadonlyArray<string> =>
  github.calls
    .filter((call) => call.method !== "GET")
    .map((call) => `${call.method} ${new URL(call.url).pathname}`)

const blobBodies = (github: ReturnType<typeof gitHubFake>): ReadonlyArray<Record<string, unknown>> =>
  github.calls
    .filter((call) => call.method === "POST" && call.url.endsWith("/git/blobs"))
    .map((call) => call.body ?? {})

const bodyOf = (github: ReturnType<typeof gitHubFake>, route: string): Record<string, unknown> =>
  github.calls.find((call) => call.method !== "GET" && call.url.endsWith(route))?.body ?? {}

const errorOf = async (work: Promise<unknown>): Promise<GitHubWriteError> => {
  try {
    await work
  } catch (cause) {
    if (cause instanceof GitHubWriteError) return cause
    throw cause
  }
  throw new Error("the call did not fail")
}

describe("committing a release to the packages repository", () => {
  test("a release lands as one tree, one commit and one fast-forward of the branch", async () => {
    const github = gitHubFake()
    const base = github.seed({ "README.md": "# packages\n" })
    const files = releaseFiles()

    const { commit } = await adapterOf(github).commit({
      path: RELEASE_PATH,
      files,
      message: "release alex/quiet-fork@1.0.0"
    })

    expect(writesOf(github)).toEqual([
      ...Object.keys(files).map(() => "/repos/flazouh/morph-packages/git/blobs").map((route) => `POST ${route}`),
      "POST /repos/flazouh/morph-packages/git/trees",
      "POST /repos/flazouh/morph-packages/git/commits",
      "PATCH /repos/flazouh/morph-packages/git/refs/heads/main"
    ])
    expect(github.head()).toBe(commit)

    const tree = bodyOf(github, "/git/trees")
    expect((tree.tree as ReadonlyArray<Record<string, unknown>>).map((entry) => entry.path)).toEqual(
      Object.keys(files).sort().map((file) => `${RELEASE_PATH}/${file}`)
    )
    expect((tree.tree as ReadonlyArray<Record<string, unknown>>).every((entry) => entry.mode === "100644" && entry.type === "blob")).toBe(true)

    const created = bodyOf(github, "/git/commits")
    expect(created.parents).toEqual([base])
    expect(created.message).toBe("release alex/quiet-fork@1.0.0")
    expect(bodyOf(github, "/git/refs/heads/main")).toEqual({ sha: commit, force: false })

    // The commit builds on the branch rather than replacing it.
    expect(Object.keys(github.filesAt("")).sort()).toEqual([
      "README.md",
      ...Object.keys(files).sort().map((file) => `${RELEASE_PATH}/${file}`)
    ])
  })

  test("every request carries the token, the JSON media type and the API version", async () => {
    const github = gitHubFake()
    github.seed({ "README.md": "# packages\n" })
    await adapterOf(github).commit({ path: RELEASE_PATH, files: releaseFiles(), message: "release" })

    for (const call of github.calls) {
      expect(call.headers).toMatchObject({
        Authorization: `Bearer ${TOKEN}`,
        "X-GitHub-Api-Version": "2022-11-28"
      })
    }
  })

  test("text goes up as text, images go up as the base64 they arrived in, byte for byte", async () => {
    const github = gitHubFake()
    github.seed({ "README.md": "# packages\n" })
    const files = releaseFiles()

    await adapterOf(github).commit({ path: RELEASE_PATH, files, message: "release" })

    const bodies = blobBodies(github)
    expect(bodies).toHaveLength(Object.keys(files).length)
    expect(bodies.filter((body) => body.encoding === "utf-8")).toHaveLength(5)
    expect(bodies.filter((body) => body.encoding === "base64")).toHaveLength(2)
    expect(bodies.some((body) => body.encoding === "utf-8" && body.content === files["script.js"])).toBe(true)
    expect(
      bodies.some(
        (body) => body.encoding === "base64" && body.content === (files["preview-before.webp"] as { base64: string }).base64
      )
    ).toBe(true)

    const written = github.filesAt(RELEASE_PATH)
    for (const [path, file] of Object.entries(files)) {
      expect(await digestOfBytes(new Uint8Array(written[path] ?? new Uint8Array()))).toBe(await digestOfFile(file))
    }
  })

  test("what a release committed reads back as the files it was given", async () => {
    const github = gitHubFake()
    github.seed({ "README.md": "# packages\n" })
    const files = releaseFiles()
    const adapter = adapterOf(github)

    const { commit } = await adapter.commit({ path: RELEASE_PATH, files, message: "release" })
    const found = await adapter.existing({ path: RELEASE_PATH })

    expect(found?.commit).toBe(commit)
    expect(found?.files).toEqual(files)
  })

  test("the release names the commit that wrote it, not wherever the branch has moved since", async () => {
    const github = gitHubFake()
    github.seed({ "README.md": "# packages\n" })
    const adapter = adapterOf(github)
    const { commit } = await adapter.commit({ path: RELEASE_PATH, files: releaseFiles(), message: "release" })
    github.seed({ "packages/alex/other/1.0.0/manifest.json": "{}\n" })

    expect(github.head()).not.toBe(commit)
    expect((await adapter.existing({ path: RELEASE_PATH }))?.commit).toBe(commit)
  })

  test("a path no release wrote is empty rather than an error", async () => {
    const github = gitHubFake()
    github.seed({ "README.md": "# packages\n", "packages/alex/other/1.0.0/manifest.json": "{}\n" })

    expect(await adapterOf(github).existing({ path: RELEASE_PATH })).toBeNull()
  })

  test("an identical release already at the path is adopted, and nothing is written", async () => {
    const github = gitHubFake()
    github.seed({ "README.md": "# packages\n" })
    const files = releaseFiles()
    const landed = github.seed(files, RELEASE_PATH)

    const { commit } = await adapterOf(github).commit({ path: RELEASE_PATH, files, message: "release" })

    expect(commit).toBe(landed)
    expect(writesOf(github)).toEqual([])
    expect(github.head()).toBe(landed)
  })

  test("a path holding other bytes is a conflict, and still nothing is written", async () => {
    const github = gitHubFake()
    github.seed({ "README.md": "# packages\n" })
    const files = releaseFiles()
    github.seed({ ...files, "script.js": "export const start = () => \"loud\"\n" }, RELEASE_PATH)

    const failure = await errorOf(adapterOf(github).commit({ path: RELEASE_PATH, files, message: "release" }))

    expect(failure.kind).toBe("conflict")
    expect(failure.message).toContain(RELEASE_PATH)
    expect(writesOf(github)).toEqual([])
  })

  test("a branch that moved under the commit is a conflict, and leaves no files behind", async () => {
    let pushed = false
    const github = gitHubFake({
      onCall: (call) => {
        if (call.method !== "PATCH" || pushed) return
        pushed = true
        github.seed({ "docs/note.md": "someone else was first\n" })
      }
    })
    github.seed({ "README.md": "# packages\n" })

    const failure = await errorOf(
      adapterOf(github).commit({ path: RELEASE_PATH, files: releaseFiles(), message: "release" })
    )

    expect(failure.kind).toBe("conflict")
    expect(failure.message).toContain("main")
    expect(writesOf(github).filter((route) => route.startsWith("PATCH"))).toHaveLength(1)
    expect(github.filesAt(RELEASE_PATH)).toEqual({})
  })

  test("GitHub refusing a write is unavailable rather than a conflict", async () => {
    const github = gitHubFake()
    github.seed({ "README.md": "# packages\n" })
    github.failOnce("/git/trees", 500, "Server Error")

    const failure = await errorOf(
      adapterOf(github).commit({ path: RELEASE_PATH, files: releaseFiles(), message: "release" })
    )

    expect(failure.kind).toBe("unavailable")
    expect(failure.message).toContain("500")
    expect(failure.message).toContain("Server Error")
    expect(github.filesAt(RELEASE_PATH)).toEqual({})
  })

  test("a rejected token is unavailable, and no branch is touched", async () => {
    const github = gitHubFake()
    github.seed({ "README.md": "# packages\n" })
    github.failOnce("/git/ref/heads/main", 401, "Bad credentials")

    const failure = await errorOf(
      adapterOf(github).commit({ path: RELEASE_PATH, files: releaseFiles(), message: "release" })
    )

    expect(failure.kind).toBe("unavailable")
    expect(failure.message).toContain("401")
    expect(writesOf(github)).toEqual([])
  })
})

describe("reading a release back the way a reader does", () => {
  test("the files come from commit-pinned raw URLs, in the shapes they were committed in", async () => {
    const github = gitHubFake()
    github.seed({ "README.md": "# packages\n" })
    const files = releaseFiles()
    const adapter = adapterOf(github)
    const { commit } = await adapter.commit({ path: RELEASE_PATH, files, message: "release" })
    const paths = Object.keys(files).sort()

    const read = await adapter.read({ commit, path: RELEASE_PATH, files: paths })

    expect(read).toEqual(files)
    for (const path of paths) {
      expect(await digestOfFile(read[path] ?? "")).toBe(await digestOfBytes(new Uint8Array(bytesOfFile(files[path] ?? ""))))
    }
    const raw = github.calls.filter((call) => call.url.startsWith("https://raw.githubusercontent.com/"))
    expect(raw.map((call) => call.url)).toEqual(
      paths.map((path) => `https://raw.githubusercontent.com/flazouh/morph-packages/${commit}/${RELEASE_PATH}/${path}`)
    )
    // A reader has no token, so verification must pass without one.
    expect(raw.every((call) => call.headers.Authorization === undefined)).toBe(true)
  })

  test("a file the raw host has not caught up with reads as null rather than as an error", async () => {
    const github = gitHubFake()
    github.seed({ "README.md": "# packages\n" })
    const files = releaseFiles()
    const adapter = adapterOf(github)
    const { commit } = await adapter.commit({ path: RELEASE_PATH, files, message: "release" })

    github.failOnce(`${RELEASE_PATH}/style.css`, 503, "no healthy upstream")
    const read = await adapter.read({
      commit,
      path: RELEASE_PATH,
      files: ["manifest.json", "style.css", "unwritten.txt"]
    })

    expect(read["style.css"]).toBeNull()
    expect(read["unwritten.txt"]).toBeNull()
    expect(read["manifest.json"]).toBe(files["manifest.json"] as string)
  })

  test("a raw host that refuses the read is a failure the caller can retry", async () => {
    const github = gitHubFake()
    github.seed({ "README.md": "# packages\n" })
    const adapter = adapterOf(github)
    const { commit } = await adapter.commit({ path: RELEASE_PATH, files: releaseFiles(), message: "release" })

    github.failOnce(`${RELEASE_PATH}/manifest.json`, 429, "rate limited")
    const failure = await errorOf(adapter.read({ commit, path: RELEASE_PATH, files: ["manifest.json"] }))

    expect(failure.kind).toBe("unavailable")
    expect(failure.message).toContain("429")
  })

  test("every path segment is encoded, on the API and on the raw host alike", async () => {
    const github = gitHubFake()
    github.seed({ "README.md": "# packages\n" })
    const path = "packages/alex/hn quiet/1.0.0"
    const adapter = adapterOf(github)

    const { commit } = await adapter.commit({ path, files: releaseFiles(), message: "release" })
    const found = await adapter.existing({ path })
    const read = await adapter.read({ commit, path, files: ["manifest.json"] })

    expect(found?.commit).toBe(commit)
    expect(read["manifest.json"]).toBe(releaseFiles()["manifest.json"] as string)
    expect(github.calls.some((call) => call.url.includes("/contents/packages/alex/hn%20quiet/1.0.0"))).toBe(true)
    expect(
      github.calls.some(
        (call) => call.url === `https://raw.githubusercontent.com/flazouh/morph-packages/${commit}/packages/alex/hn%20quiet/1.0.0/manifest.json`
      )
    ).toBe(true)
  })
})

/**
 * The adapter under the machine that drives it. A port that behaves on its own can still
 * hand the state machine a failure it reads the wrong way, and only these can show that a
 * lost race is retried and an occupied path is not.
 */
describe("the release run over a real GitHub adapter", () => {
  const publisherOn = (github: ReturnType<typeof gitHubFake>, world = setup()) => ({
    world,
    publisher: world.sharing({ github: releaseGitHub({ token: TOKEN, fetch: github.fetch }) })
  })

  test("a release is committed, read back from raw and completed", async () => {
    const github = gitHubFake()
    github.seed({ "README.md": "# packages\n" })

    const result = await publisherOn(github).publisher.publish(await submissionOf())

    expect(result.status).toBe("completed")
    if (result.status !== "completed") return
    expect(result.commit).toBe(github.head())
    expect(result.path).toBe(PUBLISHED_PATH)

    const written = github.filesAt(PUBLISHED_PATH)
    const recorded = result.run.files ?? {}
    expect(Object.keys(written).sort()).toEqual(Object.keys(recorded).sort())
    for (const [path, digest] of Object.entries(recorded)) {
      expect(await digestOfBytes(new Uint8Array(written[path] ?? new Uint8Array()))).toBe(digest)
    }
    // Verification really went through the raw host rather than through the API.
    expect(
      github.calls.filter((call) => call.url.startsWith(`https://raw.githubusercontent.com/flazouh/morph-packages/${result.commit}/`))
    ).toHaveLength(Object.keys(recorded).length)
  })

  test("a branch that moved fails the run as retryable, with nothing published", async () => {
    let pushed = false
    const github = gitHubFake({
      onCall: (call) => {
        if (call.method !== "PATCH" || pushed) return
        pushed = true
        github.seed({ "docs/note.md": "someone else was first\n" })
      }
    })
    github.seed({ "README.md": "# packages\n" })

    const result = await publisherOn(github).publisher.publish(await submissionOf())

    expect(result.status).toBe("failed")
    if (result.status !== "failed") return
    expect(result.code).toBe("github_conflict")
    expect(result.retryable).toBe(true)
    expect(result.stage).toBe("compiled")
    expect(github.filesAt(PUBLISHED_PATH)).toEqual({})
  })

  test("a run whose commit answer was lost adopts the tree instead of committing twice", async () => {
    const github = gitHubFake()
    github.seed({ "README.md": "# packages\n" })
    const first = await publisherOn(github).publisher.publish(await submissionOf())
    const writes = github.calls.filter((call) => call.method !== "GET").length

    // A second server, with no memory of the first run, publishing the same content.
    const second = await publisherOn(github).publisher.publish(await submissionOf())

    expect(first.status).toBe("completed")
    expect(second.status).toBe("completed")
    if (second.status !== "completed") return
    expect(second.commit).toBe(first.status === "completed" ? first.commit : "")
    expect(github.calls.filter((call) => call.method !== "GET")).toHaveLength(writes)
  })

  test("a release path holding other content stops the run for good", async () => {
    const github = gitHubFake()
    github.seed({ "README.md": "# packages\n" })
    await publisherOn(github).publisher.publish(await submissionOf())
    const landed = github.head()

    const other = await publisherOn(github).publisher.publish(await submissionOf({ source: sourceOf("louder") }))

    expect(other.status).toBe("failed")
    if (other.status !== "failed") return
    expect(other.code).toBe("github_path_taken")
    expect(other.retryable).toBe(false)
    expect(github.head()).toBe(landed)
  })
})
