/**
 * The publishing world, in memory: every port a release run needs, backed by maps.
 *
 * A release only exists across a compiler, a Git repository and a catalog, and the whole
 * design is about what happens when one of them fails halfway. That is unreachable through
 * real services, so the fakes are the test seam: each one counts what it did, and `faults`
 * makes any single call fail once. Nothing here touches a network, a clock or a disk.
 */
import { digestOf, digestsOf } from "../compiler/digest"
import type { CompiledPackage } from "../compiler/compile"
import type { PackageSource } from "../compiler/source"
import type { SandboxCapabilities } from "../manifest"
import { previewsOf } from "./release-content.fake"
import type { ReleaseFile } from "./release-content"
import {
  canonicalJson,
  PACKAGE_REPOSITORY,
  releasePublisher,
  type CatalogRelease,
  type CatalogTarget,
  type ReleaseGitHub,
  type ReleasePorts,
  type ReleaseReceipt,
  type ReleaseRepository,
  type ReleaseRun,
  type ReleaseStage,
  type ReleaseSubmission
} from "./publishing"

export const COMPILER = "test-compiler-1"
export const PARENT_COMMIT = "1".repeat(40)
export const RELEASE_COMMIT = "2".repeat(40)
export const RELEASE_PATH = "packages/alex/quiet-fork/1.0.0"

const clone = <T>(value: T): T => structuredClone(value) as T

export const capabilities = (over: Partial<SandboxCapabilities> = {}): SandboxCapabilities => ({
  page: { read: ["main"], navigate: [], traverse: false },
  network: [],
  storage: false,
  context: { viewer: false, theme: true, route: false },
  assets: [],
  secureForms: [],
  ...over
})

export const sourceOf = (body: string): PackageSource => ({
  entry: "entry.ts",
  style: "style.css",
  files: {
    "entry.ts": `export const start = () => ${JSON.stringify(body)}`,
    "style.css": ".quiet { color: red }"
  }
})

/** The text of a committed file, and nothing for one of the two that hold image bytes. */
export const textOf = (file: ReleaseFile | undefined): string => (typeof file === "string" ? file : "")

/** A compiler that is deterministic and cheap, and whose digests are real sha256. */
const compileFake = async (source: PackageSource): Promise<CompiledPackage> => {
  const script = Object.keys(source.files)
    .sort()
    .map((path) => `// ${path}\n${source.files[path] ?? ""}`)
    .join("\n")
  const style = source.files[source.style] ?? ""
  const [sources, scriptDigest, cssDigest] = await Promise.all([
    digestsOf(source.files),
    digestOf(script),
    digestOf(style)
  ])
  return { compiler: COMPILER, script, style, sources, artifacts: { script: scriptDigest, css: cssDigest } }
}

export const signFake = async (receipt: ReleaseReceipt): Promise<string> =>
  `signed:${await digestOf(canonicalJson(receipt))}`

/** The fields every submission has, whichever runtime; the runtime half comes from the caller. */
type CommonSubmission = Omit<Extract<ReleaseSubmission, { runtime: "sandbox-v1" }>, "runtime" | "parent" | "capabilities">

const commonOf = async (over: Partial<CommonSubmission>, fallback: PackageSource): Promise<CommonSubmission> => {
  const source = over.source ?? fallback
  const compiled = await compileFake(source)
  return {
    ownerId: "u-fork",
    slug: "alex/quiet-fork",
    version: "1.0.0",
    name: "Quiet Fork",
    summary: "A quieter inbox",
    license: "MIT",
    scope: { kind: "page", origin: "https://example.com", paths: ["/inbox"] },
    source,
    sources: compiled.sources,
    artifacts: compiled.artifacts,
    compatibility: { kit: "^1.0.0", chrome: ">=120" },
    previews: await previewsOf(),
    approvedPermissions: [],
    ...over
  }
}

type ForkSubmission = Extract<ReleaseSubmission, { runtime: "sandbox-v1" }>
type RootSubmission = Extract<ReleaseSubmission, { runtime: "script-v1" }>

