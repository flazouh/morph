/**
 * Return each whitespace-separated word inside source string literals.
 *
 * Tailwind drops words that are not utilities. This scanner includes literals inside
 * nested template expressions so dynamic class choices remain visible to the compiler.
 */
export const candidatesOf = (source: string): ReadonlyArray<string> => {
  const seen = new Set<string>()
  const words = (text: string): void => {
    for (const word of text.split(/\s+/)) {
      if (word !== "") seen.add(word)
    }
  }

  const quoted = (index: number, quote: string): number => {
    let text = ""
    while (
      index < source.length &&
      source[index] !== quote &&
      source[index] !== "\n"
    ) {
      if (source[index] === "\\") index++
      text += source[index] ?? ""
      index++
    }
    words(text)
    return index + 1
  }

  const template = (index: number): number => {
    let text = ""
    while (index < source.length && source[index] !== "`") {
      if (source[index] === "\\") {
        text += source[index + 1] ?? ""
        index += 2
      } else if (source.startsWith("${", index)) {
        words(text)
        text = ""
        index = expression(index + 2)
      } else {
        text += source[index] ?? ""
        index++
      }
    }
    words(text)
    return index + 1
  }

  const expression = (start: number): number => {
    let index = start
    let depth = 1
    while (index < source.length && depth > 0) {
      const character = source[index] ?? ""
      if (character === "{") depth++
      else if (character === "}") depth--
      if (depth === 0) return index + 1
      index =
        character === '"' || character === "'"
          ? quoted(index + 1, character)
          : character === "`"
            ? template(index + 1)
            : index + 1
    }
    return index
  }

  expression(0)
  return [...seen]
}
