/**
 * How a local fork becomes an immutable public release, one stage at a time.
 *
 * Publishing crosses three systems that fail independently: a compiler, a Git repository
 * and a catalog database. Doing that in one request handler produces the two failures
 * nobody can repair by hand, a commit with no catalog row and two commits for one package
 * version. So a release is a stored run rather than a call: every stage records what it
 * did before the next one starts, and it is keyed by the content it publishes rather than
 * by a request, so an interrupted request, a retried worker and a second press of Publish
 * meet on one run and read back one package, one version, one commit and one receipt.
 *
 * Nothing here reaches a network, a clock or a database directly. The ports are injected
 * so the machine can be driven through every partial failure in a test, which is the only
 * way to know the resume paths are real.
 */
import type { CompiledPackage } from "../compiler/compile"
import { digestOf } from "../compiler/digest"
import { messageOf, PackageCompileError } from "../compiler/error"
import type { PackageSource } from "../compiler/source"
import { permissionDelta, type PermissionDelta } from "../forks/model"
import type { RedesignManifest, SandboxCapabilities } from "../manifest"
import {
  canonicalJson,
  checkedPreviews,
  contentOf,
  digestOfFile,
  digestsOfFiles,
  lineageOf,
  manifestOf,
  releaseBytesOf,
  releaseContentKey,
  releaseFilesOf,
  releasePathOf,
  ReleaseContentError,
  sameFiles,
  type ParentRelease,
  type ReleaseContent,
  type ReleaseFile,
  type ReleaseRuntime,
  type ReleaseSubmission
} from "./release-content"

export { canonicalJson, releaseContentKey, releasePathOf } from "./release-content"
export type {
  ParentRelease,
  PreviewImage,
  ReleaseContent,
  ReleaseFile,
  ReleasePreviews,
  ReleaseRuntime,
  ReleaseSubmission
} from "./release-content"

/**
 * The stages, in the order a release passes them. Each name means the work up to it is
 * done and stored: `compiled` is a server rebuild that matched, `committed` is files in
 * the repository, `verified` is those files read back from raw GitHub, `cataloged` is the
 * catalog rows, `completed` is the signed receipt. The order is also the resume order, so
 * a run at `committed` never commits again.
 */
export const RELEASE_STAGES = ["accepted", "compiled", "committed", "verified", "cataloged", "completed"] as const

export type ReleaseStage = (typeof RELEASE_STAGES)[number]

/** The one repository every package release is committed to, owned by the server. */
export const PACKAGE_REPOSITORY = "flazouh/morph-packages"
export const SANDBOX_KIT_VERSION = "1.0.0"

export interface CatalogTarget { readonly packageId: string; readonly versionId: string }

/** The rows the catalog holds, with the publication time it actually recorded. */
export interface CatalogWritten extends CatalogTarget { readonly publishedAt: string }

export interface ReleaseLineage extends ParentRelease, CatalogTarget {}

/** The parent as the server's own catalog holds it, never as the client describes it. */
export interface ParentVersion extends CatalogTarget {
  readonly commit: string
  /** The parent package's newest version, which a fork records but never follows. */
  readonly latestVersion: string
  /** The permission baseline the delta is measured against, absent for a page package. */
  readonly capabilities?: SandboxCapabilities
}

/** Everything the catalog needs, in one write, after the files are already public. */
export interface CatalogRelease
  extends Pick<ReleaseContent, "slug" | "version" | "name" | "summary" | "license" | "scope" | "compatibility"> {
  readonly runId: string
  readonly contentKey: string
  readonly ownerId: string
  readonly runtime: ReleaseRuntime
  readonly manifest: RedesignManifest
  readonly repository: string
  readonly commit: string
  readonly path: string
  readonly digests: { readonly source: string; readonly script: string; readonly css: string }
  readonly compiler: string
  readonly builtWith: string
  readonly sizeBytes: number
  /** The exact parent version a fork descends from, and nothing for a root package. */
  readonly forkedFrom: CatalogTarget | null
  readonly permissions: PermissionDelta
  readonly publishedAt: string
}

export interface OpenReleaseRun {
  readonly contentKey: string
  readonly ownerId: string
  readonly content: ReleaseContent
  readonly permissions: PermissionDelta
  readonly approved: boolean
  /** The parent as the catalog holds it, or nothing for a root package. */
  readonly parent: ReleaseLineage | null
}

