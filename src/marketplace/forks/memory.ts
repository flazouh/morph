import { parentKey, type ForkDraft, type ForkDraftLibrary, type ForkParent } from "./model"
import { checkPageSource } from "../compiler/page"
import { checkSource } from "../compiler/source"
import { parseSandboxCapabilities } from "../manifest"

export interface ForkDraftStorage {
  readonly read: () => Promise<unknown>
  readonly write: (value: unknown) => Promise<void>
}

export interface ForkDraftMemory {
  readonly read: () => Promise<ForkDraftLibrary>
  readonly write: (library: ForkDraftLibrary) => Promise<void>
  readonly ensure: (
    parent: Pick<ForkParent, "slug" | "version" | "commit">,
    create: () => ForkDraft
  ) => Promise<{ readonly draft: ForkDraft; readonly created: boolean }>
  readonly update: (
    id: string,
    change: (draft: ForkDraft) => ForkDraft
  ) => Promise<ForkDraft>
  readonly remove: (id: string) => Promise<void>
}

const EMPTY: ForkDraftLibrary = { drafts: {} }

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const stringRecord = (value: unknown): value is Readonly<Record<string, string>> => {
  const valueRecord = record(value)
  return (
    valueRecord !== undefined &&
    Object.values(valueRecord).every((item) => typeof item === "string")
  )
}

/**
 * A stored revision, read back by the runtime its draft belongs to. A sandbox revision
 * carries a program and the capabilities it asks for; a page revision carries the page's
 * own code and asks for nothing, so demanding capabilities of it would throw every page
 * draft away on the next read.
 */
const isRevision = (value: unknown, runtime: ForkDraft["runtime"]): boolean => {
  const revision = record(value)
  const source = record(revision?.source)
  const compiled = record(revision?.compiled)
  const artifacts = record(compiled?.artifacts)
  const permissions = record(revision?.permissions)
  if (
    typeof revision?.id !== "string" ||
    typeof revision.createdAt !== "string" ||
    typeof source?.entry !== "string" ||
    typeof source.style !== "string" ||
    !stringRecord(source.files) ||
    typeof compiled?.compiler !== "string" ||
    typeof compiled.script !== "string" ||
    typeof compiled.style !== "string" ||
    !stringRecord(compiled.sources) ||
    typeof artifacts?.script !== "string" ||
    typeof artifacts.css !== "string" ||
    !Array.isArray(permissions?.added) ||
    !permissions.added.every((item) => typeof item === "string") ||
    !Array.isArray(permissions.removed) ||
    !permissions.removed.every((item) => typeof item === "string")
  ) {
    return false
  }
  const shape = { entry: source.entry, style: source.style, files: source.files }
  try {
    if (runtime === "script-v1") {
      checkPageSource(shape)
      return revision.capabilities === undefined
    }
    checkSource(shape)
    parseSandboxCapabilities(revision.capabilities)
    return true
  } catch {
    return false
  }
}

const isDraft = (value: unknown): value is ForkDraft => {
  const draft = record(value)
  const parent = record(draft?.parent)
  const compatibility = record(parent?.compatibility)
  const scope = record(draft?.scope)
  const runtime = draft?.runtime
  if (runtime !== "sandbox-v1" && runtime !== "script-v1") return false
  if (runtime === "script-v1" && draft?.parentCapabilities !== undefined) return false
  try {
    if (runtime === "sandbox-v1") parseSandboxCapabilities(draft?.parentCapabilities)
  } catch {
    return false
  }
  return (
    typeof draft?.id === "string" &&
    parent !== undefined &&
    typeof parent.slug === "string" &&
    typeof parent.version === "string" &&
    typeof parent.commit === "string" &&
    typeof parent.license === "string" &&
    typeof compatibility?.kit === "string" &&
    typeof compatibility.chrome === "string" &&
    (scope?.kind === "page" || scope?.kind === "site") &&
    typeof scope.origin === "string" &&
    Array.isArray(scope.paths) &&
    scope.paths.every((path) => typeof path === "string") &&
    Array.isArray(draft.revisions) &&
    draft.revisions.length > 0 &&
    draft.revisions.every((revision) => isRevision(revision, runtime)) &&
    typeof draft.currentRevision === "string" &&
    draft.revisions.some(
      (revision) => record(revision)?.id === draft.currentRevision
    ) &&
    typeof draft.createdAt === "string" &&
    typeof draft.updatedAt === "string"
  )
}

