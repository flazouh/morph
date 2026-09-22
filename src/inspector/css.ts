import { STYLE_PROPERTIES } from "./model"
import type { ChangeRecord, StyleChange } from "./model"
import { isGeneratedSelector } from "./selector"

/** The `<style>` element id every applied-change sheet writes to and reads back from. */
export const INSPECTOR_SHEET_ID = "redesign-inspector-styles"

/**
 * A CSS declaration value is safe to write into a rule body when it cannot close the
 * declaration or the rule early. `;`, `{`, and `}` are the three characters a value needs
 * to break out of `property: value;` and inject its own rule or declaration.
 */
export const isSafeCssValue = (value: string): boolean => !/[;{}]/.test(value)

export const cssFor = (record: ChangeRecord): string => {
  const groups = new Map<string, Map<StyleChange["property"], string>>()

  for (const change of record.changes) {
    if (!isGeneratedSelector(change.selector) || !isSafeCssValue(change.after)) continue
    const declarations = groups.get(change.selector) ?? new Map()
    declarations.set(change.property, change.after)
    groups.set(change.selector, declarations)
  }

  return Array.from(groups, ([selector, declarations]) => {
    const lines = STYLE_PROPERTIES.flatMap((property) => {
      const value = declarations.get(property)
      return value === undefined ? [] : [`  ${property}: ${value} !important;`]
    })
    return `${selector} {\n${lines.join("\n")}\n}`
  }).join("\n\n")
}
