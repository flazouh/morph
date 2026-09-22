import { compile } from "tailwindcss"
import { ICONS_MODULE, MODULE_IDS, isModuleId } from "../kit/module-ids"
import type { SkinExtras } from "../kit/skin-script"
import { bindModules, type BoundModule, isRelative, requiredIds, resolveFile, transformSource } from "../compiler/bundle"
import { candidatesOf } from "../compiler/candidates"
import { iconHints, iconImports, pickIcons } from "../compiler/icons"

/**
 * A skin is a small TSX project the model writes: a page component on beUI and Tailwind,
 * with its own components and data readers in files of their own, as a developer would
 * write it. The browser cannot run that, so the panel compiles it here, once, at write
 * time: sucrase strips the types and the JSX and turns the imports into `require` calls;
 * the files are bound into one CommonJS body whose relative requires resolve among them
 * and whose bare requires the kit answers; Tailwind builds the CSS for the classes the
 * sources use, on the design tokens. What reaches the page is plain JS and plain CSS;
 * what reaches the repo is the sources.
 */

/** The skin's sources, by path relative to the page's folder: `page.tsx`, `components/Story.tsx`, `data.ts`. */
export type SkinFiles = Readonly<Record<string, string>>

/** The file the page renders: `page.tsx`; `skin.tsx` for a skin written as one file. */
export const ENTRIES: ReadonlyArray<string> = ["page.tsx", "skin.tsx"]

export const entryOf = (files: SkinFiles): string | undefined => {
  const paths = Object.keys(files)
  return ENTRIES.find((e) => paths.includes(e)) ?? (paths.length === 1 ? paths[0] : undefined)
}

/** The stylesheets Tailwind needs, by the name the skin sheet imports them under. */
export type Sheets = Readonly<
  Record<"tailwindcss/theme.css" | "tailwindcss/preflight.css" | "tailwindcss/utilities.css" | "theme.css" | "shadow.css", string>
>

/** The whole icon set, by export name, loaded when a skin first imports from it. */
export type IconSet = Readonly<Record<string, unknown>>
export type Icons = () => Promise<IconSet>

export interface Compiled {
  /** A CommonJS body: `require`, `exports` and `module` are its free names. */
  readonly js: string
  readonly css: string
  /** The icons the skin imports, by export name, for the page's modules (see ICONS_MODULE). */
  readonly icons: Readonly<Record<string, unknown>>
}

/** Per-module additions a compiled skin carries onto the page. */
export const extrasOf = (out: Compiled): SkinExtras => (Object.keys(out.icons).length === 0 ? {} : { [ICONS_MODULE]: out.icons })

/** Why a skin did not compile, in words the model can act on. */
export class CompileFailure extends Error {
  readonly _tag = "CompileFailure"
  constructor(message: string) {
    super(message)
  }
}

/**
 * The skin's own stylesheet, adopted into its shadow root: the sheet every shadow root
 * wears, plus preflight, because the skin is a fresh page shell, not a widget on the host's.
 */
const SHEET = `@import "shadow.css";
@import "tailwindcss/preflight.css" layer(base);
`

const loadStylesheet = (sheets: Sheets) => async (id: string, base: string) => {
  const key = id.replace(/^\.\//, "")
  const content = (sheets as Readonly<Record<string, string | undefined>>)[key]
  if (content === undefined) throw new Error(`the skin sheet cannot import ${id}`)
  return { path: id, base, content }
}

export const buildCss = async (candidates: ReadonlyArray<string>, sheets: Sheets): Promise<string> => {
  const compiler = await compile(SHEET, {
    base: "/",
    loadStylesheet: loadStylesheet(sheets),
    loadModule: (id) => Promise.reject(new Error(`the skin sheet cannot load ${id}`))
  })
  return compiler.build([...candidates])
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** The set, or a CompileFailure that says the set is what failed, with the loader's reason. */
const loadIcons = async (icons: Icons): Promise<IconSet> => {
  try {
    return await icons()
  } catch (e) {
    throw new CompileFailure(`the icon set did not load, so no skin can import from ${ICONS_MODULE} right now: ${message(e)}`)
  }
}

/**
 * The icons a skin imports, looked up in the set. A name that is not in the set is a
 * CompileFailure that offers the near ones, so the model corrects the import in one round.
 */
const iconsFor = async (tsx: string, icons: Icons): Promise<Readonly<Record<string, unknown>>> => {
  const names = iconImports(tsx)
  if (names.length === 0) return {}
  const set = await loadIcons(icons)
  const hints = iconHints(names, set)
  if (hints.length > 0) {
    throw new CompileFailure(`${ICONS_MODULE} has no ${hints.join("; ")}. Names are PascalCase and end in Icon, most with a two-digit variant: Search01Icon, ArrowRight01Icon.`)
  }
  return pickIcons(names, set)
}

/**
 * One file through sucrase, its requires checked: a relative id must name a file of the
 * skin, a bare id must be a module the kit has.
 */
const compileFile = (files: SkinFiles, path: string): BoundModule => {
  const source = files[path] ?? ""
  let js: string
  try {
    js = transformSource(path, source)
  } catch (e) {
    throw new CompileFailure(`${path} does not compile: ${message(e)}`)
  }
  const ids = requiredIds(js)
  const links: Record<string, string> = {}
  const unknown: Array<string> = []
  for (const id of ids) {
    if (isRelative(id)) {
      const found = resolveFile(files, path, id)
      if (found === undefined) unknown.push(id)
      else links[id] = found
    } else if (!isModuleId(id)) unknown.push(id)
  }
  if (unknown.length > 0) {
    throw new CompileFailure(
      `${path} imports ${unknown.map((id) => JSON.stringify(id)).join(", ")}; the skin's files are ${Object.keys(files).join(", ")}, and a skin may import ${MODULE_IDS.join(", ")}`
    )
  }
  return { path, js, links }
}

/**
 * Sources in; one CommonJS body, its CSS and its icons out, or a CompileFailure. Whether
 * the entry exports a component is the kit's to judge at load, where the real exports are
 * in hand: sucrase writes the export in more than one shape, and a guess here refused
 * correct modules once.
 */
export const compileSkin = async (files: SkinFiles, sheets: Sheets, icons: Icons): Promise<Compiled> => {
  const entry = entryOf(files)
  if (entry === undefined) throw new CompileFailure(`the skin needs a page.tsx, the file the page renders; the files sent are ${Object.keys(files).join(", ") || "none"}`)
  const modules = Object.keys(files).map((path) => compileFile(files, path))
  const sources = Object.values(files).join("\n")
  const inlined = await iconsFor(sources, icons)
  try {
    return { js: bindModules(modules, entry), css: await buildCss(candidatesOf(sources), sheets), icons: inlined }
  } catch (e) {
    throw new CompileFailure(`the skin's Tailwind classes do not build: ${message(e)}`)
  }
}