/** A sandbox fork of `alex/quiet@1.2.0`, the submission most tests publish. */
export const submissionOf = async (over: Partial<ForkSubmission> = {}): Promise<ForkSubmission> => {
  const { runtime: _runtime, parent, capabilities: declared, ...common } = over
  return {
    ...(await commonOf(common, sourceOf("fork"))),
    runtime: "sandbox-v1",
    capabilities: declared ?? capabilities(),
    parent: parent ?? { slug: "alex/quiet", version: "1.2.0", commit: PARENT_COMMIT }
  }
}

export const pageSourceOf = (body: string): PackageSource => ({
  entry: "page.js",
  style: "style.css",
  files: { "page.js": `document.title = ${JSON.stringify(body)}`, "style.css": ".quiet { color: red }" }
})

/** A page redesign published as a root package: no parent, no capabilities. */
export const rootSubmissionOf = async (over: Partial<RootSubmission> = {}): Promise<RootSubmission> => {
  const { runtime: _runtime, parent, capabilities: _capabilities, ...common } = over
  return {
    ...(await commonOf({ slug: "alex/quiet-page", name: "Quiet Page", ...common }, pageSourceOf("page"))),
    runtime: "script-v1",
    ...(parent === undefined ? {} : { parent })
  }
}

/** A page redesign that forks `alex/quiet-front@1.2.0`: a parent, and still no capabilities. */
export const pageForkSubmissionOf = async (over: Partial<RootSubmission> = {}): Promise<RootSubmission> =>
  rootSubmissionOf({ parent: { slug: "alex/quiet-front", version: "1.2.0", commit: PARENT_COMMIT }, ...over })

interface Faults {
  compile: number
  commit: number
  read: number
  catalog: number
  sign: number
  load: number
  compileError: Error | null
  advance: Set<ReleaseStage>
}

