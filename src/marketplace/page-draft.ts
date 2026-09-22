import type { Persisted } from "../bridge/persisted"
import type { CompiledPackage } from "./compiler/compile"

/**
 * What a page wears for an installed page package: the release as published, or a local
 * draft of it. The records keep the release's own ids and scopes, so a draft is worn on
 * every load the way the published version was, and putting the release back is the same
 * write in reverse. Records of any other kind are left alone: only a page package's
 * stylesheet and script are swapped this way.
 */
export const pageDraftRecords = (
  records: ReadonlyArray<Persisted>,
  compiled: CompiledPackage | undefined
): ReadonlyArray<Persisted> => {
  if (compiled === undefined) return records
  return records.map((record) => {
    if (record.payload.kind === "style") return { ...record, payload: { kind: "style", css: compiled.style } }
    if (record.payload.kind === "script") return { ...record, payload: { kind: "script", js: compiled.script } }
    return record
  })
}