export interface ReleaseRun extends OpenReleaseRun {
  readonly id: string
  readonly stage: ReleaseStage
  readonly compiler: string | null
  /** The complete server build, stored once so later stages never need another compiler. */
  readonly compiled: CompiledPackage | null
  /** Every committed file by repository-relative path, with the digest to verify it by. */
  readonly files: Readonly<Record<string, string>> | null
  readonly bytes: number | null
  readonly commit: string | null
  readonly path: string | null
  readonly catalog: CatalogTarget | null
  readonly catalogedAt: string | null
  readonly receipt: string | null
  readonly error: {
    readonly stage: ReleaseStage
    readonly code: string
    readonly retryable: boolean
  } | null
  readonly createdAt: string
  readonly updatedAt: string
  readonly completedAt: string | null
}

export type ReleaseRunPatch = Partial<
  Pick<ReleaseRun, "approved" | "compiler" | "compiled" | "files" | "bytes" | "commit" | "path" | "catalog" | "catalogedAt" | "receipt" | "completedAt">
>

export type OpenReleaseResult =
  | { readonly kind: "run"; readonly run: ReleaseRun }
  /** The slug and version are already spoken for by different content. */
  | { readonly kind: "version_taken"; readonly contentKey: string }

export interface ReleaseRepository {
  readonly load: (contentKey: string) => Promise<ReleaseRun | null>
  /**
   * The run for this content, created once. Idempotent by content key: a second call
   * returns the stored run at whatever stage it reached, and never resets it.
   */
  readonly open: (input: OpenReleaseRun) => Promise<OpenReleaseResult>
  /**
   * One stage forward, and only from the stage the caller last saw. `from` is a
   * compare-and-set, so two workers on one run cannot both catalog it; `to` may equal
   * `from` to patch a run without moving it.
   */
  readonly advance: (input: { readonly id: string; readonly from: ReleaseStage; readonly to: ReleaseStage; readonly patch: ReleaseRunPatch }) => Promise<ReleaseRun>
  readonly fail: (input: {
    readonly id: string
    readonly stage: ReleaseStage
    readonly code: string
    readonly retryable: boolean
  }) => Promise<ReleaseRun>
  readonly parentVersion: (input: { readonly slug: string; readonly version: string }) => Promise<ParentVersion | null>
  /**
   * The package row, the version row and the lineage, in one transaction. Must be
   * idempotent by slug and version, because a state write can fail after the transaction
   * commits: a second call returns the rows and the publication time of the first, and
   * never writes to the parent package.
   */
  readonly catalog: (input: CatalogRelease) => Promise<CatalogWritten>
}

/** Why a repository write did not happen, in the two shapes a caller acts on differently. */
export class GitHubWriteError extends Error {
  readonly _tag = "GitHubWriteError"
  readonly kind: "conflict" | "unavailable"
  constructor(kind: "conflict" | "unavailable", message: string) {
    super(message)
    this.name = "GitHubWriteError"
    this.kind = kind
  }
}

export interface ReleaseGitHub {
  readonly repository: string
  /** The tree already at this path, so a lost commit response is adopted, not repeated. */
  readonly existing: (input: { readonly path: string }) => Promise<{ readonly commit: string; readonly files: Readonly<Record<string, ReleaseFile>> } | null>
  readonly commit: (input: { readonly path: string; readonly files: Readonly<Record<string, ReleaseFile>>; readonly message: string }) => Promise<{ readonly commit: string }>
  /**
   * The files as a reader would fetch them, by raw URL. A file that is not visible yet
   * reads as `null` rather than an error: raw GitHub serves a commit's files a moment
   * after the commit exists, and that wait is a retry rather than a failure.
   */
  readonly read: (input: { readonly commit: string; readonly path: string; readonly files: ReadonlyArray<string> }) => Promise<Readonly<Record<string, ReleaseFile | null>>>
}

