/**
 * The Postgres release repository, against Postgres.
 *
 * Every rule this adapter is responsible for lives in the database rather than in the
 * TypeScript around it: one run per content key, one run per package version, a stage that
 * only moves from the stage the caller last saw, and a catalog write that either lands
 * whole or not at all. A stub that returns rows proves none of them, so these tests boot a
 * throwaway cluster, run the real migrations into it, and let two real transactions race.
 *
 * The cluster is skipped, not faked, when no Postgres binaries are on the machine.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { digestOf } from "../compiler/digest"
import { permissionDelta } from "../forks/model"
import type { RedesignManifest } from "../manifest"
import {
  capabilities,
  pageForkSubmissionOf,
  PARENT_COMMIT,
  RELEASE_COMMIT,
  RELEASE_PATH,
  rootSubmissionOf,
  setup,
  submissionOf
} from "./publishing.fake"
import { contentOf, releaseContentKey, type ReleaseContent } from "./release-content"
import { releasePublisher, type CatalogRelease, type OpenReleaseRun } from "./publishing"
import { postgresAuth } from "./auth-postgres"
import { postgresReleases } from "./release-postgres"

const BINARY_DIRECTORIES = [
  "/opt/homebrew/opt/postgresql@17/bin",
  "/opt/homebrew/opt/postgresql@16/bin",
  "/usr/local/opt/postgresql@17/bin",
  "/usr/local/opt/postgresql@16/bin",
  "/usr/lib/postgresql/17/bin",
  "/usr/lib/postgresql/16/bin",
  "/usr/bin",
  "/usr/local/bin"
]

const binaries = (): string | null =>
  BINARY_DIRECTORIES.find((directory) => existsSync(join(directory, "initdb"))) ?? null

const run = (command: string, args: ReadonlyArray<string>): void => {
  const result = Bun.spawnSync([command, ...args], { stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) {
    throw new Error(`${command} failed: ${result.stderr.toString()}${result.stdout.toString()}`)
  }
}

/** A port nobody holds, taken and released, so two test runs never pick the same one. */
const freePort = (): number => {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data: () => undefined } })
  const { port } = server
  server.stop(true)
  return port
}

const MIGRATIONS = [
  "001_initial.sql",
  "002_sandbox_runtime.sql",
  "003_publishing.sql",
  "004_compiled_output.sql",
  "005_root_releases.sql",
  "006_abandoned_runs.sql"
]

interface Cluster {
  readonly sql: Bun.SQL
  readonly stop: () => void
}

const boot = async (): Promise<Cluster | null> => {
  const bin = binaries()
  if (bin === null) return null
  const root = mkdtempSync(join(tmpdir(), "morph-release-pg-"))
  const data = join(root, "data")
  const port = freePort()
  const psql = join(bin, "psql")
  const stop = (): void => {
    Bun.spawnSync([join(bin, "pg_ctl"), "-D", data, "-m", "immediate", "stop"], { stderr: "pipe", stdout: "pipe" })
    rmSync(root, { recursive: true, force: true })
  }
  try {
    run(join(bin, "initdb"), ["-D", data, "-U", "postgres", "--auth=trust", "-E", "UTF8", "--no-sync"])
    run(join(bin, "pg_ctl"), [
      "-D", data,
      "-o", `-p ${port} -h 127.0.0.1 -k ${root} -c fsync=off -c full_page_writes=off -c synchronous_commit=off`,
      "-l", join(root, "server.log"),
      "-w", "start"
    ])
    const connect = ["-h", "127.0.0.1", "-p", String(port), "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-q"]
    run(psql, [...connect, "-c", "create database morph_release"])
    for (const migration of MIGRATIONS) {
      run(psql, [...connect, "-d", "morph_release", "-f", join(import.meta.dir, "migrations", migration)])
    }
    const sql = new Bun.SQL({ url: `postgres://postgres@127.0.0.1:${port}/morph_release`, max: 8 })
    await sql`select 1`
    return { sql, stop: () => { void sql.close(); stop() } }
  } catch (cause) {
    stop()
    throw cause
  }
}

// Top level rather than in a hook: booting a cluster takes longer than a test timeout, and
// a machine with no Postgres has to skip the suite rather than fail it.
const cluster = await boot()

const digest = (letter: string): string => `sha256:${letter.repeat(64)}`