export const parseForkDraft = (value: unknown): ForkDraft | undefined =>
  isDraft(value) ? value : undefined

export const parseForkDraftLibrary = (value: unknown): ForkDraftLibrary => {
  const drafts = record(record(value)?.drafts)
  if (drafts === undefined) return EMPTY
  const valid: Record<string, ForkDraft> = {}
  for (const [id, draft] of Object.entries(drafts)) {
    if (isDraft(draft) && draft.id === id) valid[id] = draft
  }
  return { drafts: valid }
}

interface StoredRevision {
  readonly id: string
  readonly createdAt: string
  readonly source: {
    readonly entry: string
    readonly style: string
    readonly files: Readonly<Record<string, string>>
  }
  readonly compiled: {
    readonly compiler: string
    readonly scriptBlob: string
    readonly styleBlob: string
    readonly sources: Readonly<Record<string, string>>
    readonly artifacts: { readonly script: string; readonly css: string }
  }
  readonly capabilities: ForkDraft["revisions"][number]["capabilities"]
  readonly permissions: ForkDraft["revisions"][number]["permissions"]
}

interface StoredForkLibrary {
  readonly schema: 1
  readonly blobs: Readonly<Record<string, string>>
  readonly drafts: Readonly<
    Record<string, Omit<ForkDraft, "revisions"> & { readonly revisions: ReadonlyArray<StoredRevision> }>
  >
}

export const MAX_FORK_STORAGE_BYTES = 50_000_000

const encodeForkDraftLibrary = (library: ForkDraftLibrary): StoredForkLibrary => {
  const blobs: Record<string, string> = {}
  const put = (digest: string, content: string): string => {
    const existing = blobs[digest]
    if (existing !== undefined && existing !== content) {
      throw new Error(`fork storage digest collision for ${digest}`)
    }
    blobs[digest] = content
    return digest
  }
  const drafts = Object.fromEntries(
    Object.entries(library.drafts).map(([id, draft]) => [
      id,
      {
        ...draft,
        revisions: draft.revisions.map((revision): StoredRevision => ({
          id: revision.id,
          createdAt: revision.createdAt,
          source: {
            entry: revision.source.entry,
            style: revision.source.style,
            files: Object.fromEntries(
              Object.entries(revision.source.files).map(([path, content]) => {
                const digest = revision.compiled.sources[path]
                if (digest === undefined) {
                  throw new Error(`fork revision ${revision.id} has no digest for ${path}`)
                }
                return [path, put(digest, content)]
              })
            )
          },
          compiled: {
            compiler: revision.compiled.compiler,
            scriptBlob: put(revision.compiled.artifacts.script, revision.compiled.script),
            styleBlob: put(revision.compiled.artifacts.css, revision.compiled.style),
            sources: revision.compiled.sources,
            artifacts: revision.compiled.artifacts
          },
          capabilities: revision.capabilities,
          permissions: revision.permissions
        }))
      }
    ])
  )
  return { schema: 1, blobs, drafts }
}

