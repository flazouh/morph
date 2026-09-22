import { Option, Schema } from "effect"
import type { SkinFiles } from "../skin/compile"

/**
 * One crew script slot: plain JavaScript from run_script, or a skin, whose sources are TSX
 * files and whose compiled form is what the page runs. The crew's script claim is exclusive,
 * so the crew holds one of these at a time.
 */
export type Script = { readonly kind: "js"; readonly source: string } | { readonly kind: "skin"; readonly files: SkinFiles }

/**
 * What the page wears: the stylesheet, the skin, and the plain script that re-runs on load.
 * The skin and the script are two slots, because they are two registrations on the page:
 * a persisted run_script after a write_skin adds to the skin, it does not replace it. The
 * site's design is kept apart, in Designs.
 */
export interface Applied {
  readonly css?: string
  readonly skin?: SkinFiles
  readonly script?: string
}

export const isApplied = (a: Applied): boolean => Object.keys(a).length > 0

/**
 * What the thread put on the site, by path. A thread may redesign several pages of one
 * site, and each page is its own slots: two skins on two paths are two pages, not one
 * skin replacing the other. The site's design stays apart, in Designs, since it is one
 * palette for the whole site.
 */
export type AppliedPages = Readonly<Record<string, Applied>>

export const hasApplied = (pages: AppliedPages): boolean => Object.values(pages).some(isApplied)

/**
 * The path a tool result applied to: the pathname alone, since the origin is the thread's
 * site and the query names no separate page. A result from before this was recorded, or
 * one carrying anything else, has no path, and the caller reads it as the page in front.
 */
export const appliedPathOf = (value: unknown): string | undefined => {
  const record = pathOfRecord(value)
  if (Option.isNone(record)) return undefined
  const { path } = record.value
  return path.startsWith("/") && !path.startsWith("//") ? path : undefined
}

/** The slot a crew script fills. */
export const appliedOf = (script: Script): Applied =>
  script.kind === "skin" ? { skin: script.files } : { script: script.source }

const SkinFilesSchema = Schema.Record(Schema.String, Schema.String)

/** The `applied` a tool result carries in this build. */
const AppliedRecord = Schema.Struct({
  css: Schema.optionalKey(Schema.String),
  skin: Schema.optionalKey(SkinFilesSchema),
  script: Schema.optionalKey(Schema.String)
})

/** The `applied` threads recorded before 2026-09-14 carry: one script slot, tagged by kind. */
const LegacyAppliedRecord = Schema.Struct({
  css: Schema.optionalKey(Schema.String),
  script: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("js"), source: Schema.String }),
    Schema.Struct({ kind: Schema.Literal("skin"), files: SkinFilesSchema })
  ])
})

const appliedOfRecord = Schema.decodeUnknownOption(AppliedRecord)
const pathOfRecord = Schema.decodeUnknownOption(Schema.Struct({ path: Schema.String }))
const legacyOfRecord = Schema.decodeUnknownOption(LegacyAppliedRecord)

/**
 * A tool result's `applied`, in this build's shape. A legacy record reads as the slot it
 * meant. Anything else applied nothing.
 */
export const readApplied = (value: unknown): Applied => {
  const current = appliedOfRecord(value)
  if (Option.isSome(current)) return current.value
  const legacy = legacyOfRecord(value)
  if (Option.isNone(legacy)) return {}
  const { css, script } = legacy.value
  return { ...(css === undefined ? {} : { css }), ...(script.kind === "skin" ? { skin: script.files } : { script: script.source }) }
}
