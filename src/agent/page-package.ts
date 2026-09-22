import { PAGE_DESIGN, PAGE_SCRIPT, PAGE_STYLE } from "../marketplace/compiler/page"
import type { PackageSource } from "../marketplace/compiler/source"
import { entryOf } from "../skin/compile"
import { isApplied, type Applied, type AppliedPages } from "./applied"
import { designCss, isDefault, type Design } from "./design"

/** The package a redesign publishes as, and the paths it covers. */
export interface PagePackage {
  readonly source: PackageSource
  /** Sorted, so the same redesign always describes the same release. */
  readonly paths: ReadonlyArray<string>
}

/** Where one page's files live in a package that carries several. */
export const PAGES_DIR = "pages"

/** One page of the package: where its files sit, and how the entry reaches them. */
interface Page {
  readonly path: string
  readonly applied: Applied
  /** The folder its files are under, and the module the entry imports. */
  readonly folder: string
  readonly entry: string
}

const entryFor = (skin: Applied["skin"]): string => {
  const entry = skin === undefined ? undefined : entryOf(skin)
  if (entry === undefined) throw new Error("the skin has no page.tsx, so it cannot be published")
  return entry
}

const add = (files: Record<string, string>, path: string, content: string): void => {
  if (Object.hasOwn(files, path)) throw new Error(`the skin file ${path} has the name of the package's ${path}`)
  files[path] = content
}

/** One page's own layout: the entry at the root, the way a single-page package has always looked. */
const onePage = (applied: Applied, files: Record<string, string>): string => {
  files[PAGE_STYLE] = applied.css ?? ""
  // The plain script is page.js in every layout: alone it is the entry, next to a skin it
  // runs after the skin, the way the two registrations run on the page.
  if (applied.script !== undefined) files[PAGE_SCRIPT] = applied.script
  const skin = applied.skin
  if (skin === undefined) return applied.script === undefined ? PAGE_STYLE : PAGE_SCRIPT
  const entry = entryFor(skin)
  for (const path of Object.keys(skin)) add(files, path, skin[path] ?? "")
  return entry
}

/**
 * A folder name for a path. It is a name, not an address: the paths themselves travel in
 * the release's scope, so this only has to be stable and unlike its neighbours.
 */
const folderOf = (path: string): string => {
  const name = path.replace(/^\//, "").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "")
  return name === "" ? "index" : name
}

/** Each skinned page, with the folder it goes in. Two paths that want one name are told apart by their order. */
const pagesOf = (live: ReadonlyArray<readonly [string, Applied]>): ReadonlyArray<Page> => {
  const taken = new Set<string>()
  const pages: Page[] = []
  for (const [path, applied] of live) {
    if (applied.skin === undefined) continue
    const wanted = folderOf(path)
    let folder = wanted
    for (let n = 2; taken.has(folder); n += 1) folder = `${wanted}-${n}`
    taken.add(folder)
    pages.push({ path, applied, folder, entry: entryFor(applied.skin) })
  }
  return pages
}

/** The module the generated entry imports a page by: its entry file, without the extension. */
const moduleOf = (page: Page): string => `./${PAGES_DIR}/${page.folder}/${page.entry.replace(/\.[^.]+$/, "")}`

/**
 * The entry of a package that carries several pages: it renders the page whose path the
 * reader is on, and passes on that page's `target` so the skin still replaces its region.
 * The kit renders the component with no props, so neither does this.
 */
const dispatchEntry = (pages: ReadonlyArray<Page>): string => `${pages
  .map((page, i) => `import * as page${i} from ${JSON.stringify(moduleOf(page))}`)
  .join("\n")}

const pages = [${pages.map((page, i) => `[${JSON.stringify(page.path)}, page${i}]`).join(", ")}]
const here = pages.find(([path]) => path === location.pathname)?.[1]

export const target = typeof here?.target === "string" ? here.target : undefined

export default function Page() {
  const Component = typeof here === "function" ? here : here?.default
  return typeof Component === "function" ? <Component /> : null
}
`

/** One page's stylesheet and persisted script, behind the path they belong to. */
const pageBlock = (path: string, applied: Applied): string => {
  const sheet =
    applied.css === undefined || applied.css === ""
      ? ""
      : `\nconst sheet = document.createElement("style")\nsheet.textContent = ${JSON.stringify(applied.css)}\ndocument.head.append(sheet)`
  const script = applied.script === undefined || applied.script === "" ? "" : `\n${applied.script}`
  return `if (location.pathname === ${JSON.stringify(path)}) {${sheet}${script}\n}`
}

/**
 * The plain script of a package that carries several pages. CSS cannot ask which path it
 * is on, so a page's own stylesheet travels here rather than in style.css, next to the
 * script that page persisted. Each block is a block: what one page declares is its own.
 */
const dispatchScript = (live: ReadonlyArray<readonly [string, Applied]>): string =>
  live
    .filter(([, applied]) => applied.css !== undefined || applied.script !== undefined)
    .map(([path, applied]) => pageBlock(path, applied))
    .join("\n")

/** Every page of a package that carries several, each under its own folder. */
const manyPages = (live: ReadonlyArray<readonly [string, Applied]>, files: Record<string, string>): string => {
  const pages = pagesOf(live)
  for (const page of pages) {
    const skin = page.applied.skin ?? {}
    for (const file of Object.keys(skin)) add(files, `${PAGES_DIR}/${page.folder}/${file}`, skin[file] ?? "")
  }
  // The pages share one stylesheet and one script, because the release has one of each and
  // the reader installs it on every path. Both know the path they are on; style.css cannot.
  files[PAGE_STYLE] = ""
  const script = dispatchScript(live)
  if (script !== "") files[PAGE_SCRIPT] = script
  if (pages.length === 0) return script === "" ? PAGE_STYLE : PAGE_SCRIPT
  files["page.tsx"] = dispatchEntry(pages)
  return "page.tsx"
}

/**
 * The page package a redesign publishes as: the thread's applied code, page by page, and
 * the site's design. `undefined` when the thread applied nothing, since there is nothing
 * to publish then.
 *
 * One page keeps the layout it always had, so a single-page release is byte for byte what
 * it was. Several pages each get a folder, and the entry chooses between them by path.
 */
export const pageSourceOf = (pages: AppliedPages, design: Design | undefined): PagePackage | undefined => {
  const [first, ...rest] = Object.entries(pages)
    .filter(([, applied]) => isApplied(applied))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  if (first === undefined) return undefined
  const live = [first, ...rest]
  const files: Record<string, string> = {}
  const entry = rest.length === 0 ? onePage(first[1], files) : manyPages(live, files)
  if (design !== undefined && !isDefault(design)) files[PAGE_DESIGN] = designCss(design)
  return { source: { entry, style: PAGE_STYLE, files }, paths: live.map(([path]) => path) }
}