export const setup = (parentLatest = "1.2.0", parentCapabilities = capabilities()) => {
  const faults: Faults = {
    compile: 0, commit: 0, read: 0, catalog: 0, sign: 0, load: 0,
    compileError: null,
    advance: new Set<ReleaseStage>()
  }
  const counts = { compile: 0, commit: 0, read: 0, catalog: 0, inserts: 0, sign: 0 }
  /** Every signature this run produced, so a re-signed receipt can be held to the first. */
  const signed: string[] = []
  const transitions: string[] = []
  const runs = new Map<string, ReleaseRun>()
  const trees = new Map<string, { commit: string; files: Record<string, ReleaseFile> }>()
  const versions = new Map<string, CatalogRelease & CatalogTarget>()
  /** The catalog row a package owns, so a test can prove the parent row never moved. */
  const packages = new Map([
    ["alex/quiet", { id: "pkg-parent", latestVersion: parentLatest, forkedFrom: null as string | null }],
    // A published page redesign, which names no capabilities and can be forked all the same.
    ["alex/quiet-front", { id: "pkg-page-parent", latestVersion: "1.2.0", forkedFrom: null as string | null }]
  ])

  let ids = 0
  let ticks = 0
  const now = (): Date => new Date(Date.UTC(2026, 8, 9, 22, 0, ticks++))

  const trip = (key: "compile" | "commit" | "read" | "catalog" | "sign" | "load"): void => {
    if (faults[key] <= 0) return
    faults[key] -= 1
    throw new Error(`${key} is unavailable`)
  }

  const byId = (id: string): ReleaseRun => {
    const found = [...runs.values()].find((run) => run.id === id)
    if (found === undefined) throw new Error(`no run ${id}`)
    return found
  }

  const repository: ReleaseRepository = {
    load: async (contentKey) => {
      trip("load")
      const run = runs.get(contentKey)
      return run === undefined ? null : clone(run)
    },
    open: async (input) => {
      const found = runs.get(input.contentKey)
      if (found !== undefined) return { kind: "run", run: clone(found) }
      for (const run of runs.values()) {
        if (run.content.slug === input.content.slug && run.content.version === input.content.version) {
          return { kind: "version_taken", contentKey: run.contentKey }
        }
      }
      const stamp = now().toISOString()
      const run: ReleaseRun = {
        ...input,
        id: `run-${++ids}`,
        stage: "accepted",
        compiler: null, compiled: null, files: null, bytes: null,
        commit: null, path: null, catalog: null, catalogedAt: null,
        receipt: null, error: null, completedAt: null,
        createdAt: stamp,
        updatedAt: stamp
      }
      runs.set(run.contentKey, run)
      transitions.push(`open:${run.stage}`)
      return { kind: "run", run: clone(run) }
    },
    advance: async ({ id, from, to, patch }) => {
      const found = byId(id)
      if (found.stage !== from) throw new Error(`run ${id} already moved to ${found.stage}`)
      if (faults.advance.has(to)) {
        faults.advance.delete(to)
        throw new Error(`the ${to} state write failed`)
      }
      const next: ReleaseRun = { ...found, ...patch, stage: to, error: null, updatedAt: now().toISOString() }
      runs.set(next.contentKey, next)
      if (from !== to) transitions.push(to)
      return clone(next)
    },
    fail: async ({ id, stage, code, retryable }) => {
      const found = byId(id)
      if (found.stage !== stage) return clone(found)
      const next: ReleaseRun = {
        ...found,
        error: { stage, code, retryable },
        updatedAt: now().toISOString()
      }
      runs.set(next.contentKey, next)
      return clone(next)
    },
    parentVersion: async ({ slug, version }) => {
      const found = packages.get(slug)
      if (found === undefined || version !== "1.2.0") return null
      return {
        packageId: found.id,
        versionId: found.id === "pkg-page-parent" ? "ver-page-parent-1.2.0" : "ver-parent-1.2.0",
        commit: PARENT_COMMIT,
        latestVersion: found.latestVersion,
        ...(found.id === "pkg-page-parent" ? {} : { capabilities: parentCapabilities })
      }
    },
    catalog: async (input) => {
      counts.catalog += 1
      trip("catalog")
      const key = `${input.slug}@${input.version}`
      const written = versions.get(key)
      // A second call reports the rows and the publication time the first one recorded.
      if (written !== undefined) {
        const { packageId, versionId, publishedAt } = written
        return { packageId, versionId, publishedAt }
      }
      counts.inserts += 1
      const packageId = packages.get(input.slug)?.id ?? `pkg-${++ids}`
      packages.set(input.slug, { id: packageId, latestVersion: input.version, forkedFrom: input.forkedFrom?.versionId ?? null })
      const target: CatalogTarget = { packageId, versionId: `ver-${++ids}` }
      versions.set(key, { ...input, ...target })
      return { ...target, publishedAt: input.publishedAt }
    }
  }

  const github: ReleaseGitHub = {
    repository: PACKAGE_REPOSITORY,
    existing: async ({ path }) => {
      const tree = trees.get(path)
      return tree === undefined ? null : { commit: tree.commit, files: clone(tree.files) }
    },
    commit: async ({ path, files }) => {
      trip("commit")
      // Counted after the fault, so the count is trees written rather than writes tried.
      counts.commit += 1
      trees.set(path, { commit: RELEASE_COMMIT, files: { ...files } })
      return { commit: RELEASE_COMMIT }
    },
    read: async ({ commit, path, files }) => {
      counts.read += 1
      trip("read")
      const tree = trees.get(path)
      if (tree === undefined || tree.commit !== commit) return {}
      return Object.fromEntries(files.map((file) => [file, tree.files[file] ?? null]))
    }
  }

  const ports: ReleasePorts = {
    repository,
    github,
    compile: async (_runtime, source) => {
      counts.compile += 1
      if (faults.compileError !== null) {
        const error = faults.compileError
        faults.compileError = null
        throw error
      }
      trip("compile")
      return compileFake(source)
    },
    sign: async (receipt) => {
      counts.sign += 1
      trip("sign")
      const signature = await signFake(receipt)
      signed.push(signature)
      return signature
    },
    now
  }

  return {
    ports,
    github,
    faults,
    counts,
    signed,
    transitions,
    versions,
    packages,
    trees,
    publisher: releasePublisher(ports),
    /** A second publisher over the same stored runs, for GitHub behaviour a fault count cannot express. */
    sharing: (over: Partial<ReleasePorts>) => releasePublisher({ ...ports, ...over })
  }
}
