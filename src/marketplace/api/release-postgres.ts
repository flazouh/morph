/**
 * The release repository, in Postgres.
 *
 * Publishing is a stored run rather than a call, so this adapter is where the run's rules
 * stop being promises and become constraints. Every one of them is the database's to keep:
 * `content_key` is unique, so one content opens one run; `(package_slug, package_version)`
 * is unique, so other content cannot take a published version; a stage advance is an
 * `update ... where state = <the stage the caller last saw>`, so two workers on one run
 * cannot both catalog it; and the catalog write is one transaction, so a package row never
 * outlives the version it was created for.
 *
 * That leaves this file two jobs. It writes those statements, and it refuses to hand back a
 * row it cannot read. A run is resumed from stored content alone, so a submission that no
 * longer parses, or that names another package version than the columns beside it, is a
 * release nobody should carry forward: it is reported rather than repaired.
 */
import type { CompiledPackage } from "../compiler/compile"
import type { PermissionDelta } from "../forks/model"
import { parseManifest, parseSandboxCapabilities, type SandboxCapabilities } from "../manifest"
import {
  RELEASE_STAGES,
  type OpenReleaseResult,
  type OpenReleaseRun,
  type ReleaseContent,
  type ReleaseLineage,
  type ReleaseRepository,
  type ReleaseRun,
  type ReleaseStage
} from "./publishing"
import type { ParentRelease, ReleaseKind } from "./release-content"

/** A stored row this server will not act on, named by the column that made it unreadable. */
export class ReleaseRowError extends Error {
  readonly _tag = "ReleaseRowError"
  readonly column: string
  constructor(column: string, message: string) {
    super(`marketplace_release_runs.${column} ${message}`)
    this.name = "ReleaseRowError"
    this.column = column
  }
}

const refuse = (column: string, message: string): ReleaseRowError => new ReleaseRowError(column, message)

interface RunRow {
  readonly id: string | number | bigint
  readonly owner_id: string | number | bigint
  readonly content_key: string
  readonly package_slug: string
  readonly package_version: string
  readonly parent_package_id: string | number | bigint | null
  readonly parent_version_id: string | number | bigint | null
  readonly parent_commit: string | null
  readonly state: string
  readonly submission: unknown
  readonly compiled_artifacts: unknown
  readonly compiled_output: unknown
  readonly release_files: unknown
  readonly permission_delta: unknown
  readonly permission_widening_approved: boolean
  readonly compiler_version: string | null
  readonly size_bytes: string | number | bigint | null
  readonly github_commit: string | null
  readonly github_path: string | null
  readonly catalog_package_id: string | number | bigint | null
  readonly catalog_version_id: string | number | bigint | null
  readonly cataloged_at: Date | string | null
  readonly release_receipt: string | null
  readonly error_stage: string | null
  readonly last_error_code: string | null
  readonly last_error_retryable: boolean | null
  readonly created_at: Date | string
  readonly updated_at: Date | string
  readonly completed_at: Date | string | null
}

const iso = (value: Date | string): string => (value instanceof Date ? value : new Date(value)).toISOString()
const isoOrNull = (value: Date | string | null): string | null => (value === null ? null : iso(value))

/** A jsonb column as the driver hands it back: decoded already, or still the text of it. */
const jsonOf = (value: unknown, column: string): unknown => {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    throw refuse(column, "does not hold JSON")
  }
}

const objectOf = (value: unknown, column: string, at: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw refuse(column, `has no ${at} object`)
  }
  return value as Record<string, unknown>
}

const textOf = (value: unknown, column: string, at: string): string => {
  if (typeof value !== "string" || value === "") throw refuse(column, `has no ${at} text`)
  return value
}

const textsOf = (value: unknown, column: string, at: string): ReadonlyArray<string> => {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw refuse(column, `has no ${at} array of text`)
  }
  return value as ReadonlyArray<string>
}

/** A path-keyed table of text, which is both a source tree and a table of digests. */
const tableOf = (value: unknown, column: string, at: string): Readonly<Record<string, string>> => {
  const table = objectOf(value, column, at)
  for (const [key, item] of Object.entries(table)) {
    if (typeof item !== "string") throw refuse(column, `has no text at ${at}.${key}`)
  }
  return table as Readonly<Record<string, string>>
}

const artifactsOf = (value: unknown, column: string, at: string): { readonly script: string; readonly css: string } => {
  const artifacts = objectOf(value, column, at)
  return {
    script: textOf(artifacts.script, column, `${at}.script`),
    css: textOf(artifacts.css, column, `${at}.css`)
  }
}

