import { AnyMap, originalPositionFor, type SectionedSourceMapInput } from "@jridgewell/trace-mapping"
import type { SourceLocation } from "./model"
import type { GeneratedSource } from "./source"

/**
 * Turning a position in a script the browser ran into the line a person wrote.
 *
 * React 19 no longer says where the JSX was written; it captures a stack, and a stack
 * points into the built bundle or into the dev server's transform of one file. The bundle
 * carries the answer in its source map, so this module finds the map a script names and
 * reads one position out of it. Both steps are pure: the fetch belongs to the caller.
 *
 * A map is read only after it is checked, and the position it gives is checked again. A
 * map that points at a line no file has must give nothing, because the inspector hands
 * what it says to an agent as an authored line.
 */

/** Only a `//#` or `/*#` comment names a map. A string that mentions one does not. */
const REFERENCE = /(?:\/\/|\/\*)[#@]\s*sourceMappingURL\s*=\s*([^\s'"]+)/g

/** VLQ mappings use base64, commas and semicolons, and nothing else. */
const ENCODED = /^[A-Za-z0-9+/,;]*$/

/** How deep one indexed map may nest another before it is treated as broken. */
const SECTIONS_MAX = 8

/**
 * The URL of the map a script names, absolute, or the data URL of an inline map, or null
 * when the script names none. The last reference wins, because that is the one a bundler
 * appends. A script URL the browser cannot parse leaves the reference as it was written.
 */
export const parseSourceMapReference = (script: string, scriptUrl: string): string | null => {
  let reference: string | null = null
  for (const match of script.matchAll(REFERENCE)) {
    const value = match[1]
    if (value === undefined) continue
    const trimmed = value.replace(/\*\/$/, "").trim()
    if (trimmed !== "") reference = trimmed
  }
  if (reference === null) return null
  if (reference.startsWith("data:")) return reference
  try {
    return new URL(reference, scriptUrl).href
  } catch {
    return reference
  }
}

/** A line, a column, or an index: a whole number, never below zero. */
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0

const isIndex = (value: unknown, limit: number): boolean => isCount(value) && value < limit

/**
 * A decoded segment is one, four, or five whole numbers, none of them below zero: the
 * generated column, then the source index, the original line and the original column,
 * then the index of a name. Anything else would map a position onto a line no file has.
 */
const segmentIsValid = (segment: unknown, sources: number, names: number): boolean => {
  if (!Array.isArray(segment)) return false
  if (segment.length !== 1 && segment.length !== 4 && segment.length !== 5) return false
  if (!isCount(segment[0])) return false
  if (segment.length === 1) return true
  return (
    isIndex(segment[1], sources) &&
    isCount(segment[2]) &&
    isCount(segment[3]) &&
    (segment.length === 4 || isIndex(segment[4], names))
  )
}

/** A map with its own mappings, encoded as VLQ or already decoded into segments. */
const asPlainMap = (raw: Record<string, unknown>): Record<string, unknown> | null => {
  const sources = raw.sources
  if (!Array.isArray(sources)) return null
  const mappings = raw.mappings
  if (typeof mappings === "string") return ENCODED.test(mappings) ? raw : null
  if (!Array.isArray(mappings)) return null
  const names = Array.isArray(raw.names) ? raw.names.length : 0
  const lines = mappings.every(
    (line) => Array.isArray(line) && line.every((segment) => segmentIsValid(segment, sources.length, names))
  )
  return lines ? raw : null
}

/** An indexed map holds one map per region of the generated file, each at an offset. */
const asIndexedMap = (raw: Record<string, unknown>, depth: number): Record<string, unknown> | null => {
  const sections = raw.sections
  if (!Array.isArray(sections)) return null
  const valid = sections.every((section) => {
    if (typeof section !== "object" || section === null) return false
    const offset = (section as { offset?: unknown }).offset
    if (typeof offset !== "object" || offset === null) return false
    const { line, column } = offset as { line?: unknown; column?: unknown }
    return isCount(line) && isCount(column) && asMap((section as { map?: unknown }).map, depth + 1) !== null
  })
  return valid ? raw : null
}

/** A map is worth a lookup when it says version 3 and every position in it is a real one. */
const asMap = (value: unknown, depth: number): Record<string, unknown> | null => {
  if (depth > SECTIONS_MAX) return null
  if (typeof value === "string") {
    try {
      return asMap(JSON.parse(value), depth)
    } catch {
      return null
    }
  }
  if (typeof value !== "object" || value === null) return null
  const raw = value as Record<string, unknown>
  if (raw.version !== 3) return null
  return raw.sections === undefined ? asPlainMap(raw) : asIndexedMap(raw, depth)
}

/**
 * The authored position of a generated one, or null when the map cannot say. Null is the
 * honest answer for a malformed map, a line the map does not cover, a segment that names
 * no source, and a segment whose numbers are not a real position: the caller keeps the
 * generated position and calls it `transformed`.
 *
 * The map's relative sources and its source root resolve against `sourceBase`. By default
 * that is `mapUrl`, where the map came from. An inline map arrives as a data URL, which is
 * no base, so the default there is `generated.url`, the script the map sits in. A caller
 * that knows better passes `sourceBase` itself.
 */
export const resolveSourceMap = (
  map: unknown,
  generated: GeneratedSource,
  mapUrl: string,
  sourceBase?: string
): SourceLocation | null => {
  const raw = asMap(map, 0)
  if (raw === null) return null
  const line = Number.isFinite(generated.line) ? Math.trunc(generated.line) : 0
  if (line < 1) return null
  // A stack frame counts columns from one and a map counts them from zero. A caller that
  // already counts from zero lands on the first column either way, which is the safe miss.
  const column = Number.isFinite(generated.column) ? Math.max(0, Math.trunc(generated.column) - 1) : 0
  const chosen = sourceBase ?? (mapUrl.startsWith("data:") ? generated.url : mapUrl)
  const base = chosen === "" || chosen.startsWith("data:") ? undefined : chosen
  try {
    // AnyMap reads a plain map and an indexed one, so a bundler that concatenates maps is
    // read the same way as one that writes a single map.
    const trace = AnyMap(raw as unknown as SectionedSourceMapInput, base)
    const found = originalPositionFor(trace, { line, column })
    if (typeof found.source !== "string") return null
    // Encoded mappings are read as a whole, so their numbers are checked here instead:
    // a line below one and a column below zero are no position, whatever the map says.
    const authoredLine = found.line
    const authoredColumn = found.column
    if (!isCount(authoredLine) || authoredLine < 1) return null
    if (!isCount(authoredColumn)) return null
    // A map may leave a source unnamed. Resolving that null against the base gives the
    // base's own directory, which reads like a file and is not one, so only named sources count.
    const named = trace.resolvedSources.filter((_, index) => {
      const source = trace.sources[index]
      return typeof source === "string" && source !== ""
    })
    if (!named.includes(found.source)) return null
    return {
      file: found.source,
      line: authoredLine,
      column: authoredColumn + 1,
      component: generated.component ?? (typeof found.name === "string" && found.name !== "" ? found.name : null),
      precision: "authored"
    }
  } catch {
    return null
  }
}