const decodeStoredForkLibrary = (value: unknown): ForkDraftLibrary | undefined => {
  const stored = record(value)
  const blobs = record(stored?.blobs)
  const drafts = record(stored?.drafts)
  if (stored?.schema !== 1 || blobs === undefined || drafts === undefined) return undefined
  try {
    return parseForkDraftLibrary({
      drafts: Object.fromEntries(
        Object.entries(drafts).map(([id, rawDraft]) => {
          const draft = record(rawDraft)
          if (draft === undefined || !Array.isArray(draft.revisions)) {
            throw new Error("invalid compact fork draft")
          }
          return [
            id,
            {
              ...draft,
              revisions: draft.revisions.map((rawRevision) => {
                const revision = record(rawRevision)
                const source = record(revision?.source)
                const compiled = record(revision?.compiled)
                const files = record(source?.files)
                const sources = record(compiled?.sources)
                const artifacts = record(compiled?.artifacts)
                if (
                  source === undefined ||
                  compiled === undefined ||
                  files === undefined ||
                  sources === undefined ||
                  artifacts === undefined
                ) {
                  throw new Error("invalid compact fork revision")
                }
                return {
                  ...revision,
                  source: {
                    entry: source.entry,
                    style: source.style,
                    files: Object.fromEntries(
                      Object.entries(files).map(([path, digest]) => {
                        if (typeof digest !== "string" || typeof blobs[digest] !== "string") {
                          throw new Error(`fork source blob is missing for ${path}`)
                        }
                        return [path, blobs[digest]]
                      })
                    )
                  },
                  compiled: {
                    compiler: compiled.compiler,
                    script:
                      typeof compiled.scriptBlob === "string"
                        ? blobs[compiled.scriptBlob]
                        : undefined,
                    style:
                      typeof compiled.styleBlob === "string"
                        ? blobs[compiled.styleBlob]
                        : undefined,
                    sources,
                    artifacts
                  }
                }
              })
            }
          ]
        })
      )
    })
  } catch {
    return EMPTY
  }
}

export const compactForkDraftStorage = (
  storage: ForkDraftStorage,
  budgetBytes = MAX_FORK_STORAGE_BYTES
): ForkDraftStorage => ({
  read: async () => {
    const value = await storage.read()
    return decodeStoredForkLibrary(value) ?? value
  },
  write: async (value) => {
    const library = parseForkDraftLibrary(value)
    const compact = encodeForkDraftLibrary(library)
    const bytes = new TextEncoder().encode(JSON.stringify(compact)).byteLength
    if (bytes > budgetBytes) {
      throw new Error(
        `local Morph drafts exceed the ${budgetBytes} byte storage budget`
      )
    }
    await storage.write(compact)
  }
})

export const forkDraftMemory = (storage: ForkDraftStorage): ForkDraftMemory => {
  let queue = Promise.resolve()
  const exclusive = <A>(operation: () => Promise<A>): Promise<A> => {
    const result = queue.then(operation, operation)
    queue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
  const read = async (): Promise<ForkDraftLibrary> =>
    parseForkDraftLibrary(await storage.read())

  return {
    read: () => exclusive(read),
    write: (library) =>
      exclusive(async () => {
        await storage.write(library)
      }),
    ensure: (parent, create) =>
      exclusive(async () => {
        const library = await read()
        const key = parentKey(parent)
        const existing = Object.values(library.drafts).find(
          (draft) => parentKey(draft.parent) === key
        )
        if (existing !== undefined) return { draft: existing, created: false }
        const draft = create()
        await storage.write({
          drafts: { ...library.drafts, [draft.id]: draft }
        })
        return { draft, created: true }
      }),
    update: (id, change) =>
      exclusive(async () => {
        const library = await read()
        const draft = library.drafts[id]
        if (draft === undefined) throw new Error(`draft ${JSON.stringify(id)} does not exist`)
        const updated = change(draft)
        await storage.write({
          drafts: { ...library.drafts, [id]: updated }
        })
        return updated
      }),
    remove: (id) =>
      exclusive(async () => {
        const library = await read()
        if (library.drafts[id] === undefined) return
        const drafts = { ...library.drafts }
        delete drafts[id]
        await storage.write({ drafts })
      })
  }
}

const KEY = "marketplace-fork-drafts-v1"

export const chromeForkDraftMemory = (): ForkDraftMemory =>
  forkDraftMemory(
    compactForkDraftStorage({
      read: async () => (await chrome.storage.local.get(KEY))[KEY],
      write: async (value) => {
        await chrome.storage.local.set({ [KEY]: value })
      }
    })
  )