const compiledOf = (value: unknown, column: string): CompiledPackage => {
  const compiled = objectOf(value, column, "compiled output")
  return {
    compiler: textOf(compiled.compiler, column, "compiler"),
    script: textOf(compiled.script, column, "script"),
    style: textOf(compiled.style, column, "style"),
    sources: tableOf(compiled.sources, column, "sources"),
    artifacts: artifactsOf(compiled.artifacts, column, "artifacts")
  }
}

const legacyCompiledOf = (
  value: unknown,
  content: ReleaseContent,
  compiler: string | null
): CompiledPackage => {
  if (compiler === null) {
    throw refuse("compiler_version", "is missing for legacy compiled artifacts")
  }
  return {
    compiler,
    script: "",
    style: "",
    sources: content.sources,
    artifacts: artifactsOf(
      jsonOf(value, "compiled_artifacts"),
      "compiled_artifacts",
      "artifacts"
    )
  }
}

const previewOf = (value: unknown, column: string, at: string): { readonly data: string; readonly digest: string } => {
  const preview = objectOf(value, column, at)
  return {
    data: textOf(preview.data, column, `${at}.data`),
    digest: textOf(preview.digest, column, `${at}.digest`)
  }
}

const capabilitiesOf = (value: unknown, column: string): SandboxCapabilities => {
  try {
    return parseSandboxCapabilities(value)
  } catch (cause) {
    throw refuse(column, `has no readable capabilities: ${cause instanceof Error ? cause.message : "unknown"}`)
  }
}

/**
 * The runtime-bound half of a stored submission. A row written before releases had a
 * runtime is a sandbox fork, the only kind there was.
 */
const namedParentOf = (value: unknown, column: string): ParentRelease => {
  const parent = objectOf(value, column, "parent")
  return {
    slug: textOf(parent.slug, column, "parent.slug"),
    version: textOf(parent.version, column, "parent.version"),
    commit: textOf(parent.commit, column, "parent.commit")
  }
}

const kindOfRow = (stored: Record<string, unknown>, column: string): ReleaseKind => {
  const runtime = stored.runtime ?? "sandbox-v1"
  if (runtime === "script-v1") {
    // A page package is a root unless it forked one, and it names no capabilities either way.
    if (stored.parent === undefined || stored.parent === null) return { runtime }
    return { runtime, parent: namedParentOf(stored.parent, column) }
  }
  if (runtime !== "sandbox-v1") throw refuse(column, `holds the unknown runtime ${JSON.stringify(runtime)}`)
  return {
    runtime,
    capabilities: capabilitiesOf(stored.capabilities, column),
    parent: namedParentOf(stored.parent, column)
  }
}

/**
 * The content a resume republishes, read back field by field. Strict on purpose: the run
 * is the only record of what a half-published release was, so a row that decodes into
 * something else is refused rather than carried into a commit.
 */
const contentOfRow = (row: RunRow): ReleaseContent => {
  const column = "submission"
  const stored = objectOf(jsonOf(row.submission, column), column, "submission")
  const scope = objectOf(stored.scope, column, "scope")
  if (scope.kind !== "page" && scope.kind !== "site") throw refuse(column, "has no page or site scope.kind")
  const source = objectOf(stored.source, column, "source")
  const previews = objectOf(stored.previews, column, "previews")
  const compatibility = objectOf(stored.compatibility, column, "compatibility")
  const content: ReleaseContent = {
    ...kindOfRow(stored, column),
    slug: textOf(stored.slug, column, "slug"),
    version: textOf(stored.version, column, "version"),
    name: textOf(stored.name, column, "name"),
    summary: textOf(stored.summary, column, "summary"),
    license: textOf(stored.license, column, "license"),
    scope: {
      kind: scope.kind,
      origin: textOf(scope.origin, column, "scope.origin"),
      paths: textsOf(scope.paths, column, "scope.paths")
    },
    source: {
      entry: textOf(source.entry, column, "source.entry"),
      style: textOf(source.style, column, "source.style"),
      files: tableOf(source.files, column, "source.files")
    },
    sources: tableOf(stored.sources, column, "sources"),
    artifacts: artifactsOf(stored.artifacts, column, "artifacts"),
    compatibility: {
      kit: textOf(compatibility.kit, column, "compatibility.kit"),
      chrome: textOf(compatibility.chrome, column, "compatibility.chrome")
    },
    previews: {
      before: previewOf(previews.before, column, "previews.before"),
      after: previewOf(previews.after, column, "previews.after")
    }
  }
  // The indexed columns and the stored content are two records of one release. A row where
  // they disagree is one the unique indexes are no longer guarding.
  if (content.slug !== row.package_slug || content.version !== row.package_version) {
    throw refuse(column, `names ${content.slug}@${content.version} rather than its own package version`)
  }
  if ((content.parent?.commit ?? null) !== row.parent_commit) {
    throw refuse(column, "names another parent commit than its own row")
  }
  return content
}

