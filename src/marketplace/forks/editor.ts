import type { CompiledPackage } from "../compiler/compile"
import type { PackageSource } from "../compiler/source"
import type { SandboxCapabilities } from "../manifest"
import type { ForkDraftMemory } from "./memory"
import {
  currentRevisionOf,
  permissionDelta,
  type ForkDraft,
  type ForkParent,
  type ForkRevision
} from "./model"

export interface ForkPreview {
  readonly tabId: number
  readonly draftId: string
  /** How the page wears this draft: a sandbox frame, or its own style and script. */
  readonly runtime: ForkDraft["runtime"]
  readonly parent: ForkDraft["parent"]
  readonly scope: ForkDraft["scope"]
  readonly revision: ForkRevision
}

export interface ForkEditorPorts {
  readonly compile: (source: PackageSource, runtime: ForkDraft["runtime"]) => Promise<CompiledPackage>
  readonly preview: (preview: ForkPreview) => Promise<void>
  readonly clearPreview: (draftId: string, tabId: number, of: Pick<ForkDraft, "runtime" | "parent"> | undefined) => Promise<void>
  readonly id: () => string
  readonly now: () => string
}

export interface ForkEditor {
  readonly ensure: (parent: ForkParent) => Promise<ForkDraft>
  readonly edit: (
    parent: ForkParent,
    source: PackageSource,
    capabilities: SandboxCapabilities | undefined,
    tabId: number
  ) => Promise<ForkDraft>
  readonly rollback: (draftId: string, revisionId: string, tabId: number) => Promise<ForkDraft>
  readonly rename: (draftId: string, name: string) => Promise<ForkDraft>
  readonly discard: (draftId: string, tabId: number) => Promise<void>
  readonly list: () => Promise<ReadonlyArray<ForkDraft>>
}

const equal = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right)

export const forkEditor = (
  memory: ForkDraftMemory,
  ports: ForkEditorPorts
): ForkEditor => {
  let queue = Promise.resolve()
  const exclusive = <A>(operation: () => Promise<A>): Promise<A> => {
    const result = queue.then(operation, operation)
    queue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  const ensure = async (parent: ForkParent): Promise<ForkDraft> => {
    const createdAt = ports.now()
    const revisionId = ports.id()
    const create = (): ForkDraft => ({
      id: ports.id(),
      parent: {
        slug: parent.slug,
        version: parent.version,
        commit: parent.commit,
        license: parent.license,
        compatibility: parent.compatibility
      },
      runtime: parent.runtime,
      ...(parent.capabilities === undefined ? {} : { parentCapabilities: parent.capabilities }),
      scope: parent.scope,
      revisions: [
        {
          id: revisionId,
          createdAt,
          source: parent.source,
          compiled: parent.compiled,
          ...(parent.capabilities === undefined ? {} : { capabilities: parent.capabilities }),
          permissions: { added: [], removed: [] }
        }
      ],
      currentRevision: revisionId,
      createdAt,
      updatedAt: createdAt
    })
    const result = await memory.ensure(parent, create)
    return result.draft
  }

  const initialDraft = (parent: ForkParent): ForkDraft => {
    const createdAt = ports.now()
    const revisionId = ports.id()
    return {
      id: ports.id(),
        parent: {
          slug: parent.slug,
          version: parent.version,
          commit: parent.commit,
          license: parent.license,
          compatibility: parent.compatibility
        },
        runtime: parent.runtime,
        ...(parent.capabilities === undefined ? {} : { parentCapabilities: parent.capabilities }),
        scope: parent.scope,
        revisions: [
          {
            id: revisionId,
            createdAt,
            source: parent.source,
            compiled: parent.compiled,
            ...(parent.capabilities === undefined ? {} : { capabilities: parent.capabilities }),
            permissions: { added: [], removed: [] }
          }
        ],
        currentRevision: revisionId,
        createdAt,
        updatedAt: createdAt
      }
  }

  const show = (
    draft: ForkDraft,
    tabId: number,
    revision: ForkRevision
  ): Promise<void> =>
    ports.preview({
      tabId,
      draftId: draft.id,
      runtime: draft.runtime,
      parent: draft.parent,
      scope: draft.scope,
      revision
    })

  const restore = (draft: ForkDraft, tabId: number): Promise<void> =>
    show(draft, tabId, currentRevisionOf(draft)).catch(() => {})

  return {
    ensure: (parent) => exclusive(() => ensure(parent)),
    edit: (parent, source, capabilities, tabId) =>
      exclusive(async () => {
        const existing = Object.values((await memory.read()).drafts).find(
          (draft) => draft.parent.slug === parent.slug &&
            draft.parent.version === parent.version &&
            draft.parent.commit === parent.commit
        )
        if (
          existing === undefined &&
          equal(parent.source, source) &&
          equal(parent.capabilities, capabilities)
        ) {
          throw new Error("the Morph source did not change")
        }
        const draft = existing ?? initialDraft(parent)
        const current = currentRevisionOf(draft)
        if (equal(current.source, source) && equal(current.capabilities, capabilities)) {
          return draft
        }
        const compiled = await ports.compile(source, draft.runtime)
        const revision: ForkRevision = {
          id: ports.id(),
          createdAt: ports.now(),
          source,
          compiled,
          ...(capabilities === undefined ? {} : { capabilities }),
          permissions: permissionDelta(draft.parentCapabilities, capabilities)
        }
        await show(draft, tabId, revision)
        const changed = {
          ...draft,
          revisions: [...draft.revisions, revision],
          currentRevision: revision.id,
          updatedAt: revision.createdAt
        }
        try {
          if (existing === undefined) {
            return (await memory.ensure(parent, () => changed)).draft
          }
          return await memory.update(draft.id, () => changed)
        } catch (error) {
          if (existing === undefined) {
            await ports.clearPreview(draft.id, tabId, draft).catch(() => {})
          } else {
            await show(draft, tabId, current).catch(() => {})
          }
          throw error
        }
      }),
    rollback: (draftId, revisionId, tabId) =>
      exclusive(async () => {
        const library = await memory.read()
        const draft = library.drafts[draftId]
        if (draft === undefined) {
          throw new Error(`draft ${JSON.stringify(draftId)} does not exist`)
        }
        const revision = draft.revisions.find((item) => item.id === revisionId)
        if (revision === undefined) {
          throw new Error(
            `draft ${JSON.stringify(draftId)} has no revision ${JSON.stringify(revisionId)}`
          )
        }
        await show(draft, tabId, revision)
        const updatedAt = ports.now()
        try {
          return await memory.update(draftId, (latest) => ({
            ...latest,
            currentRevision: revisionId,
            updatedAt
          }))
        } catch (error) {
          await restore(draft, tabId)
          throw error
        }
      }),
    rename: (draftId, name) =>
      exclusive(() => {
        const trimmed = name.trim()
        if (trimmed === "") throw new Error("draft name must not be empty")
        return memory.update(draftId, (draft) => ({
          ...draft,
          name: trimmed,
          updatedAt: ports.now()
        }))
      }),
    discard: (draftId, tabId) =>
      exclusive(async () => {
        const draft = (await memory.read()).drafts[draftId]
        await ports.clearPreview(draftId, tabId, draft)
        try {
          await memory.remove(draftId)
        } catch (error) {
          if (draft !== undefined) {
            await restore(draft, tabId)
          }
          throw error
        }
      }),
    list: async () =>
      Object.values((await memory.read()).drafts).sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt)
      )
  }
}