/** The claims a receipt signs: enough to prove what was published, and nothing secret. */
export interface ReleaseReceipt {
  readonly contentKey: string
  readonly slug: string
  readonly version: string
  readonly repository: string
  readonly commit: string
  readonly path: string
  readonly compiler: string
  readonly permissions: PermissionDelta
  readonly artifacts: { readonly script: string; readonly css: string }
  readonly files: Readonly<Record<string, string>>
  readonly parent: ParentRelease | null
  /**
   * When the catalog write landed, read from the run rather than from the clock: a stored
   * time is what makes a re-signed receipt identical to the first one.
   */
  readonly catalogedAt: string
}

export interface ReleasePorts {
  readonly repository: ReleaseRepository
  readonly github: ReleaseGitHub
  /** The build for the release's runtime: the sandbox compiler, or the page compiler. */
  readonly compile: (runtime: ReleaseRuntime, source: PackageSource) => Promise<CompiledPackage>
  readonly sign: (receipt: ReleaseReceipt) => Promise<string>
  readonly now: () => Date
}

export interface ReleaseCompleted {
  readonly status: "completed"
  readonly slug: string
  readonly version: string
  readonly repository: string
  readonly commit: string
  readonly path: string
  readonly receipt: string
  readonly package: CatalogTarget
  readonly run: ReleaseRun
}

export interface ReleaseFailed {
  readonly status: "failed"
  /** The stage the run held when the work failed, which is where a retry starts. */
  readonly stage: ReleaseStage
  readonly code: string
  readonly message: string
  readonly retryable: boolean
  /** Null when the failure happened before a run could be recorded. */
  readonly run: ReleaseRun | null
}

export type ReleaseResult = ReleaseCompleted | ReleaseFailed

export interface ReleasePublisher {
  readonly publish: (submission: ReleaseSubmission) => Promise<ReleaseResult>
  /** Carry a stored run forward with no submission in hand, as a worker does. */
  readonly resume: (contentKey: string) => Promise<ReleaseResult>
  readonly status: (contentKey: string) => Promise<ReleaseRun | null>
}

class ReleaseFailure extends Error {
  readonly code: string
  readonly retryable: boolean
  constructor(code: string, message: string, retryable: boolean) {
    super(message)
    this.name = "ReleaseFailure"
    this.code = code
    this.retryable = retryable
  }
}

const fatal = (code: string, message: string): ReleaseFailure => new ReleaseFailure(code, message, false)
const retry = (code: string, message: string): ReleaseFailure => new ReleaseFailure(code, message, true)

/**
 * Anything a port threw, as a failure. Content a release may not carry is settled before
 * any of this runs and cannot improve on a retry, so it is always fatal. Unrecognised
 * causes are worth another attempt.
 */
const failureOf = (cause: unknown, code: string): ReleaseFailure =>
  cause instanceof ReleaseFailure
    ? cause
    : cause instanceof ReleaseContentError
      ? fatal(cause.code, cause.message)
      : retry(code, messageOf(cause))

/** Whether every widened permission is one the creator confirmed, exactly as shown. */
const approvedOf = (permissions: PermissionDelta, approved: ReadonlyArray<string>): boolean =>
  permissions.added.every((permission) => approved.includes(permission))

