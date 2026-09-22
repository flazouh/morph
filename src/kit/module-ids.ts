/**
 * What a compiled skin may `require`, by id. The table of values is in modules.ts and
 * pulls in React and the components; this list is the light half, so the compiler can
 * refuse an unknown import without loading them.
 */
export const MODULE_IDS = [
  "react",
  "react/jsx-runtime",
  "react-dom",
  "motion/react",
  "beui",
  "@hugeicons/react",
  "@hugeicons/core-free-icons"
] as const

/**
 * The icon set is 14,000 named exports; the page gets only the icons a skin imports. The
 * compiler inlines them into the skin script, where they arrive as this module's extras.
 */
export const ICONS_MODULE = "@hugeicons/core-free-icons"

/**
 * The whole set as one JSON file of the build, at the output root. The compiler fetches
 * it, because it runs in the service worker for a Cursor run and Chrome refuses a dynamic
 * `import()` there.
 */
export const ICONS_ASSET = "hugeicons.json"

export type ModuleId = (typeof MODULE_IDS)[number]

export const isModuleId = (id: string): id is ModuleId => (MODULE_IDS as ReadonlyArray<string>).includes(id)
