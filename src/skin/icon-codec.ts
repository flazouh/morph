import { Schema } from "effect"
import type { IconSet } from "../compiler/icons"

/**
 * The icon set as the build ships it. An icon is a list of SVG elements, `[tag, attrs]`.
 * Two things make the plain JSON three times the size it needs to be: nearly every
 * element carries the same four stroke attributes and a `key` equal to its index, and
 * the variants of one icon share their path data, so a third of the `d` strings are
 * unique. The packed form leaves the shared attributes out, marking the rare element
 * that lacks one with `null`, and puts each distinct `d` in one table, so unpacking is
 * exact. The round trip over the real set is tested.
 */

/** What an element at `index` carries unless it says otherwise. */
const defaultsAt = (index: number): Readonly<Record<string, string>> => ({
  stroke: "currentColor",
  strokeLinecap: "round",
  strokeLinejoin: "round",
  strokeWidth: "1.5",
  key: String(index)
})

const Attrs = Schema.Record(Schema.String, Schema.Unknown)
const Element = Schema.Tuple([Schema.String, Attrs])
export const PackedIconSet = Schema.Struct({
  /** Every distinct path `d`, by the index the elements use. */
  d: Schema.Array(Schema.String),
  icons: Schema.Record(Schema.String, Schema.Array(Element))
})
export type PackedIconSet = typeof PackedIconSet.Type

type Attributes = Readonly<Record<string, unknown>>
type PackedElement = readonly [string, Attributes]

/** Assigns each distinct path its index, in first-seen order. */
const pathTable = () => {
  const indexOf = new Map<string, number>()
  return {
    index: (d: string): number => {
      const known = indexOf.get(d)
      if (known !== undefined) return known
      indexOf.set(d, indexOf.size)
      return indexOf.size - 1
    },
    paths: (): Array<string> => [...indexOf.keys()]
  }
}

/** A default the element carries is left out; one it lacks is `null`; `d` becomes its table index. */
const packAttrs = (attrs: Attributes, index: number, pathIndex: (d: string) => number): Attributes => {
  const defaults = defaultsAt(index)
  const out: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(attrs)) {
    if (value === defaults[name]) continue
    out[name] = name === "d" && typeof value === "string" ? pathIndex(value) : value
  }
  for (const name of Object.keys(defaults)) if (!(name in attrs)) out[name] = null
  return out
}

const unpackAttrs = (attrs: Attributes, index: number, paths: ReadonlyArray<string>): Attributes => {
  const out: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(attrs)) {
    if (value === null) continue
    out[name] = name === "d" && typeof value === "number" ? paths[value] : value
  }
  for (const [name, value] of Object.entries(defaultsAt(index))) if (!(name in attrs)) out[name] = value
  return out
}

const isElement = (value: unknown): value is PackedElement =>
  Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && typeof value[1] === "object" && value[1] !== null

/** The set with the shared attributes and paths factored out. An export that is not a list of elements is dropped. */
export const packIconSet = (set: IconSet): PackedIconSet => {
  const table = pathTable()
  const icons: Record<string, Array<PackedElement>> = {}
  for (const [name, icon] of Object.entries(set)) {
    if (!Array.isArray(icon) || !icon.every(isElement)) continue
    icons[name] = icon.map(([tag, attrs], index) => [tag, packAttrs(attrs, index, table.index)] as const)
  }
  return { d: table.paths(), icons }
}

/** The set as the icon components expect it. */
export const unpackIconSet = (packed: PackedIconSet): IconSet => {
  const out: Record<string, unknown> = {}
  for (const [name, icon] of Object.entries(packed.icons)) {
    out[name] = icon.map(([tag, attrs], index) => [tag, unpackAttrs(attrs, index, packed.d)])
  }
  return out
}
