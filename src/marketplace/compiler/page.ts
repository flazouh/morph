/**
 * How a redesign made on a page becomes a `script-v1` package.
 *
 * A sandbox package is a program the sandbox runs. A page package is what the extension
 * already puts on a page: one stylesheet, and one script that re-runs on load, which is a
 * skin the kit renders or plain JavaScript. So its source is the redesign's own files,
 * and its build is the build the page ran: the skin compiler for the TSX, the page script
 * around it, and the site's design tokens ahead of the page's stylesheet.
 *
 * Both sides of a release run this: the extension to say what it built, the server to
 * build the same bytes from the same source and refuse a submission that describes other
 * ones. Nothing here reads a clock, a random number or an environment, so the same source
 * and the same ports give the same digests on both.
 */
import { skinScript } from "../../kit/skin-script"
import {
  CompileFailure,
  compileSkin,
  ENTRIES as SKIN_ENTRIES,
  extrasOf,
  type Icons,
  type Sheets,
  type SkinFiles
} from "../../skin/compile"
import { COMPILER, PACKAGE_COMPILE_LIMITS, type CompiledPackage } from "./compile"
import { digestOf, digestsOf } from "./digest"
import { messageOf, PackageCompileError } from "./error"
import { canonicalPath, isScript, PACKAGE_SOURCE_LIMITS, type PackageSource } from "./source"

/** The compiler that made a page artifact: the skin compiler's versions, under the page's name. */
export const PAGE_COMPILER = COMPILER.replace(/^morph-compiler-1/, "morph-page-compiler-1")

/** The page's stylesheet, the one file every page package has. */
export const PAGE_STYLE = "style.css"
/** The site's design tokens, when the redesign set any. Ahead of the page's own rules. */
export const PAGE_DESIGN = "design.css"
/** The one plain-JavaScript entry: `run_script` with persist, published as it ran. */
export const PAGE_SCRIPT = "page.js"

const CSS_FILES: ReadonlyArray<string> = [PAGE_STYLE, PAGE_DESIGN]

const refuse = (message: string, file?: string): never => {
  throw new PackageCompileError(message, { reason: "source", ...(file === undefined ? {} : { file }) })
}

/** The skin's own files: every file of the package that is not one of its stylesheets. */
export const skinFilesOf = (source: PackageSource): SkinFiles =>
  Object.fromEntries(Object.entries(source.files).filter(([path]) => !CSS_FILES.includes(path) && path !== PAGE_SCRIPT))

/**
 * The page source contract, checked. A page package is a skin (`page.tsx` and its files,
 * with a `page.js` that runs after it when the thread persisted one), a script (`page.js`
 * alone) or a stylesheet alone (`style.css` as the entry), always with `style.css`, and
 * `design.css` when the site has a design.
 */
export const checkPageSource = (source: PackageSource): PackageSource => {
  const paths = Object.keys(source.files)
  if (paths.length === 0) refuse("the package has no files")
  if (paths.length > PACKAGE_SOURCE_LIMITS.files) {
    refuse(`the package can contain at most ${PACKAGE_SOURCE_LIMITS.files} files; it contains ${paths.length}`)
  }
  let totalBytes = 0
  for (const path of paths) {
    if (!canonicalPath(path)) refuse(`${JSON.stringify(path)} is not a package-relative path`, path)
    if (!isScript(path) && path !== PAGE_SCRIPT && !CSS_FILES.includes(path)) {
      refuse(`${path} is not a page package file; a page package is page.tsx and its .ts and .tsx files, or page.js, with style.css and design.css`, path)
    }
    const bytes = new TextEncoder().encode(source.files[path] ?? "").byteLength
    if (bytes > PACKAGE_SOURCE_LIMITS.fileBytes) {
      refuse(`${path} can contain at most ${PACKAGE_SOURCE_LIMITS.fileBytes} bytes; it contains ${bytes}`, path)
    }
    totalBytes += bytes
    if (totalBytes > PACKAGE_SOURCE_LIMITS.totalBytes) {
      refuse(`the package source can contain at most ${PACKAGE_SOURCE_LIMITS.totalBytes} bytes`)
    }
  }
  if (source.style !== PAGE_STYLE) refuse(`the page stylesheet is ${PAGE_STYLE}, not ${JSON.stringify(source.style)}`, source.style)
  if (!Object.hasOwn(source.files, PAGE_STYLE)) refuse(`the package has no ${PAGE_STYLE}`, PAGE_STYLE)
  if (!Object.hasOwn(source.files, source.entry)) {
    refuse(`the package entry ${JSON.stringify(source.entry)} is not one of its files: ${paths.join(", ")}`, source.entry)
  }
  const scripts = paths.filter((path) => isScript(path) || path === PAGE_SCRIPT)
  if (source.entry === PAGE_SCRIPT) {
    if (scripts.length !== 1) refuse(`a ${PAGE_SCRIPT} package has no other script files; it has ${scripts.join(", ")}`, PAGE_SCRIPT)
  } else if (source.entry === PAGE_STYLE) {
    if (scripts.length !== 0) refuse(`a stylesheet package has no script files; it has ${scripts.join(", ")}`)
  } else if (!SKIN_ENTRIES.includes(source.entry)) {
    refuse(`the package entry ${source.entry} must be ${SKIN_ENTRIES.join(", ")}, ${PAGE_SCRIPT} or ${PAGE_STYLE}`, source.entry)
  }
  return source
}

