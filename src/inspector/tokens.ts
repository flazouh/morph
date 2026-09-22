/**
 * The page's own design tokens: color-valued custom properties declared on `:root` or
 * `html`, so the color controls can offer them as choices. An alias that only points at
 * another root token (`--alias: var(--brand)`) resolves through to that token's color.
 * The walk recurses into any grouping rule (`@media`, `@supports`, `@container`, `@layer`),
 * because each one exposes the same `cssRules` shape.
 */

export interface ColorToken {
  readonly name: string
  readonly value: string
}

interface RuleLike {
  readonly selectorText?: string
  readonly style?: {
    readonly length: number
    item(index: number): string | undefined
    getPropertyValue(name: string): string
  }
  readonly cssRules?: ArrayLike<RuleLike>
}

type IsColor = (value: string) => boolean

const ROOT_SELECTORS = new Set([":root", "html"])

/** True for `:root`, `html`, and selector lists that include either, such as `:root, html`. */
const isRootSelector = (selectorText: string | undefined): boolean => {
  if (selectorText === undefined) return false
  return selectorText.split(",").some((part) => ROOT_SELECTORS.has(part.trim().toLowerCase()))
}

const collectDeclarations = (style: RuleLike["style"], into: Map<string, string>): void => {
  if (style === undefined) return
  for (let index = 0; index < style.length; index += 1) {
    const name = style.item(index)
    if (name === undefined || !name.startsWith("--")) continue
    const value = style.getPropertyValue(name).trim()
    if (value.length === 0) continue
    into.set(name, value)
  }
}

/**
 * Collects every custom property declared on a `:root`/`html` rule, recursing through
 * grouping rules. Raw values are kept as declared (including `var(...)` references), so
 * alias resolution can happen in a second pass once every root declaration is known.
 */
const collectRootDeclarations = (rules: ArrayLike<RuleLike> | undefined, into: Map<string, string>): void => {
  if (rules === undefined) return
  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index]
    if (rule === undefined) continue
    if (rule.style !== undefined && isRootSelector(rule.selectorText)) {
      collectDeclarations(rule.style, into)
    }
    collectRootDeclarations(rule.cssRules, into)
  }
}

const VAR_REFERENCE = /^var\(\s*(--[\w-]+)\s*(?:,[\s\S]*)?\)$/

/** Resolves a declared value to a color: follows a bare `var(--other)` alias, with cycle protection. */
const resolveColor = (
  name: string,
  raw: ReadonlyMap<string, string>,
  isColor: IsColor,
  seen: ReadonlySet<string>
): string | null => {
  if (seen.has(name)) return null
  const value = raw.get(name)
  if (value === undefined) return null
  const reference = value.match(VAR_REFERENCE)
  if (reference !== null) {
    return resolveColor(reference[1]!, raw, isColor, new Set(seen).add(name))
  }
  if (value.includes("var(")) return null // a var() inside a larger expression, not a bare alias
  return isColor(value) ? value : null
}

const alwaysColor: IsColor = () => true

/** Every declared name that resolves to a color, in declaration order. */
const resolveTokens = (
  raw: ReadonlyMap<string, string>,
  isColor: IsColor
): ReadonlyArray<ColorToken> => {
  const found: Array<ColorToken> = []
  for (const name of raw.keys()) {
    const value = resolveColor(name, raw, isColor, new Set())
    if (value !== null) found.push({ name, value })
  }
  return found
}


/**
 * The recursive walk plus alias resolution, for callers that already have a rule list.
 * Exported so the recursion into grouping rules (`@layer`, `@media`, and any future
 * at-rule with the same shape) is testable without going through a real CSS parser.
 */
export const scanRulesForColorTokens = (
  rules: ArrayLike<RuleLike> | undefined,
  isColor: IsColor = alwaysColor
): ReadonlyArray<ColorToken> => {
  const raw = new Map<string, string>()
  collectRootDeclarations(rules, raw)
  return resolveTokens(raw, isColor)
}

/** A page's own `:root`/`html` stylesheet rules, walked for color-valued custom properties. */
export const scanColorTokens = (doc: Document): ReadonlyArray<ColorToken> => {
  const probe = doc.createElement("span")
  const isColor: IsColor = (value) => {
    probe.style.color = ""
    try {
      probe.style.color = value
    } catch {
      return false
    }
    return probe.style.color !== ""
  }

  const raw = new Map<string, string>()
  for (const sheet of Array.from(doc.styleSheets)) {
    try {
      collectRootDeclarations(sheet.cssRules as unknown as ArrayLike<RuleLike>, raw)
    } catch {
      // A cross-origin sheet throws reading its rules. Skip it, keep the rest.
    }
  }
  return resolveTokens(raw, isColor)
}
