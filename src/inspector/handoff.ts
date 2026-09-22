import { STYLE_PROPERTIES } from "./model"
import type { ChangeRecord, SourceLocation, StyleChange } from "./model"

const sourceText = (source: SourceLocation | undefined): string => {
  if (source === undefined) return "unknown"

  const position = source.line === null
    ? source.file
    : source.column === null
      ? `${source.file}:${source.line}`
      : `${source.file}:${source.line}:${source.column}`
  const details = [
    source.component,
    source.precision === "transformed"
      ? "transformed, not authored"
      : source.precision === "unknown"
        ? "unknown precision"
        : "authored"
  ].filter((detail): detail is string => detail !== null)

  return `${position} (${details.join(", ")})`
}

const cssBlock = (
  selector: string,
  changes: ReadonlyMap<StyleChange["property"], StyleChange>,
  value: "before" | "after"
): string => {
  const declarations = STYLE_PROPERTIES.flatMap((property) => {
    const change = changes.get(property)
    return change === undefined ? [] : [`  ${property}: ${change[value]};`]
  })
  return `${selector} {\n${declarations.join("\n")}\n}`
}

export const handoffPrompt = (record: ChangeRecord): string => {
  const header = [
    "Apply these visual changes in the source code.",
    `Page: ${record.url}`,
    record.tailwind
      ? "Tailwind: detected; prefer utility classes"
      : "Tailwind: not detected"
  ]

  if (record.changes.length === 0) return [...header, "", "No visual changes."].join("\n")

  const elements = new Map<string, Map<StyleChange["property"], StyleChange>>()
  for (const change of record.changes) {
    const changes = elements.get(change.selector) ?? new Map<StyleChange["property"], StyleChange>()
    const prior = changes.get(change.property)
    changes.set(change.property, prior === undefined ? change : { ...prior, after: change.after })
    elements.set(change.selector, changes)
  }

  const sections = Array.from(elements, ([selector, changes]) => [
    `Selector: ${selector}`,
    `Source: ${sourceText(record.sources[selector])}`,
    "Before:",
    cssBlock(selector, changes, "before"),
    "After:",
    cssBlock(selector, changes, "after")
  ].join("\n"))

  return [...header, "", sections.join("\n\n")].join("\n")
}
