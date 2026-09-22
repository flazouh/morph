import type { NativeTool } from "@clavia/tardigrade"
import { Effect } from "effect"
import { canonicalPath, type PackageSource } from "../marketplace/compiler/source"
import type { ExtensionForkDrafts } from "../marketplace/extension"
import { currentRevisionOf, parentKey, type ForkDraft, type ForkParent } from "../marketplace/forks/model"
import { parseSandboxCapabilities, type SandboxCapabilities } from "../marketplace/manifest"
import type { ExtensionPublisher } from "../marketplace/publishing/extension"
import type {
  PublishAuthorization,
  QuestionController
} from "./question"
import { asAnswer, failure, object, str } from "./tool-input"
import type { World } from "./world"

export interface ForkToolContext {
  readonly parent: ForkParent
  readonly drafts: ExtensionForkDrafts
  readonly publisher: ExtensionPublisher
}

const sourcePath = (path: string): string => {
  if (!canonicalPath(path)) {
    throw new Error(`${JSON.stringify(path)} is not a package-relative path`)
  }
  return path
}

const sourceChanges = (
  input: unknown
): ReadonlyArray<{ readonly path: string; readonly content: string | null }> => {
  const files = (input as { files?: unknown } | undefined)?.files
  if (!Array.isArray(files)) return []
  return files
    .filter(
      (file): file is { readonly path: string; readonly content: string | null } =>
        typeof file?.path === "string" &&
        (typeof file?.content === "string" || file?.content === null)
    )
    .map((file) => ({
      path: sourcePath(file.path),
      content: file.content
    }))
}