export const releasePublisher = (ports: ReleasePorts): ReleasePublisher => {
  const repository = ports.github.repository
  const pending = new Map<string, Promise<ReleaseResult>>()
  const iso = (): string => ports.now().toISOString()

  const advance = async (run: ReleaseRun, to: ReleaseStage, patch: ReleaseRunPatch): Promise<ReleaseRun> => {
    try {
      return await ports.repository.advance({ id: run.id, from: run.stage, to, patch })
    } catch (cause) {
      throw retry("state_write_failed", messageOf(cause))
    }
  }

  /**
   * The server's own build of the submitted source, checked against what was submitted.
   * This is the step that makes a release trustworthy: the artifact a reader installs is
   * the one the server built from the source in the same commit, and a submission that
   * describes other bytes is refused before anything is written anywhere.
   */
  const rebuild = async (run: ReleaseRun): Promise<CompiledPackage> => {
    let compiled: CompiledPackage
    try {
      compiled = await ports.compile(run.content.runtime, run.content.source)
    } catch (cause) {
      if (cause instanceof PackageCompileError) throw fatal("compile_refused", messageOf(cause))
      throw retry("compile_failed", messageOf(cause))
    }
    if (!sameFiles(compiled.sources, run.content.sources)) {
      throw fatal("source_digest_mismatch", "the submitted source digests are not the ones the server read")
    }
    if (compiled.artifacts.script !== run.content.artifacts.script || compiled.artifacts.css !== run.content.artifacts.css) {
      throw fatal("artifact_mismatch", "the server's build does not match the submitted artifacts")
    }
    return compiled
  }

  const compileStage = async (run: ReleaseRun): Promise<{ readonly run: ReleaseRun; readonly compiled: CompiledPackage }> => {
    const compiled = await rebuild(run)
    if (!run.approved) {
      throw fatal("permission_widening_unapproved", `the release adds ${run.permissions.added.join(", ")}, which the creator has not confirmed`)
    }
    manifestOf(run.content, compiled)
    return { run: await advance(run, "compiled", { compiler: compiled.compiler, compiled }), compiled }
  }

  /**
   * The files, committed once. A commit that landed and then lost its response looks
   * exactly like a commit that never happened, so the path is read first: an identical tree
   * there is this release and gets adopted, and a different tree refuses the run.
   */
  const commitStage = async (run: ReleaseRun, compiled: CompiledPackage): Promise<ReleaseRun> => {
    const files = releaseFilesOf(run.content, compiled, manifestOf(run.content, compiled))
    const path = releasePathOf(run.content.slug, run.content.version)
    let found: Awaited<ReturnType<ReleaseGitHub["existing"]>>
    try {
      found = await ports.github.existing({ path })
    } catch (cause) {
      throw retry("github_unreadable", messageOf(cause))
    }
    let commit: string
    if (found === null) {
      try {
        const message = `release ${run.content.slug}@${run.content.version} (${run.contentKey})`
        commit = (await ports.github.commit({ path, files, message })).commit
      } catch (cause) {
        const conflict = cause instanceof GitHubWriteError && cause.kind === "conflict"
        throw retry(conflict ? "github_conflict" : "github_unavailable", messageOf(cause))
      }
    } else if (sameFiles(found.files, files)) {
      commit = found.commit
    } else {
      throw fatal("github_path_taken", `${path} already holds a different release`)
    }
    return advance(run, "committed", { commit, path, files: await digestsOfFiles(files), bytes: releaseBytesOf(files) })
  }

  /**
   * The commit read back the way a reader reads it, before the catalog points at it. A
   * catalog row that names files nobody can fetch is a broken install for everybody, so the
   * raw files are fetched and digested first. Files that have not appeared yet are a wait;
   * files whose bytes differ are a release this server will not vouch for.
   */
  const verifyStage = async (run: ReleaseRun): Promise<ReleaseRun> => {
    const expected = run.files
    if (expected === null || run.commit === null || run.path === null) {
      throw fatal("run_incomplete", "the run has no committed files to verify")
    }
    const paths = Object.keys(expected).sort()
    let raw: Readonly<Record<string, ReleaseFile | null>>
    try {
      raw = await ports.github.read({ commit: run.commit, path: run.path, files: paths })
    } catch (cause) {
      throw retry("github_unreadable", messageOf(cause))
    }
    const missing = paths.filter((path) => (raw[path] ?? null) === null)
    if (missing.length > 0) throw retry("github_not_propagated", `${missing.join(", ")} are not readable yet`)
    for (const path of paths) {
      // Bytes that will not decode are not the bytes this release committed, so an
      // unreadable file fails the same way a changed one does.
      const digest = await digestOfFile(raw[path] ?? "").catch(() => null)
      if (digest !== expected[path]) {
        throw fatal("github_content_mismatch", `${path} does not hold the bytes this release committed`)
      }
    }
    return advance(run, "verified", {})
  }

  const catalogStage = async (run: ReleaseRun): Promise<ReleaseRun> => {
    const compiled = run.compiled
    if (compiled === null || run.commit === null || run.path === null) {
      throw fatal("run_incomplete", "the run has no verified release to catalog")
    }
    const content = run.content
    const { slug, version, name, summary, license, scope, compatibility } = content
    let written: CatalogWritten
    try {
      written = await ports.repository.catalog({
        runId: run.id,
        contentKey: run.contentKey,
        ownerId: run.ownerId,
        slug, version, name, summary, license, scope, compatibility,
        runtime: content.runtime,
        manifest: manifestOf(content, compiled),
        repository,
        commit: run.commit,
        path: run.path,
        digests: {
          source: await digestOf(canonicalJson(compiled.sources)),
          script: compiled.artifacts.script,
          css: compiled.artifacts.css
        },
        compiler: compiled.compiler,
        builtWith: SANDBOX_KIT_VERSION,
        sizeBytes: run.bytes ?? 0,
        forkedFrom: run.parent === null ? null : { packageId: run.parent.packageId, versionId: run.parent.versionId },
        permissions: run.permissions,
        publishedAt: iso()
      })
    } catch (cause) {
      throw failureOf(cause, "catalog_failed")
    }
    // The time the catalog kept, so a retry after this write signs the receipt it already
    // would have signed, and the receipt matches the row a reader can look up.
    return advance(run, "cataloged", {
      catalog: { packageId: written.packageId, versionId: written.versionId },
      catalogedAt: written.publishedAt
    })
  }

  const completeStage = async (run: ReleaseRun): Promise<ReleaseRun> => {
    if (run.commit === null || run.path === null || run.compiled === null || run.files === null || run.catalogedAt === null) {
      throw fatal("run_incomplete", "the run has no cataloged release to sign")
    }
    let receipt: string
    try {
      receipt = await ports.sign({
        contentKey: run.contentKey,
        slug: run.content.slug,
        version: run.content.version,
        repository,
        commit: run.commit,
        path: run.path,
        compiler: run.compiled.compiler,
        artifacts: run.compiled.artifacts,
        files: run.files,
        parent: run.parent === null ? null : lineageOf(run.parent),
        permissions: run.permissions,
        catalogedAt: run.catalogedAt
      })
    } catch (cause) {
      throw retry("receipt_failed", messageOf(cause))
    }
    return advance(run, "completed", { receipt, completedAt: iso() })
  }

  const refused = (stage: ReleaseStage, failure: ReleaseFailure, run: ReleaseRun | null): ReleaseFailed => {
    const { code, message, retryable } = failure
    return { status: "failed", stage, code, message, retryable, run }
  }

  const failedOf = async (run: ReleaseRun, cause: unknown): Promise<ReleaseFailed> => {
    const failure = failureOf(cause, "stage_failed")
    const stored = await ports.repository.fail({
      id: run.id,
      stage: run.stage,
      code: failure.code,
      retryable: failure.retryable
    }).catch(() => run)
    return refused(run.stage, failure, stored)
  }

  const completedOf = (run: ReleaseRun): ReleaseResult => {
    const { commit, path, receipt, catalog } = run
    if (commit === null || path === null || receipt === null || catalog === null) {
      return refused(run.stage, fatal("run_incomplete", "the run is complete but does not name its release"), run)
    }
    const { slug, version } = run.content
    return { status: "completed", slug, version, repository, commit, path, receipt, package: catalog, run }
  }

  /** One stage at a time until the run is complete, keeping the build across stages. */
  const drive = async (start: ReleaseRun): Promise<ReleaseResult> => {
    let run = start
    let compiled: CompiledPackage | null = null
    for (;;) {
      if (run.stage === "completed") return completedOf(run)
      try {
        switch (run.stage) {
          case "accepted": {
            const stage = await compileStage(run)
            compiled = stage.compiled
            run = stage.run
            break
          }
          case "compiled": {
            if (run.compiled === null) throw fatal("run_incomplete", "the run has no stored build to commit")
            compiled = compiled ?? run.compiled
            run = await commitStage(run, compiled)
            break
          }
          case "committed":
            run = await verifyStage(run)
            break
          case "verified":
            run = await catalogStage(run)
            break
          case "cataloged":
            run = await completeStage(run)
            break
        }
      } catch (cause) {
        return failedOf(run, cause)
      }
    }
  }

  const load = async (contentKey: string): Promise<ReleaseRun | null> => {
    try {
      return await ports.repository.load(contentKey)
    } catch (cause) {
      throw retry("run_unreadable", messageOf(cause))
    }
  }

  /** A stored run meets a fresh submission: only the permission confirmation can change. */
  const synced = async (run: ReleaseRun, submission: ReleaseSubmission): Promise<ReleaseRun> => {
    if (run.stage !== "accepted") return run
    const approved = approvedOf(run.permissions, submission.approvedPermissions)
    return approved === run.approved ? run : advance(run, "accepted", { approved })
  }

  /**
   * A fork's parent, as the catalog holds it, and the permissions the fork adds to it. A
   * page fork reaches here too: it names a parent and no capabilities, so the delta it
   * measures is empty on both sides and nothing needs confirming.
   */
  const lineageOfFork = async (
    submission: ReleaseSubmission & { readonly parent: ParentRelease }
  ): Promise<Pick<OpenReleaseRun, "parent" | "permissions">> => {
    const { slug, parent: named } = submission
    if (slug === named.slug) throw fatal("parent_slug_reused", `a fork publishes as a new package; ${slug} is its parent`)
    let parent: ParentVersion | null
    try {
      parent = await ports.repository.parentVersion({ slug: named.slug, version: named.version })
    } catch (cause) {
      throw retry("parent_unreadable", messageOf(cause))
    }
    if (parent === null) throw fatal("parent_unknown", `the catalog has no ${named.slug}@${named.version}`)
    if (parent.commit !== named.commit) throw fatal("parent_commit_mismatch", "the parent version came from another commit")
    return {
      parent: { ...lineageOf(named), packageId: parent.packageId, versionId: parent.versionId },
      permissions: permissionDelta(parent.capabilities, submission.capabilities)
    }
  }

  /** A root package descends from nothing, so it widens nothing and needs no confirmation. */
  const ROOT_LINEAGE: Pick<OpenReleaseRun, "parent" | "permissions"> = { parent: null, permissions: { added: [], removed: [] } }

  const opened = async (submission: ReleaseSubmission, contentKey: string): Promise<ReleaseRun> => {
    const { slug, version } = submission
    const { parent, permissions } =
      submission.parent === undefined ? ROOT_LINEAGE : await lineageOfFork({ ...submission, parent: submission.parent })
    let result: OpenReleaseResult
    try {
      result = await ports.repository.open({
        contentKey,
        ownerId: submission.ownerId,
        content: contentOf(submission),
        permissions,
        approved: approvedOf(permissions, submission.approvedPermissions),
        parent
      })
    } catch (cause) {
      throw retry("run_unwritable", messageOf(cause))
    }
    if (result.kind === "version_taken") throw fatal("version_taken", `${slug}@${version} is published from other content`)
    return result.run
  }

  /** Whatever it takes to reach a run, then the run. A refusal here has no run to record. */
  const from = async (reach: () => Promise<ReleaseRun>): Promise<ReleaseResult> => {
    try {
      return await drive(await reach())
    } catch (cause) {
      return refused("accepted", failureOf(cause, "publish_failed"), null)
    }
  }

  const begin = (submission: ReleaseSubmission, contentKey: string): Promise<ReleaseResult> =>
    from(async () => {
      const stored = await load(contentKey)
      return stored === null ? opened(submission, contentKey) : synced(stored, submission)
    })

  const carry = (contentKey: string): Promise<ReleaseResult> =>
    from(async () => {
      const run = await load(contentKey)
      if (run === null) throw fatal("run_unknown", `no release run for ${contentKey}`)
      return run
    })

  /**
   * One run at a time per content key inside this process: two requests that would race
   * two compiles towards one commit share the first one's work instead.
   */
  const guarded = (contentKey: string, work: () => Promise<ReleaseResult>): Promise<ReleaseResult> => {
    const running = pending.get(contentKey)
    if (running !== undefined) return running
    const task = work().finally(() => pending.delete(contentKey))
    pending.set(contentKey, task)
    return task
  }

  return {
    /**
     * The images are decoded and held to their digests here, before a run exists. They are
     * the one part of a submission no retry can improve, and a run keyed by content should
     * never be opened for content this server has already decided not to publish.
     */
    publish: async (submission) => {
      try {
        const checked = { ...submission, previews: await checkedPreviews(submission.previews) }
        const contentKey = await releaseContentKey(checked)
        return await guarded(contentKey, () => begin(checked, contentKey))
      } catch (cause) {
        return refused("accepted", failureOf(cause, "publish_failed"), null)
      }
    },
    resume: (contentKey) => guarded(contentKey, () => carry(contentKey)),
    status: (contentKey) => ports.repository.load(contentKey)
  }
}