/**
 * One id for one source, before any compile: the digest of the entry, the stylesheet name
 * and every file in path order. The release authorization pins this, so what the reader
 * confirmed is what gets published, byte for byte.
 */
export const pageSourceId = (source: PackageSource): Promise<string> =>
  digestOf(
    JSON.stringify({
      entry: source.entry,
      style: source.style,
      files: Object.keys(source.files).sort().map((path) => [path, source.files[path]])
    })
  )

export interface PageCompilerPorts {
  readonly sheets: Sheets
  readonly icons: Icons
}

const skinArtifact = async (source: PackageSource, ports: PageCompilerPorts): Promise<string> => {
  try {
    const out = await compileSkin(skinFilesOf(source), ports.sheets, ports.icons)
    return skinScript(out.js, out.css, extrasOf(out))
  } catch (cause) {
    if (cause instanceof CompileFailure) throw new PackageCompileError(cause.message, { reason: "source" })
    throw cause
  }
}

/**
 * The one script the page runs, by what the entry is. A skin package may carry a page.js
 * too: the plain script the thread persisted next to the skin, run after it, the way the
 * two registrations run on the page.
 */
const scriptOf = async (source: PackageSource, ports: PageCompilerPorts): Promise<string> => {
  if (source.entry === PAGE_SCRIPT) return source.files[PAGE_SCRIPT] ?? ""
  if (source.entry === PAGE_STYLE) return ""
  const skin = await skinArtifact(source, ports)
  const after = source.files[PAGE_SCRIPT]
  return after === undefined || after === "" ? skin : `${skin}\n${after}`
}

/** The design first, so the page's rules come after the tokens they read. */
const styleOf = (source: PackageSource): string =>
  [source.files[PAGE_DESIGN], source.files[PAGE_STYLE]]
    .filter((css): css is string => css !== undefined && css !== "")
    .join("\n")

/**
 * Source in; the page script, the page stylesheet and the digests of all three out, or one
 * `PackageCompileError`. The script is the exact text the extension ran on the page, the
 * kit call included, so a reader who installs the release gets the page the creator saw.
 */
export const compilePagePackage = async (input: PackageSource, ports: PageCompilerPorts): Promise<CompiledPackage> => {
  const source = checkPageSource(input)
  let script: string
  try {
    script = await scriptOf(source, ports)
  } catch (cause) {
    if (cause instanceof PackageCompileError) throw cause
    throw new PackageCompileError(messageOf(cause), { reason: "source" })
  }
  const scriptBytes = new TextEncoder().encode(script).byteLength
  if (scriptBytes > PACKAGE_COMPILE_LIMITS.scriptBytes) {
    throw new PackageCompileError(
      `the compiled script can contain at most ${PACKAGE_COMPILE_LIMITS.scriptBytes} bytes; it contains ${scriptBytes}`,
      { reason: "source" }
    )
  }
  const style = styleOf(source)
  const styleBytes = new TextEncoder().encode(style).byteLength
  if (styleBytes > PACKAGE_COMPILE_LIMITS.styleBytes) {
    throw new PackageCompileError(
      `the compiled stylesheet can contain at most ${PACKAGE_COMPILE_LIMITS.styleBytes} bytes; it contains ${styleBytes}`,
      { reason: "style", file: PAGE_STYLE }
    )
  }
  const [sources, scriptDigest, cssDigest] = await Promise.all([digestsOf(source.files), digestOf(script), digestOf(style)])
  return { compiler: PAGE_COMPILER, script, style, sources, artifacts: { script: scriptDigest, css: cssDigest } }
}