export const morphToolsFor = (
  fork: ForkToolContext,
  questions?: QuestionController
): ReadonlyArray<NativeTool<World>> => {
  const draft = async (): Promise<ForkDraft | undefined> =>
    (await fork.drafts.list()).find(
      (item) => parentKey(item.parent) === parentKey(fork.parent)
    )
  const current = async (): Promise<{
    readonly draft: ForkDraft | undefined
    readonly source: PackageSource
    /** A page package asks for no capabilities, so this is its own kind of answer. */
    readonly capabilities: SandboxCapabilities | undefined
  }> => {
    const found = await draft()
    if (found === undefined) {
      return {
        draft: undefined,
        source: fork.parent.source,
        capabilities: fork.parent.capabilities
      }
    }
    const revision = currentRevisionOf(found)
    return { draft: found, source: revision.source, capabilities: revision.capabilities }
  }

  return [
    {
      spec: {
        name: "read_morph_source",
        description:
          "Read the installed Morph source before changing it. Omit path to list files and lineage. A read never creates a local draft.",
        inputSchema: object(
          { path: { type: "string", description: "One package-relative source path." } },
          []
        )
      },
      run: (input) =>
        asAnswer(
          Effect.tryPromise({
            try: async () => {
              const state = await current()
              const rawPath = str(input, "path")
              if (rawPath === undefined) {
                return {
                  parent: fork.parent.slug,
                  version: fork.parent.version,
                  commit: fork.parent.commit,
                  draftId: state.draft?.id ?? null,
                  draftName: state.draft?.name ?? null,
                  currentRevision: state.draft?.currentRevision ?? null,
                  revisions:
                    state.draft?.revisions.map((revision) => ({
                      id: revision.id,
                      createdAt: revision.createdAt,
                      permissionChanges: revision.permissions
                    })) ?? [],
                  files: Object.keys(state.source.files).sort()
                }
              }
              const path = sourcePath(rawPath)
              const content = state.source.files[path]
              return content === undefined
                ? { error: `source file ${JSON.stringify(path)} does not exist` }
                : { path, content }
            },
            catch: failure
          })
        )
    },
    {
      spec: {
        name: "write_morph_source",
        description:
          "Change the installed Morph source. Send only complete changed files. Use null to delete one. The first successful change creates a local draft, compiles it, and previews it without changing the published parent.",
        inputSchema: object(
          {
            files: {
              type: "array",
              items: object(
                {
                  path: { type: "string" },
                  content: { type: ["string", "null"] }
                },
                ["path", "content"]
              )
            },
            capabilities: {
              type: "object",
              description:
                "The complete sandbox capabilities only when permissions must change."
            }
          },
          ["files"]
        )
      },
      run: (input) =>
        asAnswer(
          Effect.tryPromise({
            try: async () => {
              const state = await current()
              const changes = sourceChanges(input).filter((change) =>
                change.content === null
                  ? state.source.files[change.path] !== undefined
                  : state.source.files[change.path] !== change.content
              )
              if (changes.length === 0) throw new Error("no source files changed")
              const files = { ...state.source.files }
              for (const change of changes) {
                if (change.content === null) delete files[change.path]
                else files[change.path] = change.content
              }
              const rawCapabilities = (
                input as { readonly capabilities?: unknown } | undefined
              )?.capabilities
              // A page package asks for no capabilities, and a write must not invent any.
              const capabilities =
                rawCapabilities === undefined
                  ? state.capabilities
                  : parseSandboxCapabilities(rawCapabilities)
              const changed = await fork.drafts.edit(
                fork.parent,
                { ...state.source, files },
                capabilities
              )
              const revision = currentRevisionOf(changed)
              return {
                ok: true,
                draftId: changed.id,
                revisionId: revision.id,
                changedFiles: changes.map((change) => change.path),
                permissionChanges: revision.permissions
              }
            },
            catch: failure
          })
        )
    },
    {
      spec: {
        name: "rollback_morph",
        description:
          "Preview and restore one successful local Morph revision. Read the source list first to get the current draft ID.",
        inputSchema: object(
          {
            draftId: { type: "string" },
            revisionId: { type: "string" }
          },
          ["draftId", "revisionId"]
        )
      },
      run: (input) =>
        asAnswer(
          Effect.tryPromise({
            try: async () => {
              const draftId = str(input, "draftId") ?? ""
              const revisionId = str(input, "revisionId") ?? ""
              const restored = await fork.drafts.rollback(draftId, revisionId)
              return { ok: true, draftId: restored.id, revisionId: restored.currentRevision }
            },
            catch: failure
          })
        )
    },
    {
      spec: {
        name: "rename_morph_draft",
        description:
          "Give the local Morph draft a display name. This does not assign a public slug or author.",
        inputSchema: object(
          { draftId: { type: "string" }, name: { type: "string" } },
          ["draftId", "name"]
        )
      },
      run: (input) =>
        asAnswer(
          Effect.tryPromise({
            try: async () => {
              const renamed = await fork.drafts.rename(
                str(input, "draftId") ?? "",
                str(input, "name") ?? ""
              )
              return { ok: true, draftId: renamed.id, name: renamed.name }
            },
            catch: failure
          })
        )
    },
    {
      spec: {
        name: "discard_morph_draft",
        description:
          "Discard the local Morph draft and restore the installed published Morph.",
        inputSchema: object({ draftId: { type: "string" } }, ["draftId"])
      },
      run: (input) =>
        asAnswer(
          Effect.tryPromise({
            try: async () => {
              const draftId = str(input, "draftId") ?? ""
              await fork.drafts.discard(draftId)
              return { ok: true, draftId }
            },
            catch: failure
          })
        )
    },
    {
      spec: {
        name: "publish_morph",
        description:
          "Publish the current local Morph as a new package. First show its exact metadata, parent, preview capture, revision ID, and permission changes. Then use ask_user with a publish_morph authorization containing those exact release fields, revision ID, and added permissions. The answer comes back with its own callId: pass that as confirmationCallId. GitHub sign-in starts here when needed.",
        inputSchema: object(
          {
            draftId: { type: "string" },
            name: { type: "string" },
            slug: { type: "string" },
            summary: { type: "string" },
            version: { type: "string" },
            confirmationCallId: {
              type: "string",
              description: "The accepted ask_user call that authorized this exact release."
            }
          },
          [
            "draftId",
            "name",
            "slug",
            "summary",
            "version",
            "confirmationCallId"
          ]
        )
      },
      run: (input) =>
        asAnswer(
          Effect.tryPromise({
            try: async () => {
              const draftId = str(input, "draftId") ?? ""
              const found = await draft()
              if (found === undefined || found.id !== draftId) {
                throw new Error("the local Morph draft does not exist")
              }
              const revision = currentRevisionOf(found)
              const releaseInput = {
                name: str(input, "name") ?? "",
                slug: str(input, "slug") ?? "",
                summary: str(input, "summary") ?? "",
                version: str(input, "version") ?? ""
              }
              const authorization: PublishAuthorization = {
                action: "publish_morph",
                draftId,
                revisionId: revision.id,
                ...releaseInput,
                addedPermissions: revision.permissions.added
              }
              const confirmationCallId = str(input, "confirmationCallId") ?? ""
              if (
                questions?.authorizePublish(
                  confirmationCallId,
                  authorization
                ) !== true
              ) {
                throw new Error(
                  "the reader must confirm this exact release before publishing"
                )
              }
              const approvePermissionWidening =
                revision.permissions.added.length > 0
              const release = await fork.publisher.publish(draftId, revision.id, {
                ...releaseInput,
                approvePermissionWidening
              })
              questions?.spendPublish(confirmationCallId)
              return {
                ok: true,
                releaseId: release.id,
                status: release.state,
                slug: release.slug,
                version: release.version,
                commit: release.commit,
                receipt: release.receipt
              }
            },
            catch: failure
          })
        )
    }
  ]
}
