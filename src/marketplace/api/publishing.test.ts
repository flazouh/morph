import { describe, expect, test } from "bun:test"
import { digestOf } from "../compiler/digest"
import { PackageCompileError } from "../compiler/error"
import { byteLengthOf, PREVIEW_FILES } from "./release-content"
import {
  GitHubWriteError,
  PACKAGE_REPOSITORY,
  RELEASE_STAGES,
  releaseContentKey,
  type ReleaseSubmission
} from "./publishing"
import { base64Of, previewsOf, webpOf } from "./release-content.fake"
import {
  capabilities,
  COMPILER,
  PARENT_COMMIT,
  RELEASE_COMMIT,
  RELEASE_PATH,
  pageForkSubmissionOf,
  rootSubmissionOf,
  setup,
  signFake,
  sourceOf,
  submissionOf,
  textOf
} from "./publishing.fake"

describe("resumable release runs", () => {
  test("a fork publishes as a new package tied to its exact parent, verified before it is cataloged", async () => {
    const { publisher, counts, transitions, versions, packages } = setup()
    const submission = await submissionOf()
    const result = await publisher.publish(submission)

    expect(result.status).toBe("completed")
    if (result.status !== "completed") return
    expect(transitions).toEqual(["open:accepted", "compiled", "committed", "verified", "cataloged", "completed"])
    expect(transitions.slice(1)).toEqual(RELEASE_STAGES.filter((stage) => stage !== "accepted"))
    expect(result.commit).toBe(RELEASE_COMMIT)
    expect(result.path).toBe(RELEASE_PATH)
    expect(result.slug).toBe("alex/quiet-fork")
    expect(result.version).toBe("1.0.0")
    expect(result.receipt).toBe(
      await signFake({
        contentKey: await releaseContentKey(submission),
        slug: "alex/quiet-fork",
        version: "1.0.0",
        repository: PACKAGE_REPOSITORY,
        commit: RELEASE_COMMIT,
        path: RELEASE_PATH,
        compiler: COMPILER,
        artifacts: submission.artifacts,
        files: result.run.files ?? {},
        parent: { slug: "alex/quiet", version: "1.2.0", commit: PARENT_COMMIT },
        permissions: { added: [], removed: [] },
        catalogedAt: result.run.catalogedAt ?? ""
      })
    )

    const written = versions.get("alex/quiet-fork@1.0.0")
    expect(written?.forkedFrom).toEqual({ packageId: "pkg-parent", versionId: "ver-parent-1.2.0" })
    expect(written?.repository).toBe(PACKAGE_REPOSITORY)
    expect(written?.commit).toBe(RELEASE_COMMIT)
    expect(written?.manifest.slug).toBe("alex/quiet-fork")
    expect(written?.manifest.runtime).toBe("sandbox-v1")
    expect(written?.manifest.capabilities).toEqual(submission.capabilities)
    expect(written?.packageId).not.toBe("pkg-parent")
    expect(packages.get("alex/quiet")).toEqual({ id: "pkg-parent", latestVersion: "1.2.0", forkedFrom: null })
    expect(counts).toMatchObject({ compile: 1, commit: 1, catalog: 1, inserts: 1, sign: 1 })
    expect(result.run.error).toBeNull()
    expect(result.run.completedAt).not.toBeNull()
  })

  test("a page redesign publishes as a root package: no parent, no capabilities, no permission confirmation", async () => {
    const { publisher, counts, transitions, versions, packages } = setup()
    const submission = await rootSubmissionOf()
    const result = await publisher.publish(submission)

    expect(result.status).toBe("completed")
    if (result.status !== "completed") return
    expect(transitions).toEqual(["open:accepted", "compiled", "committed", "verified", "cataloged", "completed"])
    expect(result.slug).toBe("alex/quiet-page")
    expect(result.run.parent).toBeNull()
    expect(result.run.permissions).toEqual({ added: [], removed: [] })
    expect(result.run.approved).toBe(true)
    expect(result.receipt).toBe(
      await signFake({
        contentKey: await releaseContentKey(submission),
        slug: "alex/quiet-page",
        version: "1.0.0",
        repository: PACKAGE_REPOSITORY,
        commit: RELEASE_COMMIT,
        path: "packages/alex/quiet-page/1.0.0",
        compiler: COMPILER,
        artifacts: submission.artifacts,
        files: result.run.files ?? {},
        parent: null,
        permissions: { added: [], removed: [] },
        catalogedAt: result.run.catalogedAt ?? ""
      })
    )

    const written = versions.get("alex/quiet-page@1.0.0")
    expect(written?.runtime).toBe("script-v1")
    expect(written?.forkedFrom).toBeNull()
    expect(written?.manifest.runtime).toBe("script-v1")
    expect(written?.manifest.entry).toBe("page.js")
    expect(written?.manifest.capabilities).toBeUndefined()
    expect(written?.manifest.permissions).toEqual({ page: ["read:text", "read:attributes", "navigate"], network: [] })
    expect(packages.get("alex/quiet-page")).toEqual({ id: written?.packageId ?? "", latestVersion: "1.0.0", forkedFrom: null })
    expect(counts).toMatchObject({ compile: 1, commit: 1, catalog: 1, inserts: 1, sign: 1 })
    // The parent lookup is a fork's step; a root never asks for one.
    expect(transitions).not.toContain("parent")
  })

  test("a page redesign that forks another names its parent and still confirms nothing", async () => {
    const { publisher, versions, packages } = setup()
    const submission = await pageForkSubmissionOf()
    const result = await publisher.publish(submission)

    expect(result.status).toBe("completed")
    if (result.status !== "completed") return
    expect(result.run.parent).toMatchObject({
      slug: "alex/quiet-front",
      version: "1.2.0",
      versionId: "ver-page-parent-1.2.0"
    })
    expect(result.run.permissions).toEqual({ added: [], removed: [] })
    expect(result.run.approved).toBe(true)

    const written = versions.get("alex/quiet-page@1.0.0")
    expect(written?.runtime).toBe("script-v1")
    const lineage = { packageId: "pkg-page-parent", versionId: "ver-page-parent-1.2.0" }
    expect(written?.forkedFrom).toEqual(lineage)
    expect(written?.manifest.capabilities).toBeUndefined()
    expect(packages.get("alex/quiet-page")?.forkedFrom).toBe("ver-page-parent-1.2.0")
  })

  test("a page fork is refused when the parent is not the release the catalog holds", async () => {
    const cases = [
      ["parent_unknown", { parent: { slug: "alex/nobody", version: "1.2.0", commit: PARENT_COMMIT } }],
      ["parent_commit_mismatch", { parent: { slug: "alex/quiet-front", version: "1.2.0", commit: "9".repeat(40) } }],
      ["parent_slug_reused", { slug: "alex/quiet-front" }]
    ] as const

    for (const [code, over] of cases) {
      const { publisher, counts } = setup()
      const result = await publisher.publish(await pageForkSubmissionOf(over))
      expect(result.status).toBe("failed")
      if (result.status !== "failed") return
      expect({ code: result.code, retryable: result.retryable }).toEqual({ code, retryable: false })
      expect(counts).toMatchObject({ compile: 0, commit: 0, catalog: 0 })
    }
  })

  test("a root package's content key differs from a fork's of the same files, and never names a parent", async () => {
    const root = await rootSubmissionOf()
    const fork = await submissionOf({ slug: root.slug, name: root.name, source: root.source })
    expect(await releaseContentKey(root)).not.toBe(await releaseContentKey(fork))
    expect(await releaseContentKey({ ...root, capabilities: undefined, parent: undefined })).toBe(await releaseContentKey(root))
  })

  test("the committed tree carries the manifest, both artifacts, both previews, and every source file", async () => {
    const { publisher, trees } = setup()
    const submission = await submissionOf()
    const result = await publisher.publish(submission)
    expect(result.status).toBe("completed")
    if (result.status !== "completed") return

    const tree = trees.get(RELEASE_PATH)
    const files = tree?.files ?? {}
    expect(Object.keys(files).sort()).toEqual([
      "manifest.json",
      "preview-after.webp",
      "preview-before.webp",
      "script.js",
      "source/entry.ts",
      "source/style.css",
      "style.css"
    ])
    expect(files["source/entry.ts"]).toBe(submission.source.files["entry.ts"])
    const manifest = JSON.parse(textOf(files["manifest.json"])) as Record<string, unknown>
    expect(manifest.files).toEqual(submission.sources)
    expect(manifest.artifacts).toEqual(submission.artifacts)
    expect(manifest.version).toBe("1.0.0")

    // The manifest names the images by digest, and the commit holds the bytes it names,
    // so the raw URL a reader is handed for `preview-before.webp` resolves to an image.
    const { before, after } = submission.previews
    expect(manifest.previews).toEqual({ before: before.digest, after: after.digest })
    expect(files[PREVIEW_FILES.before]).toEqual({ base64: before.data })
    expect(result.run.files?.[PREVIEW_FILES.after]).toBe(after.digest)
    expect(result.run.bytes).toBe(Object.values(files).reduce((total, file) => total + byteLengthOf(file), 0))
    expect(result.run.bytes).toBeGreaterThan(128)
  })

  test("a preview that is not the image it claims stops the release before anything is written", async () => {
    const { publisher, counts } = setup()
    const submission = await submissionOf()
    const lying = {
      ...submission,
      previews: { ...submission.previews, after: { ...submission.previews.after, digest: await digestOf("elsewhere") } }
    }

    const result = await publisher.publish(lying)
    expect(result.status).toBe("failed")
    if (result.status !== "failed") return
    expect({ code: result.code, retryable: result.retryable }).toEqual({
      code: "preview_digest_mismatch",
      retryable: false
    })
    // Nothing was compiled, nothing was written, and no run holds the rejected content.
    expect(result.run).toBeNull()
    expect(await publisher.status(await releaseContentKey(lying))).toBeNull()
    expect(counts).toMatchObject({ compile: 0, commit: 0, catalog: 0 })
    expect(result.message).not.toContain(submission.previews.after.data.slice(0, 24))
  })

  test("repeated and concurrent requests resume one run and return the same release", async () => {
    const { publisher, counts } = setup()
    const submission = await submissionOf()
    const [first, second] = await Promise.all([publisher.publish(submission), publisher.publish(submission)])
    const third = await publisher.publish(await submissionOf())

    expect(first).toEqual(second)
    expect(first.status).toBe("completed")
    if (first.status !== "completed" || third.status !== "completed") return
    expect(third.commit).toBe(first.commit)
    expect(third.receipt).toBe(first.receipt)
    expect(third.package).toEqual(first.package)
    expect(third.run.id).toBe(first.run.id)
    expect(counts).toMatchObject({ compile: 1, commit: 1, inserts: 1, sign: 1 })
  })

  test("a server compile that disagrees with the submitted digests refuses before any commit", async () => {
    const base = await submissionOf()
    const cases = [
      ["artifact_mismatch", { artifacts: { ...base.artifacts, script: await digestOf("another script") } }],
      ["source_digest_mismatch", { sources: { ...base.sources, "entry.ts": await digestOf("another entry") } }]
    ] as const

    for (const [code, over] of cases) {
      const { publisher, counts } = setup()
      const result = await publisher.publish({ ...base, ...over })

      expect(result.status).toBe("failed")
      if (result.status !== "failed") return
      expect({ code: result.code, retryable: result.retryable, stage: result.stage }).toEqual({
        code,
        retryable: false,
        stage: "accepted"
      })
      expect(result.run?.stage).toBe("accepted")
      expect(result.run?.error).toEqual({
        stage: "accepted",
        code,
        retryable: false
      })
      expect(counts).toMatchObject({ compile: 1, commit: 0, catalog: 0, sign: 0 })
    }
  })

  test("a compile refusal is fatal and a compiler crash stays retryable", async () => {
    const { publisher, faults, counts } = setup()
    const submission = await submissionOf()
    faults.compileError = new PackageCompileError("entry.ts imports \"fs\"", { reason: "import", file: "entry.ts" })

    const refused = await publisher.publish(submission)
    expect(refused.status).toBe("failed")
    if (refused.status !== "failed") return
    expect({ code: refused.code, retryable: refused.retryable }).toEqual({ code: "compile_refused", retryable: false })
    expect(refused.message).toContain("entry.ts imports")

    faults.compile = 1
    const crashed = await publisher.publish(submission)
    expect(crashed.status).toBe("failed")
    if (crashed.status !== "failed") return
    expect({ code: crashed.code, retryable: crashed.retryable }).toEqual({ code: "compile_failed", retryable: true })

    expect((await publisher.publish(submission)).status).toBe("completed")
    expect(counts).toMatchObject({ commit: 1, inserts: 1 })
  })

  test("widened permissions wait for the exact confirmation the creator saw", async () => {
    const widened = await submissionOf({ capabilities: capabilities({ storage: true }) })
    const { publisher, counts } = setup()

    const unapproved = await publisher.publish(widened)
    expect(unapproved.status).toBe("failed")
    if (unapproved.status !== "failed") return
    expect({ code: unapproved.code, retryable: unapproved.retryable }).toEqual({
      code: "permission_widening_unapproved",
      retryable: false
    })
    expect(unapproved.run?.permissions).toEqual({ added: ["storage"], removed: [] })
    expect(unapproved.run?.approved).toBe(false)

    const stale = await publisher.publish({ ...widened, approvedPermissions: ["context.route"] })
    expect(stale.status).toBe("failed")
    if (stale.status !== "failed") return
    expect(stale.code).toBe("permission_widening_unapproved")
    expect(counts).toMatchObject({ commit: 0, catalog: 0 })

    const approved = await publisher.publish({ ...widened, approvedPermissions: ["storage"] })
    expect(approved.status).toBe("completed")
    if (approved.status !== "completed") return
    expect(approved.run.id).toBe(unapproved.run!.id)
    expect(approved.run.approved).toBe(true)
    expect(counts).toMatchObject({ commit: 1, inserts: 1 })
  })

  test("the permission baseline is the catalog's parent, not the submission's word for it", async () => {
    const { publisher } = setup("1.2.0", capabilities({ storage: true }))
    const result = await publisher.publish(await submissionOf())

    expect(result.status).toBe("completed")
    if (result.status !== "completed") return
    expect(result.run.permissions).toEqual({ added: [], removed: ["storage"] })
  })

  test("a release whose manifest would be invalid is refused before it is committed", async () => {
    const { publisher, counts } = setup()
    const result = await publisher.publish(await submissionOf({ version: "1.0" }))

    expect(result.status).toBe("failed")
    if (result.status !== "failed") return
    expect({ code: result.code, retryable: result.retryable }).toEqual({ code: "manifest_invalid", retryable: false })
    expect(result.message).toContain("version")
    expect(counts).toMatchObject({ compile: 1, commit: 0, catalog: 0 })
  })

  test("a GitHub ref conflict is retryable and never commits one release twice", async () => {
    const { sharing, github, counts, trees } = setup()
    const submission = await submissionOf()
    let conflicts = 1
    const conflicted = sharing({
      github: {
        ...github,
        commit: async (input) => {
          if (conflicts-- > 0) {
            // The ref moved under the write, and this tree landed all the same.
            trees.set(input.path, { commit: RELEASE_COMMIT, files: { ...input.files } })
            throw new GitHubWriteError("conflict", "409 reference already exists")
          }
          return github.commit(input)
        }
      }
    })

    const first = await conflicted.publish(submission)
    expect(first.status).toBe("failed")
    if (first.status !== "failed") return
    expect({ code: first.code, retryable: first.retryable, stage: first.stage }).toEqual({
      code: "github_conflict",
      retryable: true,
      stage: "compiled"
    })
    expect(first.run?.commit).toBeNull()

    const second = await conflicted.publish(submission)
    expect(second.status).toBe("completed")
    if (second.status !== "completed") return
    expect(second.commit).toBe(RELEASE_COMMIT)
    expect(counts.commit).toBe(0)
    expect(counts.inserts).toBe(1)
  })

  test("a tree that already holds different bytes at the release path is refused", async () => {
    const { publisher, trees, counts } = setup()
    trees.set(RELEASE_PATH, { commit: "9".repeat(40), files: { "manifest.json": "{}" } })
    const result = await publisher.publish(await submissionOf())

    expect(result.status).toBe("failed")
    if (result.status !== "failed") return
    expect({ code: result.code, retryable: result.retryable }).toEqual({ code: "github_path_taken", retryable: false })
    expect(counts).toMatchObject({ commit: 0, catalog: 0 })
  })

  test("raw files that have not propagated keep the run retryable, and changed bytes fail it", async () => {
    const { sharing, github, counts, trees } = setup()
    const submission = await submissionOf()
    let hide = true
    const delayed = sharing({
      github: {
        ...github,
        // An image is read back like every other file, so it waits like every other file.
        read: async (input) =>
          hide ? { ...(await github.read(input)), [PREVIEW_FILES.before]: null } : github.read(input)
      }
    })

    const pending = await delayed.publish(submission)
    expect(pending.status).toBe("failed")
    if (pending.status !== "failed") return
    expect({ code: pending.code, retryable: pending.retryable, stage: pending.stage }).toEqual({
      code: "github_not_propagated",
      retryable: true,
      stage: "committed"
    })
    expect(pending.message).toContain(PREVIEW_FILES.before)
    expect(pending.run?.commit).toBe(RELEASE_COMMIT)
    expect(counts).toMatchObject({ commit: 1, catalog: 0, sign: 0 })

    const tree = trees.get(RELEASE_PATH)
    trees.set(RELEASE_PATH, {
      commit: RELEASE_COMMIT,
      files: { ...tree?.files, [PREVIEW_FILES.after]: { base64: base64Of(webpOf({ fill: 3 })) } }
    })
    hide = false
    const rewritten = await delayed.publish(submission)
    expect(rewritten.status).toBe("failed")
    if (rewritten.status !== "failed") return
    expect({ code: rewritten.code, retryable: rewritten.retryable }).toEqual({
      code: "github_content_mismatch",
      retryable: false
    })
    expect(counts).toMatchObject({ catalog: 0, sign: 0 })
  })

  test("a database failure is retryable and a retry writes exactly one catalog version", async () => {
    const { publisher, faults, counts } = setup()
    const submission = await submissionOf()

    faults.load = 1
    const unreadable = await publisher.publish(submission)
    expect(unreadable.status).toBe("failed")
    if (unreadable.status !== "failed") return
    expect({ code: unreadable.code, retryable: unreadable.retryable }).toEqual({
      code: "run_unreadable",
      retryable: true
    })

    faults.catalog = 1
    const failed = await publisher.publish(submission)
    expect(failed.status).toBe("failed")
    if (failed.status !== "failed") return
    expect({ code: failed.code, retryable: failed.retryable, stage: failed.stage }).toEqual({
      code: "catalog_failed",
      retryable: true,
      stage: "verified"
    })

    expect((await publisher.publish(submission)).status).toBe("completed")
    expect(counts).toMatchObject({ commit: 1, catalog: 2, inserts: 1 })
  })

  test("a newer parent version changes neither the fork's lineage nor the parent package", async () => {
    const { publisher, versions, packages } = setup("2.0.0")
    const result = await publisher.publish(await submissionOf())

    expect(result.status).toBe("completed")
    if (result.status !== "completed") return
    expect(result.run.parent).toEqual({
      slug: "alex/quiet",
      version: "1.2.0",
      commit: PARENT_COMMIT,
      packageId: "pkg-parent",
      versionId: "ver-parent-1.2.0"
    })
    expect(versions.get("alex/quiet-fork@1.0.0")?.forkedFrom?.versionId).toBe("ver-parent-1.2.0")
    expect(packages.get("alex/quiet")?.latestVersion).toBe("2.0.0")
    expect(versions.get("alex/quiet@2.0.0")).toBeUndefined()
  })

  test("an unknown parent, a moved parent commit, and a reused parent slug are refused", async () => {
    const base = await submissionOf()
    const cases = [
      ["parent_unknown", { parent: { ...base.parent, version: "9.9.9" } }],
      ["parent_commit_mismatch", { parent: { ...base.parent, commit: "b".repeat(40) } }],
      ["parent_slug_reused", { slug: "alex/quiet" }]
    ] as const

    for (const [code, over] of cases) {
      const { publisher, counts } = setup()
      const result = await publisher.publish({ ...base, ...over })
      expect(result.status).toBe("failed")
      if (result.status !== "failed") return
      expect({ code: result.code, retryable: result.retryable }).toEqual({ code, retryable: false })
      expect(counts).toMatchObject({ compile: 0, commit: 0, catalog: 0 })
    }
  })

  test("different content under a taken package version is refused", async () => {
    const { publisher, counts } = setup()
    await publisher.publish(await submissionOf())
    const result = await publisher.publish(await submissionOf({ source: sourceOf("a different fork") }))

    expect(result.status).toBe("failed")
    if (result.status !== "failed") return
    expect({ code: result.code, retryable: result.retryable }).toEqual({
      code: "version_taken",
      retryable: false
    })
    expect(counts).toMatchObject({ inserts: 1 })
  })

  test("a run resumes from stored state alone, with no submission in hand", async () => {
    const { publisher, faults, counts } = setup()
    const submission = await submissionOf()
    const key = await releaseContentKey(submission)
    faults.catalog = 1
    expect((await publisher.publish(submission)).status).toBe("failed")
    expect((await publisher.status(key))?.stage).toBe("verified")

    const resumed = await publisher.resume(key)
    expect(resumed.status).toBe("completed")
    if (resumed.status !== "completed") return
    expect(resumed.commit).toBe(RELEASE_COMMIT)
    expect((await publisher.status(key))?.stage).toBe("completed")
    expect(counts).toMatchObject({ commit: 1, inserts: 1 })

    const unknown = `sha256:${"0".repeat(64)}`
    const missing = await publisher.resume(unknown)
    expect(missing.status).toBe("failed")
    if (missing.status !== "failed") return
    expect({ code: missing.code, retryable: missing.retryable }).toEqual({ code: "run_unknown", retryable: false })
    expect(await publisher.status(unknown)).toBeNull()
  })

  test("a compiled run resumes from its stored build after the compiler changes", async () => {
    const { publisher, sharing, faults, ports, counts } = setup()
    const submission = await submissionOf()
    const key = await releaseContentKey(submission)
    faults.advance.add("committed")

    const interrupted = await publisher.publish(submission)
    expect(interrupted.status).toBe("failed")
    expect((await publisher.status(key))?.stage).toBe("compiled")

    const resumed = await sharing({
      compile: async () => {
        throw new Error("the old compiler is no longer installed")
      },
      repository: ports.repository
    }).resume(key)

    expect(resumed.status).toBe("completed")
    if (resumed.status !== "completed") return
    expect(resumed.run.compiler).toBe(COMPILER)
    expect(counts.compile).toBe(1)
    expect(counts.commit).toBe(1)
  })

  test("the content key covers everything the release publishes and nothing a caller decides", async () => {
    const base = await submissionOf()
    const key = await releaseContentKey(base)
    expect(key).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(await releaseContentKey(await submissionOf())).toBe(key)
    const decided: ReleaseSubmission = { ...base, ownerId: "u-other", approvedPermissions: ["storage"] }
    expect(await releaseContentKey(decided)).toBe(key)

    for (const over of [
      { version: "1.0.1" },
      { slug: "alex/other-fork" },
      { source: sourceOf("changed") },
      { capabilities: capabilities({ storage: true }) },
      { parent: { ...base.parent, commit: "c".repeat(40) } },
      { summary: "a different summary" },
      { previews: await previewsOf(webpOf({ fill: 9 })) }
    ]) {
      expect(await releaseContentKey({ ...base, ...over })).not.toBe(key)
    }
  })

  for (const [stage, port] of [
    ["compiled", "compile"],
    ["committed", "commit"],
    ["verified", "read"],
    ["cataloged", "catalog"],
    ["completed", "sign"]
  ] as const) {
    test(`a failure before and after the ${stage} stage still publishes one release`, async () => {
      const { publisher, faults, counts, signed, versions } = setup()
      const submission = await submissionOf()

      faults[port] = 1
      const before = await publisher.publish(submission)
      expect(before.status).toBe("failed")
      if (before.status !== "failed") return
      expect(before.retryable).toBe(true)
      expect(before.run?.stage).toBe(RELEASE_STAGES[RELEASE_STAGES.indexOf(stage) - 1])

      faults.advance.add(stage)
      const after = await publisher.publish(submission)
      expect(after.status).toBe("failed")
      if (after.status !== "failed") return
      expect(after.retryable).toBe(true)
      expect(after.run?.stage).toBe(RELEASE_STAGES[RELEASE_STAGES.indexOf(stage) - 1])

      const done = await publisher.publish(submission)
      expect(done.status).toBe("completed")
      if (done.status !== "completed") return
      expect(done.commit).toBe(RELEASE_COMMIT)
      expect(counts).toMatchObject({ commit: 1, inserts: 1 })
      // The receipt states the time the catalog row keeps, even on a run that got there late.
      expect(done.run.catalogedAt).toBe(versions.get("alex/quiet-fork@1.0.0")!.publishedAt)

      const again = await publisher.publish(submission)
      expect(again.status).toBe("completed")
      if (again.status !== "completed") return
      expect(again.receipt).toBe(done.receipt)
      expect(again.package).toEqual(done.package)
      expect(again.commit).toBe(done.commit)
      expect(counts).toMatchObject({ commit: 1, inserts: 1 })
      // Every signature the run produced, including a re-signed one, is the same receipt.
      expect(new Set(signed)).toEqual(new Set([done.receipt]))
    })
  }
})