const compiledOutput = {
  compiler: "test-compiler-1",
  script: "compiled script",
  style: "compiled style",
  sources: { "entry.ts": digest("a") },
  artifacts: { script: digest("b"), css: digest("c") }
}

const manifestOf = (version: string): RedesignManifest => ({
  schema: 1,
  slug: "alex/quiet",
  version,
  summary: "A quieter inbox",
  license: "MIT",
  author: { handle: "alex" },
  scope: { kind: "page", origin: "https://example.com", paths: ["/inbox"] },
  runtime: "sandbox-v1",
  entry: "entry.ts",
  files: { "entry.ts": digest("a") },
  compatibility: { kit: "^1.0.0", chrome: ">=120" },
  artifacts: { script: digest("b"), css: digest("c") },
  previews: { before: digest("d"), after: digest("e") },
  permissions: { page: ["read:text", "read:attributes"], network: [] },
  capabilities: capabilities()
})

interface Seed {
  readonly ownerId: string
  readonly packageId: string
  readonly versionId: string
  readonly latestVersionId: string
}

interface IdRow { readonly id: string | number | bigint }

/**
 * One user, one parent package and two of its versions: the one a fork descends from and a
 * newer one it must not follow.
 */
const seed = async (sql: Bun.SQL): Promise<Seed> => {
  await sql`
    truncate marketplace_release_runs, marketplace_versions, marketplace_packages, marketplace_users
    restart identity cascade
  `
  const [user] = await sql<IdRow[]>`
    insert into marketplace_users (github_id, handle) values (7, 'alex') returning id
  `
  const ownerId = String(user?.id)
  const [parent] = await sql<IdRow[]>`
    insert into marketplace_packages
      (owner_id, slug, name, summary, license, scope_kind, scope_origin, scope_paths,
       github_owner, github_repo, github_path)
    values
      (${ownerId}, 'alex/quiet', 'Quiet', 'A quieter inbox', 'MIT', 'page',
       'https://example.com', '{/inbox}'::text[], 'flazouh', 'morph-packages', 'packages/alex/quiet')
    returning id
  `
  const packageId = String(parent?.id)
  const version = async (name: string, commit: string): Promise<string> => {
    const [row] = await sql<IdRow[]>`
      insert into marketplace_versions
        (package_id, version, runtime, manifest, github_commit, github_path, source_digest,
         script_digest, css_digest, kit_range, kit_built_with, compiler_version, size_bytes, published_by)
      values
        (${packageId}, ${name}, 'sandbox-v1', (${JSON.stringify(manifestOf(name))}::text)::jsonb,
         ${commit}, ${`packages/alex/quiet/${name}`}, ${digest("a")}, ${digest("b")}, ${digest("c")},
         '^1.0.0', '1.0.0', 'test-compiler-1', 100, ${ownerId})
      returning id
    `
    return String(row?.id)
  }
  const versionId = await version("1.2.0", PARENT_COMMIT)
  const latestVersionId = await version("2.0.0", "3".repeat(40))
  await sql`update marketplace_packages set latest_version_id = ${latestVersionId} where id = ${packageId}`
  return { ownerId, packageId, versionId, latestVersionId }
}

const openOf = async (
  planted: Seed,
  over: Partial<{ readonly slug: string; readonly version: string; readonly body: string }> = {}
): Promise<OpenReleaseRun> => {
  const submission = await submissionOf({
    ownerId: planted.ownerId,
    ...(over.slug === undefined ? {} : { slug: over.slug }),
    ...(over.version === undefined ? {} : { version: over.version })
  })
  const content: ReleaseContent = contentOf(
    over.body === undefined ? submission : { ...submission, summary: over.body }
  )
  const permissions = permissionDelta(capabilities(), submission.capabilities)
  return {
    contentKey: await releaseContentKey(content),
    ownerId: planted.ownerId,
    content,
    permissions,
    approved: true,
    parent: {
      slug: "alex/quiet",
      version: "1.2.0",
      commit: PARENT_COMMIT,
      packageId: planted.packageId,
      versionId: planted.versionId
    }
  }
}

