const identifier = String.raw`(?:\\(?:[0-9a-fA-F]{1,6} ?|.)|[-_a-zA-Z0-9\u0080-\uFFFF])+`
const anchorPattern = String.raw`(?:#${identifier}|\[data-testid="${identifier}"\])`
const segmentPattern = String.raw`[a-z][a-z0-9-]*(?:\.${identifier})*(?::nth-of-type\([1-9][0-9]*\))?`
const generatedSelector = new RegExp(
  String.raw`^(?:${anchorPattern}(?: > ${segmentPattern})*|${segmentPattern}(?: > ${segmentPattern})*)$`
)

/**
 * True for a selector shaped like `stableSelector` output. This module owns that grammar:
 * the preview CSS writer reads it here instead of keeping a second copy that can drift.
 */
export const isGeneratedSelector = (selector: string): boolean => generatedSelector.test(selector)

const escapeIdentifier = (value: string): string => {
  const nativeEscape = globalThis.CSS?.escape
  if (nativeEscape !== undefined) return nativeEscape(value)

  return Array.from(value, (character, index) => {
    const code = character.codePointAt(0) ?? 0
    if (code === 0) return "\uFFFD"
    if (
      (code >= 1 && code <= 31) ||
      code === 127 ||
      (index === 0 && code >= 48 && code <= 57) ||
      (index === 1 && code >= 48 && code <= 57 && value.charAt(0) === "-")
    ) {
      return `\\${code.toString(16)} `
    }
    if (index === 0 && character === "-" && value.length === 1) return "\\-"
    if (code >= 128 || character === "-" || character === "_" || /[a-zA-Z0-9]/.test(character)) {
      return character
    }
    return `\\${character}`
  }).join("")
}

const unique = (document: Document, selector: string): boolean => {
  try {
    return document.querySelectorAll(selector).length === 1
  } catch {
    return false
  }
}

const anchorFor = (element: Element, document: Document): string | null => {
  if (element.id.length > 0) {
    const selector = `#${escapeIdentifier(element.id)}`
    if (unique(document, selector)) return selector
  }

  const testId = element.getAttribute("data-testid")
  if (testId !== null && testId.length > 0) {
    const selector = `[data-testid="${escapeIdentifier(testId)}"]`
    if (unique(document, selector)) return selector
  }

  return null
}

const segmentFor = (element: Element): string => {
  const tag = element.tagName.toLowerCase()
  const classes = Array.from(element.classList, escapeIdentifier).map((name) => `.${name}`).join("")
  const base = `${tag}${classes}`
  const parent = element.parentElement
  if (parent === null) return base

  const matchingSiblings = Array.from(parent.children).filter((sibling) => sibling.matches(base))
  if (matchingSiblings.length <= 1) return base

  const sameTag = Array.from(parent.children).filter((sibling) => sibling.tagName === element.tagName)
  return `${base}:nth-of-type(${sameTag.indexOf(element) + 1})`
}

export const stableSelector = (element: Element, document: Document): string => {
  if (element === document.body) return "body"
  if (element === document.documentElement) return "html"

  const parts: Array<string> = []
  let current: Element | null = element

  while (current !== null && current !== document.body && current !== document.documentElement) {
    const anchor = anchorFor(current, document)
    if (anchor !== null) return [anchor, ...parts].join(" > ")
    parts.unshift(segmentFor(current))
    current = current.parentElement
  }

  return parts.join(" > ")
}

const tailwindUtility = /^(?:[a-z-]+:)*(?:-?(?:m|mx|my|mt|mr|mb|ml|p|px|py|pt|pr|pb|pl|gap|space-[xy]|w|h|min-w|min-h|max-w|max-h|text|font|leading|tracking|bg|border|rounded|shadow|opacity|flex|grid|block|inline|hidden|items|justify|content|self|place-\w+|order|grow|shrink|basis|overflow|object|z|inset|top|right|bottom|left|translate-[xy]|rotate|scale|cursor|select|pointer-events|transition|duration|ease|delay)(?:-.+)?|flex|grid|block|inline|hidden)$/

export const detectTailwind = (element: Element): boolean => {
  let matches = 0
  let current: Element | null = element

  while (current !== null) {
    for (const name of current.classList) {
      if (tailwindUtility.test(name)) matches += 1
      if (matches >= 2) return true
    }
    current = current.parentElement
  }

  return false
}
