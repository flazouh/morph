import type { ForkPreview } from "./editor"

export type ForkPreviewAsk =
  | { readonly type: "previewForkRevision"; readonly preview: ForkPreview }
  | { readonly type: "clearForkPreview"; readonly draftId: string }

/** The page's answer, settled once it has drawn the revision or put the parent back. */
export type ForkPreviewAnswer =
  | { readonly type: "forkRevisionPreviewed" }
  | { readonly type: "forkPreviewCleared" }
  | { readonly type: "forkPreviewError"; readonly message: string }

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

export const isForkPreviewAsk = (value: unknown): value is ForkPreviewAsk => {
  const message = record(value)
  if (message?.type === "clearForkPreview") return typeof message.draftId === "string"
  if (message?.type !== "previewForkRevision") return false
  const preview = record(message.preview)
  const revision = record(preview?.revision)
  const compiled = record(revision?.compiled)
  const scope = record(preview?.scope)
  return (
    typeof preview?.draftId === "string" &&
    record(preview.parent) !== undefined &&
    typeof scope?.origin === "string" &&
    Array.isArray(scope.paths) &&
    scope.paths.every((path) => typeof path === "string") &&
    typeof revision?.id === "string" &&
    typeof compiled?.script === "string" &&
    typeof compiled.style === "string" &&
    record(revision.capabilities) !== undefined
  )
}