const catalogOf = async (planted: Seed, runId: string, over: Partial<CatalogRelease> = {}): Promise<CatalogRelease> => {
  const submission = await submissionOf({ ownerId: planted.ownerId })
  const content = contentOf(submission)
  return {
    runId,
    contentKey: await releaseContentKey(content),
    ownerId: planted.ownerId,
    slug: content.slug,
    version: content.version,
    name: content.name,
    summary: content.summary,
    license: content.license,
    scope: content.scope,
    compatibility: content.compatibility,
    runtime: "sandbox-v1",
    manifest: { ...manifestOf("1.0.0"), slug: content.slug, version: content.version },
    repository: "flazouh/morph-packages",
    commit: RELEASE_COMMIT,
    path: RELEASE_PATH,
    digests: { source: digest("a"), script: digest("b"), css: digest("c") },
    compiler: "test-compiler-1",
    builtWith: "1.0.0",
    sizeBytes: 4096,
    forkedFrom: { packageId: planted.packageId, versionId: planted.versionId },
    permissions: { added: [], removed: [] },
    publishedAt: "2026-09-09T22:00:05.000Z",
    ...over
  }
}

describe.skipIf(cluster === null)("postgres release runs", () => {
  const sql = cluster?.sql as Bun.SQL
  const repository = postgresReleases(sql)
  let planted: Seed

  afterAll(() => cluster?.stop())
  beforeEach(async () => {
    planted = await seed(sql)
  })

  test("auth scopes cross the Bun SQL boundary as Postgres text arrays", async () => {
    const repository = postgresAuth(sql)
    const createdAt = new Date("2026-09-09T20:00:00.000Z")
    const expiresAt = new Date("2026-09-09T21:00:00.000Z")
    expect(await repository.createDevice({
      id: "ignored",
      deviceCodeHash: "a".repeat(64),
      userCodeHash: "b".repeat(64),
      requestedScopes: ["publish"],
      createdAt,
      expiresAt,
      userId: null,
      approvedAt: null,
      deniedAt: null,
      consumedAt: null,
      lastPolledAt: null
    })).toBe("created")
    const device = await repository.findDeviceByDeviceCodeHash("a".repeat(64))
    expect(device?.requestedScopes).toEqual(["publish"])
    expect(await repository.approveDevice(device!.id, planted.ownerId, createdAt)).toBe("approved")
    expect(await repository.consumeDeviceAndCreateToken(device!.id, {
      id: "ignored",
      userId: planted.ownerId,
      tokenHash: "c".repeat(64),
      scopes: ["publish"],
      createdAt,
      expiresAt,
      revokedAt: null
    }, createdAt)).toBe("created")
    expect((await repository.findTokenByHash("c".repeat(64)))?.scopes).toEqual(["publish"])
  })

  test("one content key opens one run, and reopening it never rewinds the stage", async () => {
    const input = await openOf(planted)
    const first = await repository.open(input)
    expect(first.kind).toBe("run")
    if (first.kind !== "run") return
    expect(first.run.stage).toBe("accepted")
    expect(first.run.parent).toEqual(input.parent)
    expect(first.run.content).toEqual(input.content)

    await repository.advance({
      id: first.run.id,
      from: "accepted",
      to: "compiled",
      patch: { compiler: "test-compiler-1", compiled: compiledOutput }
    })

    const again = await repository.open(input)
    expect(again.kind).toBe("run")
    if (again.kind !== "run") return
    expect(again.run.id).toBe(first.run.id)
    expect(again.run.stage).toBe("compiled")
    expect(again.run.compiler).toBe("test-compiler-1")

    const rows = await sql<Array<{ readonly id: string }>>`select id from marketplace_release_runs`
    expect(rows).toHaveLength(1)
  })

  test("two opens of one content key at once resume one run", async () => {
    const input = await openOf(planted)
    const [left, right] = await Promise.all([repository.open(input), repository.open(input)])

    expect(left.kind).toBe("run")
    expect(right.kind).toBe("run")
    if (left.kind !== "run" || right.kind !== "run") return
    expect(left.run.id).toBe(right.run.id)

    const rows = await sql<Array<{ readonly id: string }>>`select id from marketplace_release_runs`
    expect(rows).toHaveLength(1)
  })

  test("other content for a package version already opened is refused", async () => {
    const first = await openOf(planted)
    const other = await openOf(planted, { body: "a different summary, and so different content" })
    expect(other.contentKey).not.toBe(first.contentKey)

    await repository.open(first)
    const refused = await repository.open(other)

    expect(refused).toEqual({ kind: "version_taken", contentKey: first.contentKey })
    const rows = await sql<Array<{ readonly id: string }>>`select id from marketplace_release_runs`
    expect(rows).toHaveLength(1)
  })

  test("a stage only advances from the stage the caller last saw", async () => {
    const opened = await repository.open(await openOf(planted))
    if (opened.kind !== "run") throw new Error("the run was not opened")
    const { id } = opened.run

    const compiled = await repository.advance({
      id,
      from: "accepted",
      to: "compiled",
      patch: { compiler: "test-compiler-1", compiled: compiledOutput }
    })
    expect(compiled.stage).toBe("compiled")
    expect(compiled.compiled).toEqual(compiledOutput)

    await expect(
      repository.advance({ id, from: "accepted", to: "compiled", patch: {} })
    ).rejects.toThrow(/compiled/)

    const committed = {
      commit: RELEASE_COMMIT,
      path: RELEASE_PATH,
      files: { "manifest.json": digest("f") },
      bytes: 2048
    }
    const races = await Promise.allSettled([
      repository.advance({ id, from: "compiled", to: "committed", patch: committed }),
      repository.advance({ id, from: "compiled", to: "committed", patch: committed })
    ])
    expect(races.filter((race) => race.status === "fulfilled")).toHaveLength(1)
    expect(races.filter((race) => race.status === "rejected")).toHaveLength(1)

    const stored = await repository.load(opened.run.contentKey)
    expect(stored?.stage).toBe("committed")
    expect(stored?.commit).toBe(RELEASE_COMMIT)
    expect(stored?.path).toBe(RELEASE_PATH)
    expect(stored?.bytes).toBe(2048)
    expect(stored?.files).toEqual({ "manifest.json": digest("f") })
  })

  test("a failure is stored on the run, and the next advance clears it", async () => {
    const opened = await repository.open(await openOf(planted))
    if (opened.kind !== "run") throw new Error("the run was not opened")

    const failed = await repository.fail({
      id: opened.run.id,
      stage: "accepted",
      code: "compile_failed",
      retryable: true
    })
    expect(failed.error).toEqual({
      stage: "accepted",
      code: "compile_failed",
      retryable: true
    })
    expect(failed.stage).toBe("accepted")
    expect((await repository.load(opened.run.contentKey))?.error).toEqual({
      stage: "accepted",
      code: "compile_failed",
      retryable: true
    })

    const fatal = await repository.fail({
      id: opened.run.id,
      stage: "accepted",
      code: "artifact_mismatch",
      retryable: false
    })
    expect(fatal.error).toEqual({
      stage: "accepted",
      code: "artifact_mismatch",
      retryable: false
    })

    const carried = await repository.advance({
      id: opened.run.id,
      from: "accepted",
      to: "compiled",
      patch: { compiler: "test-compiler-1", compiled: compiledOutput }
    })
    expect(carried.error).toBeNull()
  })

  test("a stale failure writer adopts the advanced run without adding its error", async () => {
    const opened = await repository.open(await openOf(planted))
    if (opened.kind !== "run") throw new Error("the run was not opened")

    const compiled = await repository.advance({
      id: opened.run.id,
      from: "accepted",
      to: "compiled",
      patch: { compiler: "test-compiler-1", compiled: compiledOutput }
    })
    const adopted = await repository.fail({
      id: opened.run.id,
      stage: "accepted",
      code: "compile_failed",
      retryable: true
    })

    expect(adopted).toEqual(compiled)
    expect((await repository.load(opened.run.contentKey))?.error).toBeNull()
  })

  test("the parent lookup names the exact version, with the package's newest one beside it", async () => {
    const parent = await repository.parentVersion({ slug: "alex/quiet", version: "1.2.0" })

    expect(parent).toEqual({
      packageId: planted.packageId,
      versionId: planted.versionId,
      commit: PARENT_COMMIT,
      latestVersion: "2.0.0",
      capabilities: capabilities()
    })
    expect(parent?.versionId).not.toBe(planted.latestVersionId)
    expect(await repository.parentVersion({ slug: "alex/quiet", version: "9.9.9" })).toBeNull()
    expect(await repository.parentVersion({ slug: "alex/nothing", version: "1.2.0" })).toBeNull()
  })

  test("one catalog write creates the fork package and its version, and leaves the parent alone", async () => {
    const opened = await repository.open(await openOf(planted))
    if (opened.kind !== "run") throw new Error("the run was not opened")
    const [before] = await sql`select * from marketplace_packages where slug = 'alex/quiet'`

    const written = await repository.catalog(await catalogOf(planted, opened.run.id))

    expect(written.publishedAt).toBe("2026-09-09T22:00:05.000Z")
    expect(written.packageId).not.toBe(planted.packageId)

    const [after] = await sql`select * from marketplace_packages where slug = 'alex/quiet'`
    expect(after).toEqual(before)

    const [fork] = await sql<Array<Record<string, unknown>>>`
      select * from marketplace_packages where slug = 'alex/quiet-fork'
    `
    expect(String(fork?.id)).toBe(written.packageId)
    expect(String(fork?.forked_from_package_id)).toBe(planted.packageId)
    expect(String(fork?.forked_from_version_id)).toBe(planted.versionId)
    expect(String(fork?.latest_version_id)).toBe(written.versionId)
    expect(fork?.github_owner).toBe("flazouh")
    expect(fork?.github_repo).toBe("morph-packages")

    const versions = await sql<Array<{ readonly version: string; readonly runtime: string }>>`
      select version, runtime from marketplace_versions where package_id = ${written.packageId}
    `
    expect(versions).toEqual([{ version: "1.0.0", runtime: "sandbox-v1" }])
  })

  test("a second catalog write returns the first rows and the first publication time", async () => {
    const opened = await repository.open(await openOf(planted))
    if (opened.kind !== "run") throw new Error("the run was not opened")
    const input = await catalogOf(planted, opened.run.id)

    const first = await repository.catalog(input)
    const second = await repository.catalog({ ...input, publishedAt: "2026-09-09T23:30:00.000Z" })

    expect(second).toEqual(first)
    const rows = await sql<Array<{ readonly id: string }>>`
      select id from marketplace_versions where package_id = ${first.packageId}
    `
    expect(rows).toHaveLength(1)
  })

  test("a later version cannot reuse a package name for another fork lineage", async () => {
    const opened = await repository.open(await openOf(planted))
    if (opened.kind !== "run") throw new Error("the run was not opened")
    await repository.catalog(await catalogOf(planted, opened.run.id))

    await expect(repository.catalog(await catalogOf(planted, opened.run.id, {
      version: "1.1.0",
      path: "packages/alex/quiet-fork/1.1.0",
      manifest: {
        ...manifestOf("1.1.0"),
        slug: "alex/quiet-fork",
        version: "1.1.0"
      },
      forkedFrom: {
        packageId: planted.packageId,
        versionId: planted.latestVersionId
      }
    }))).rejects.toThrow("another fork lineage")
  })

  test("a later release updates its fork package without changing its lineage", async () => {
    const opened = await repository.open(await openOf(planted))
    if (opened.kind !== "run") throw new Error("the run was not opened")
    const first = await repository.catalog(await catalogOf(planted, opened.run.id))
    const second = await repository.catalog(await catalogOf(planted, opened.run.id, {
      version: "1.1.0",
      name: "Quiet Fork Two",
      path: "packages/alex/quiet-fork/1.1.0",
      manifest: {
        ...manifestOf("1.1.0"),
        slug: "alex/quiet-fork",
        version: "1.1.0"
      }
    }))

    const [fork] = await sql<Array<Record<string, unknown>>>`
      select name, latest_version_id, forked_from_package_id, forked_from_version_id
      from marketplace_packages where id = ${first.packageId}
    `
    expect(fork?.name).toBe("Quiet Fork Two")
    expect(String(fork?.latest_version_id)).toBe(second.versionId)
    expect(String(fork?.forked_from_package_id)).toBe(planted.packageId)
    expect(String(fork?.forked_from_version_id)).toBe(planted.versionId)
  })

  test("a root release opens without a parent, reads back as one, and catalogs a package with no lineage", async () => {
    const submission = await rootSubmissionOf({ ownerId: planted.ownerId })
    const content = contentOf(submission)
    const opened = await repository.open({
      contentKey: await releaseContentKey(content),
      ownerId: planted.ownerId,
      content,
      permissions: { added: [], removed: [] },
      approved: true,
      parent: null
    })
    expect(opened.kind).toBe("run")
    if (opened.kind !== "run") return
    expect(opened.run.parent).toBeNull()
    expect(opened.run.content).toEqual(content)
    expect(opened.run.content.runtime).toBe("script-v1")

    const [row] = await sql<Array<Record<string, unknown>>>`
      select parent_package_id, parent_version_id, parent_commit from marketplace_release_runs where id = ${opened.run.id}
    `
    expect(row).toEqual({ parent_package_id: null, parent_version_id: null, parent_commit: null })

    // The three parent columns are one fact: a row with only one of them set is refused by the schema.
    const onlyCommit = async (): Promise<void> => {
      await sql`update marketplace_release_runs set parent_commit = ${PARENT_COMMIT} where id = ${opened.run.id}`
    }
    await expect(onlyCommit()).rejects.toThrow("marketplace_release_runs_parent_check")

    const written = await repository.catalog(await catalogOf(planted, opened.run.id, {
      slug: "alex/quiet-page",
      name: "Quiet Page",
      runtime: "script-v1",
      path: "packages/alex/quiet-page/1.0.0",
      manifest: { ...manifestOf("1.0.0"), slug: "alex/quiet-page", runtime: "script-v1", entry: "page.js", capabilities: undefined },
      forkedFrom: null
    }))
    const [root] = await sql<Array<Record<string, unknown>>>`
      select forked_from_package_id, forked_from_version_id, latest_version_id from marketplace_packages where id = ${written.packageId}
    `
    expect(root?.forked_from_package_id).toBeNull()
    expect(root?.forked_from_version_id).toBeNull()
    expect(String(root?.latest_version_id)).toBe(written.versionId)
    const [version] = await sql<Array<Record<string, unknown>>>`
      select runtime from marketplace_versions where id = ${written.versionId}
    `
    expect(version?.runtime).toBe("script-v1")

    // A later release of the root stays a root; a fork lineage cannot take its name.
    await expect(repository.catalog(await catalogOf(planted, opened.run.id, {
      slug: "alex/quiet-page",
      version: "1.1.0",
      runtime: "script-v1",
      path: "packages/alex/quiet-page/1.1.0",
      manifest: { ...manifestOf("1.1.0"), slug: "alex/quiet-page", runtime: "script-v1", entry: "page.js", capabilities: undefined }
    }))).rejects.toThrow("another fork lineage")
  })

  test("a catalog write leaves no package behind when its version cannot land", async () => {
    const opened = await repository.open(await openOf(planted))
    if (opened.kind !== "run") throw new Error("the run was not opened")
    const input = await catalogOf(planted, opened.run.id, { digests: { source: "not-a-digest", script: digest("b"), css: digest("c") } })

    await expect(repository.catalog(input)).rejects.toThrow()

    const rows = await sql<Array<{ readonly slug: string }>>`
      select slug from marketplace_packages where slug = 'alex/quiet-fork'
    `
    expect(rows).toHaveLength(0)
  })

  test("a legacy compiled run without stored build bytes is refused before commit", async () => {
    const input = await openOf(planted)
    const opened = await repository.open(input)
    if (opened.kind !== "run") throw new Error("the run was not opened")
    await sql`
      update marketplace_release_runs
      set state = 'compiled',
          compiler_version = 'legacy-compiler',
          compiled_artifacts = ${JSON.stringify(compiledOutput.artifacts)}::jsonb,
          compiled_output = null
      where id = ${opened.run.id}
    `

    await expect(repository.load(input.contentKey)).rejects.toThrow(
      /compiled_output/
    )
  })

  test("a page release that forks another is stored and read back with its parent", async () => {
    const submission = await pageForkSubmissionOf({ ownerId: planted.ownerId })
    const content = contentOf(submission)
    const contentKey = await releaseContentKey(content)
    const opened = await repository.open({
      contentKey,
      ownerId: planted.ownerId,
      content,
      permissions: { added: [], removed: [] },
      approved: true,
      parent: {
        slug: submission.parent?.slug ?? "",
        version: submission.parent?.version ?? "",
        commit: submission.parent?.commit ?? "",
        packageId: planted.packageId,
        versionId: planted.versionId
      }
    })
    expect(opened.kind).toBe("run")

    const read = await repository.load(contentKey)
    expect(read?.content.runtime).toBe("script-v1")
    expect(read?.content.parent).toEqual(submission.parent)
    expect(read?.content.capabilities).toBeUndefined()
    expect(read?.parent).toMatchObject({ packageId: planted.packageId, versionId: planted.versionId })
  })

  test("a version a run stopped holding is free again, and a published one never is", async () => {
    const first = await openOf(planted, { version: "2.0.0" })
    expect((await repository.open(first)).kind).toBe("run")

    // Fresh previews mean fresh content, so a second attempt is never the same run.
    const second = await openOf(planted, { version: "2.0.0", body: "a second attempt" })
    expect(await repository.open(second)).toMatchObject({ kind: "version_taken", contentKey: first.contentKey })

    await sql`
      update marketplace_release_runs
      set updated_at = now() - interval '2 hours'
      where content_key = ${first.contentKey}
    `
    expect((await repository.open(second)).kind).toBe("run")
    const [released] = await sql<Array<{ readonly superseded_at: Date | null }>>`
      select superseded_at from marketplace_release_runs where content_key = ${first.contentKey}
    `
    expect(released?.superseded_at).not.toBeNull()

    // The run that took the version over holds it while it is moving.
    const third = await openOf(planted, { version: "2.0.0", body: "a third attempt" })
    expect(await repository.open(third)).toMatchObject({ kind: "version_taken", contentKey: second.contentKey })
  })

  test("a run that failed for good gives its version up at once", async () => {
    const first = await openOf(planted, { version: "3.0.0" })
    const opened = await repository.open(first)
    expect(opened.kind).toBe("run")
    if (opened.kind !== "run") return
    await repository.fail({ id: opened.run.id, stage: "accepted", code: "artifact_mismatch", retryable: false })

    const second = await openOf(planted, { version: "3.0.0", body: "after the refusal" })
    expect((await repository.open(second)).kind).toBe("run")
  })

  test("a corrupt stored run is refused rather than loaded", async () => {
    const input = await openOf(planted)
    await repository.open(input)

    await sql`
      update marketplace_release_runs
      set submission = jsonb_set(submission, '{capabilities,storage}', '"yes"'::jsonb)
      where content_key = ${input.contentKey}
    `
    await expect(repository.load(input.contentKey)).rejects.toThrow(/submission/)

    await sql`
      update marketplace_release_runs
      set submission = jsonb_set(
        jsonb_set(submission, '{capabilities,storage}', 'false'::jsonb),
        '{version}', '"9.9.9"'::jsonb
      )
      where content_key = ${input.contentKey}
    `
    await expect(repository.load(input.contentKey)).rejects.toThrow(/package version/)

    expect(await repository.load(`sha256:${"0".repeat(64)}`)).toBeNull()
  })

  test("a release publishes end to end through a stored run", async () => {
    const { ports, counts } = setup()
    const publisher = releasePublisher({ ...ports, repository })
    const submission = await submissionOf({ ownerId: planted.ownerId })

    const result = await publisher.publish(submission)

    expect(result.status).toBe("completed")
    if (result.status !== "completed") return
    expect(result.slug).toBe("alex/quiet-fork")
    expect(result.commit).toBe(RELEASE_COMMIT)
    expect(result.run.stage).toBe("completed")
    expect(result.run.error).toBeNull()
    expect(result.run.receipt).not.toBeNull()
    // The catalog counter belongs to the in-memory repository this test replaced, so the
    // catalog is counted in Postgres instead, one row at a time.
    expect(counts).toMatchObject({ compile: 1, commit: 1, sign: 1 })

    const stored = await repository.load(result.run.contentKey)
    expect(stored?.stage).toBe("completed")
    expect(stored?.catalog).toEqual(result.package)
    expect(stored?.catalogedAt).toBe(result.run.catalogedAt)
    expect(stored?.receipt).toBe(result.receipt)
    expect(await digestOf(stored?.content.source.files["entry.ts"] ?? "")).toBe(
      submission.sources["entry.ts"] ?? ""
    )

    // The whole point of the run: publishing again reads the same release back rather than
    // committing a second one.
    const again = await publisher.publish(submission)
    expect(again.status).toBe("completed")
    expect(counts).toMatchObject({ compile: 1, commit: 1, sign: 1 })

    const rows = await sql<Array<{ readonly slug: string; readonly version: string }>>`
      select packages.slug, versions.version
      from marketplace_versions versions
      join marketplace_packages packages on packages.id = versions.package_id
      order by versions.id
    `
    expect(rows).toEqual([
      { slug: "alex/quiet", version: "1.2.0" },
      { slug: "alex/quiet", version: "2.0.0" },
      { slug: "alex/quiet-fork", version: "1.0.0" }
    ])

    const [parent] = await sql<Array<{ readonly latest_version_id: string }>>`
      select latest_version_id from marketplace_packages where slug = 'alex/quiet'
    `
    expect(String(parent?.latest_version_id)).toBe(planted.latestVersionId)
  })
})
