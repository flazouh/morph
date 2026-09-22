/** Shared Hugeicons import analysis and deterministic data selection. */
export type IconSet = Readonly<Record<string, unknown>>
export type Icons = () => Promise<IconSet>

export const ICONS_MODULE = "@hugeicons/core-free-icons"

const ICON_IMPORT =
  /import\s*\{([^}]*)\}\s*from\s*(['"])@hugeicons\/core-free-icons\2/g
const ICON_OTHER_IMPORT =
  /(?:\bimport\s*(?:\(|(?:(?!\bfrom\b)[\s\S])*?\bfrom\s*)|\bexport\s+(?:(?!\bfrom\b)[\s\S])*?\bfrom\s*|\brequire\s*\()\s*["']@hugeicons\/core-free-icons["']/

export const iconImports = (tsx: string): ReadonlyArray<string> => [
  ...new Set(
    Array.from(tsx.matchAll(ICON_IMPORT)).flatMap((match) =>
      (match[1] ?? "")
        .split(",")
        .map((part) => part.trim().split(/\s+as\s+/)[0]?.trim() ?? "")
        .filter((name) => name !== "")
    )
  )
]

export const hasUnsupportedIconImport = (tsx: string): boolean =>
  ICON_OTHER_IMPORT.test(tsx.replace(ICON_IMPORT, ""))

const MAX_SUGGESTIONS = 6

const suggest = (
  name: string,
  set: IconSet
): ReadonlyArray<string> => {
  const stem = name
    .replace(/Icon$/, "")
    .replace(/\d+$/, "")
    .toLowerCase()
  if (stem === "") return []
  return Object.keys(set)
    .filter((key) => key.toLowerCase().startsWith(stem))
    .slice(0, MAX_SUGGESTIONS)
}

export const iconHints = (
  names: ReadonlyArray<string>,
  set: IconSet
): ReadonlyArray<string> =>
  names
    .filter((name) => !Object.hasOwn(set, name))
    .map((name) => {
      const near = suggest(name, set)
      return near.length === 0
        ? `${name} (no icon by that stem)`
        : `${name} (near: ${near.join(", ")})`
    })

export const pickIcons = (
  names: ReadonlyArray<string>,
  set: IconSet
): Readonly<Record<string, unknown>> =>
  Object.fromEntries(
    [...names].sort().map((name) => [name, set[name]])
  )
