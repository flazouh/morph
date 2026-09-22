export const STYLE_PROPERTIES = [
  "padding",
  "margin",
  "color",
  "background-color",
  "border-radius",
  "font-size"
] as const

export type StyleProperty = typeof STYLE_PROPERTIES[number]
export type SourcePrecision = "authored" | "transformed" | "unknown"

export interface SourceLocation {
  readonly file: string
  readonly line: number | null
  readonly column: number | null
  readonly component: string | null
  readonly precision: SourcePrecision
}

export interface StyleChange {
  readonly selector: string
  readonly property: StyleProperty
  readonly before: string
  readonly after: string
}

export interface ChangeRecord {
  readonly url: string
  readonly tailwind: boolean
  readonly changes: ReadonlyArray<StyleChange>
  /** One entry per changed selector. A selector with no entry has no known source. */
  readonly sources: Readonly<Record<string, SourceLocation>>
}

export interface ChangeHistory {
  readonly present: ChangeRecord
  readonly past: ReadonlyArray<ChangeRecord>
  readonly future: ReadonlyArray<ChangeRecord>
}