/** The parent columns and the stored parent, which are one fact: both there, or neither. */
const parentOfRow = (row: RunRow, content: ReleaseContent): ReleaseLineage | null => {
  const ids = pairOf(row.parent_package_id, row.parent_version_id, "parent_package_id", (packageId, versionId) => ({
    packageId: String(packageId),
    versionId: String(versionId)
  }))
  if (content.parent === undefined) {
    if (ids !== null || row.parent_commit !== null) throw refuse("parent_package_id", "is set for a root package")
    return null
  }
  if (ids === null || row.parent_commit === null) throw refuse("parent_package_id", "is missing for a fork")
  return { slug: content.parent.slug, version: content.parent.version, commit: row.parent_commit, ...ids }
}

const permissionsOfRow = (row: RunRow): PermissionDelta => {
  const column = "permission_delta"
  const stored = objectOf(jsonOf(row.permission_delta, column), column, "delta")
  return {
    added: textsOf(stored.added, column, "added"),
    removed: textsOf(stored.removed, column, "removed")
  }
}

const stageOf = (value: string, column: string): ReleaseStage => {
  const stage = RELEASE_STAGES.find((known) => known === value)
  if (stage === undefined) throw refuse(column, `holds the unknown stage ${JSON.stringify(value)}`)
  return stage
}

/** Two columns that are one fact: both set, or neither, and never one of them. */
const pairOf = <V, T>(
  left: V | null,
  right: V | null,
  column: string,
  both: (left: V, right: V) => T
): T | null => {
  if (left === null && right === null) return null
  if (left === null || right === null) throw refuse(column, "is set without the column it pairs with")
  return both(left, right)
}

const runOf = (row: RunRow): ReleaseRun => {
  const content = contentOfRow(row)
  const stage = stageOf(row.state, "state")
  if (stage === "compiled" && row.compiled_output === null) {
    throw refuse(
      "compiled_output",
      "is missing for a run that has not committed yet"
    )
  }
  const error =
    row.error_stage === null &&
    row.last_error_code === null &&
    row.last_error_retryable === null
      ? null
      : row.error_stage !== null &&
          row.last_error_code !== null &&
          typeof row.last_error_retryable === "boolean"
        ? {
            stage: stageOf(row.error_stage, "error_stage"),
            code: row.last_error_code,
            retryable: row.last_error_retryable
          }
        : (() => {
            throw refuse("error_stage", "is set without its complete error record")
          })()
  return {
    id: String(row.id),
    contentKey: row.content_key,
    ownerId: String(row.owner_id),
    content,
    permissions: permissionsOfRow(row),
    approved: row.permission_widening_approved,
    parent: parentOfRow(row, content),
    stage,
    compiler: row.compiler_version,
    compiled:
      row.compiled_output === null
        ? row.compiled_artifacts === null
          ? null
          : legacyCompiledOf(
              row.compiled_artifacts,
              content,
              row.compiler_version
            )
        : compiledOf(jsonOf(row.compiled_output, "compiled_output"), "compiled_output"),
    files: row.release_files === null ? null : tableOf(jsonOf(row.release_files, "release_files"), "release_files", "files"),
    bytes: row.size_bytes === null ? null : Number(row.size_bytes),
    commit: row.github_commit,
    path: row.github_path,
    catalog: pairOf(row.catalog_package_id, row.catalog_version_id, "catalog_package_id", (id, version) => ({
      packageId: String(id),
      versionId: String(version)
    })),
    catalogedAt: isoOrNull(row.cataloged_at),
    receipt: row.release_receipt,
    error,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    completedAt: isoOrNull(row.completed_at)
  }
}

/** The permissions a fork's delta is measured against when its parent declares none. */

interface ParentRow {
  readonly package_id: string | number | bigint
  readonly version_id: string | number | bigint
  readonly github_commit: string
  readonly manifest: unknown
  readonly latest_version: string | null
}

interface IdRow { readonly id: string | number | bigint }

interface VersionRow extends IdRow { readonly published_at: Date | string }

interface PackageRow extends IdRow {
  readonly owner_id: string | number | bigint
  readonly forked_from_package_id: string | number | bigint | null
  readonly forked_from_version_id: string | number | bigint | null
}

/** `owner/repo`, as the catalog stores the two halves separately. */
const repositoryOf = (value: string): { readonly owner: string; readonly repo: string } => {
  const [owner, repo, ...rest] = value.split("/")
  if (owner === undefined || repo === undefined || owner === "" || repo === "" || rest.length > 0) {
    throw new Error(`the release repository ${JSON.stringify(value)} is not owner/repo`)
  }
  return { owner, repo }
}

export const postgresReleases = (sql: typeof Bun.sql): ReleaseRepository => {
  const byContentKey = async (contentKey: string): Promise<ReleaseRun | null> => {
    const [row] = await sql<RunRow[]>`
      select * from marketplace_release_runs where content_key = ${contentKey} limit 1
    `
    return row === undefined ? null : runOf(row)
  }

  /**
   * Which unique index the insert met. A row under this content key is this release, at
   * whatever stage it reached; a row under this package version is a different release
   * holding the name, and the caller is told whose content took it.
   */
  const conflicted = async (input: OpenReleaseRun): Promise<OpenReleaseResult> => {
    const stored = await byContentKey(input.contentKey)
    if (stored !== null) return { kind: "run", run: stored }
    const [taken] = await sql<Array<{ readonly content_key: string }>>`
      select content_key from marketplace_release_runs
      where package_slug = ${input.content.slug} and package_version = ${input.content.version}
        and superseded_at is null
      limit 1
    `
    // Neither index holds a row this transaction can see, so another one is opening this
    // package version right now. That is a retry rather than a refusal.
    if (taken === undefined) {
      throw new Error(`the release run for ${input.contentKey} is being opened by another request`)
    }
    return { kind: "version_taken", contentKey: taken.content_key }
  }

  /**
   * How long a run may hold its package version without moving. A publish waits on a
   * reader: a sign-in, a permission confirmation, a slow commit. Thirty minutes is longer
   * than any of those and short enough that an abandoned attempt does not take a version
   * with it. A completed run is never released, because that version is published.
   */
  const ABANDONED_AFTER = "30 minutes"

  /**
   * The claim on this package version, released when the run holding it has been given up
   * on: one that failed for good, or one that has not moved in a long time. The row stays
   * as the record of what was tried; it just stops holding the name.
   */
  const releaseAbandonedClaim = async (
    transaction: Bun.SQL,
    input: OpenReleaseRun
  ): Promise<void> => {
    await transaction`
      update marketplace_release_runs
      set superseded_at = now(), updated_at = now()
      where package_slug = ${input.content.slug}
        and package_version = ${input.content.version}
        and content_key <> ${input.contentKey}
        and superseded_at is null
        and state <> 'completed'
        and (last_error_retryable is false or updated_at < now() - ${ABANDONED_AFTER}::interval)
    `
  }

  const open: ReleaseRepository["open"] = async (input) =>
    sql.begin(async (transaction) => {
      await releaseAbandonedClaim(transaction, input)
      const rows = await transaction<RunRow[]>`
      insert into marketplace_release_runs
        (owner_id, content_key, package_slug, package_version, parent_package_id,
         parent_version_id, parent_commit, submission, permission_delta, permission_widening_approved)
      values
        (${input.ownerId}, ${input.contentKey}, ${input.content.slug}, ${input.content.version},
         ${input.parent?.packageId ?? null}, ${input.parent?.versionId ?? null}, ${input.parent?.commit ?? null},
         (${JSON.stringify(input.content)}::text)::jsonb,
         (${JSON.stringify(input.permissions)}::text)::jsonb,
         ${input.approved})
      on conflict do nothing
      returning *
    `
      const row = rows[0]
      return row === undefined ? conflicted(input) : { kind: "run", run: runOf(row) }
    }) as Promise<OpenReleaseResult>

  /**
   * One statement, so the read of the stage and the write of the next one cannot be pulled
   * apart. The patch travels as one jsonb value and every column takes itself from it only
   * when the key is present, which is what makes `to === from` a patch rather than a reset.
   */
  const advance: ReleaseRepository["advance"] = async ({ id, from, to, patch }) => {
    const rows = await sql<RunRow[]>`
      with input as (select (${JSON.stringify(patch)}::text)::jsonb as patch)
      update marketplace_release_runs as run
      set
        state = ${to},
        permission_widening_approved = case when jsonb_exists(input.patch, 'approved')
          then (input.patch->>'approved')::boolean else run.permission_widening_approved end,
        compiler_version = case when jsonb_exists(input.patch, 'compiler')
          then input.patch->>'compiler' else run.compiler_version end,
        compiled_output = case when jsonb_exists(input.patch, 'compiled')
          then nullif(input.patch->'compiled', 'null'::jsonb) else run.compiled_output end,
        release_files = case when jsonb_exists(input.patch, 'files')
          then nullif(input.patch->'files', 'null'::jsonb) else run.release_files end,
        size_bytes = case when jsonb_exists(input.patch, 'bytes')
          then (input.patch->>'bytes')::bigint else run.size_bytes end,
        github_commit = case when jsonb_exists(input.patch, 'commit')
          then input.patch->>'commit' else run.github_commit end,
        github_path = case when jsonb_exists(input.patch, 'path')
          then input.patch->>'path' else run.github_path end,
        catalog_package_id = case when jsonb_exists(input.patch, 'catalog')
          then (input.patch->'catalog'->>'packageId')::bigint else run.catalog_package_id end,
        catalog_version_id = case when jsonb_exists(input.patch, 'catalog')
          then (input.patch->'catalog'->>'versionId')::bigint else run.catalog_version_id end,
        cataloged_at = case when jsonb_exists(input.patch, 'catalogedAt')
          then (input.patch->>'catalogedAt')::timestamptz else run.cataloged_at end,
        release_receipt = case when jsonb_exists(input.patch, 'receipt')
          then input.patch->>'receipt' else run.release_receipt end,
        completed_at = case when jsonb_exists(input.patch, 'completedAt')
          then (input.patch->>'completedAt')::timestamptz else run.completed_at end,
        error_stage = null,
        last_error_code = null,
        last_error_retryable = null,
        updated_at = now()
      from input
      where run.id = ${id} and run.state = ${from}
      returning run.*
    `
    const row = rows[0]
    if (row !== undefined) return runOf(row)
    const [current] = await sql<Array<{ readonly state: string }>>`
      select state from marketplace_release_runs where id = ${id} limit 1
    `
    if (current === undefined) throw new Error(`no release run ${id}`)
    throw new Error(`release run ${id} already moved to ${current.state}`)
  }

  const fail: ReleaseRepository["fail"] = async ({ id, stage, code, retryable }) => {
    const rows = await sql<RunRow[]>`
      update marketplace_release_runs
      set error_stage = ${stage}, last_error_code = ${code},
          last_error_retryable = ${retryable}, updated_at = now()
      where id = ${id} and state = ${stage}
      returning *
    `
    const row = rows[0]
    if (row !== undefined) return runOf(row)
    const [current] = await sql<RunRow[]>`
      select * from marketplace_release_runs where id = ${id} limit 1
    `
    if (current === undefined) throw new Error(`no release run ${id}`)
    return runOf(current)
  }

  const parentVersion: ReleaseRepository["parentVersion"] = async ({ slug, version }) => {
    const [row] = await sql<ParentRow[]>`
      select parent.id as package_id, version.id as version_id, version.github_commit,
             version.manifest, latest.version as latest_version
      from marketplace_packages parent
      join marketplace_versions version
        on version.package_id = parent.id and version.version = ${version}
      left join marketplace_versions latest on latest.id = parent.latest_version_id
      where parent.slug = ${slug} and parent.removed_at is null and version.yanked_at is null
      limit 1
    `
    if (row === undefined) return null
    const manifest = parseManifest(jsonOf(row.manifest, "manifest"))
    return {
      packageId: String(row.package_id),
      versionId: String(row.version_id),
      commit: row.github_commit,
      latestVersion: row.latest_version ?? version,
      // As the parent's own manifest holds them: a page package names none, and a fork of
      // it names none either, so the delta between them is empty rather than a removal.
      ...(manifest.capabilities === undefined ? {} : { capabilities: manifest.capabilities })
    }
  }

  /**
   * The fork's package row, its version row and the lineage between them, in one
   * transaction and never touching the package it was forked from. Both writes are
   * `on conflict do nothing`, so the second call after a lost response reads the first
   * call's rows back instead of writing a second version of one release.
   */
  const catalog: ReleaseRepository["catalog"] = (input) =>
    sql.begin(async (transaction) => {
      const { owner, repo } = repositoryOf(input.repository)
      const [created] = await transaction<PackageRow[]>`
        with scope as (
          select array(
            select path
            from jsonb_array_elements_text((${JSON.stringify(input.scope.paths)}::text)::jsonb)
            with ordinality as ordered(path, position)
            order by position
          ) as paths
        )
        insert into marketplace_packages
          (owner_id, slug, name, summary, license, scope_kind, scope_origin, scope_paths,
           github_owner, github_repo, github_path, forked_from_package_id, forked_from_version_id)
        select
          ${input.ownerId}, ${input.slug}, ${input.name}, ${input.summary}, ${input.license},
          ${input.scope.kind}, ${input.scope.origin}, scope.paths,
          ${owner}, ${repo}, ${`packages/${input.slug}`},
          ${input.forkedFrom?.packageId ?? null}, ${input.forkedFrom?.versionId ?? null}
        from scope
        on conflict (slug) do nothing
        returning id, owner_id, forked_from_package_id, forked_from_version_id
      `
      const [held] = created === undefined
        ? await transaction<PackageRow[]>`
            select id, owner_id, forked_from_package_id, forked_from_version_id
            from marketplace_packages where slug = ${input.slug} limit 1
          `
        : [created]
      // Another transaction inserting this same new slug is skipped rather than waited for,
      // and its row is not visible yet. That is a retry rather than a refusal.
      if (held === undefined) throw new Error(`the package ${input.slug} is being written by another release`)
      // A version is published into its own package or into none: a slug someone else owns
      // is not a name this release may add to.
      if (String(held.owner_id) !== input.ownerId) {
        throw new Error(`the package ${input.slug} belongs to another owner`)
      }
      // A root package's later versions are roots too, and a fork's stay with its parent.
      const heldLineage = pairOf(held.forked_from_package_id, held.forked_from_version_id, "forked_from_package_id", (id, version) => ({
        packageId: String(id),
        versionId: String(version)
      }))
      if (
        (heldLineage?.packageId ?? null) !== (input.forkedFrom?.packageId ?? null) ||
        (heldLineage?.versionId ?? null) !== (input.forkedFrom?.versionId ?? null)
      ) {
        throw new Error(`the package ${input.slug} belongs to another fork lineage`)
      }
      const packageId = String(held.id)
      await transaction`
        update marketplace_packages
        set name = ${input.name}, summary = ${input.summary}, license = ${input.license},
            scope_kind = ${input.scope.kind}, scope_origin = ${input.scope.origin},
            scope_paths = array(
              select value
              from jsonb_array_elements_text(
                (${JSON.stringify(input.scope.paths)}::text)::jsonb
              ) as value
            ),
            github_owner = ${owner}, github_repo = ${repo},
            github_path = ${`packages/${input.slug}`}
        where id = ${packageId}
      `

      const [written] = await transaction<VersionRow[]>`
        insert into marketplace_versions
          (package_id, version, runtime, manifest, github_commit, github_path, source_digest,
           script_digest, css_digest, kit_range, kit_built_with, compiler_version, size_bytes,
           published_by, published_at)
        values
          (${packageId}, ${input.version}, ${input.runtime},
           (${JSON.stringify(input.manifest)}::text)::jsonb, ${input.commit}, ${input.path},
           ${input.digests.source}, ${input.digests.script}, ${input.digests.css},
           ${input.compatibility.kit}, ${input.builtWith}, ${input.compiler},
           ${input.sizeBytes}, ${input.ownerId}, ${input.publishedAt})
        on conflict (package_id, version) do nothing
        returning id, published_at
      `
      if (written === undefined) {
        const [stored] = await transaction<VersionRow[]>`
          select id, published_at from marketplace_versions
          where package_id = ${packageId} and version = ${input.version}
          limit 1
        `
        if (stored === undefined) throw new Error(`the version ${input.slug}@${input.version} was neither written nor found`)
        return { packageId, versionId: String(stored.id), publishedAt: iso(stored.published_at) }
      }

      const versionId = String(written.id)
      await transaction`
        update marketplace_packages
        set latest_version_id = ${versionId}, updated_at = ${input.publishedAt}
        where id = ${packageId}
      `
      return { packageId, versionId, publishedAt: iso(written.published_at) }
    })

  return { load: byContentKey, open, advance, fail, parentVersion, catalog }
}
