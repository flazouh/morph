/**
 * The one way a Morph package becomes something a sandbox can run.
 *
 * A package is source, not a build. The author writes TypeScript and one stylesheet; the
 * compiler turns them into `script.js` and `style.css` and says exactly what it made, by
 * digest, so the extension, the publisher and the server can each rebuild the same bytes
 * and compare them. That is the whole reason this exists in one function: a release is
 * only trustworthy if the artifact a reader installs is the artifact anybody else gets
 * from the same source.
 *
 * It runs in the extension. There is no filesystem, no network and no package manager
 * here: sucrase and Tailwind both run in the browser, the imports a package may make are
 * the ones the runtime already lends it, and the icon set is read through a port. A
 * package that needs anything else is refused rather than half-built.
 */
import {
  bindModules,
  type BoundModule,
  isRelative,
  leavesPackage,
  requiredIds,
  resolveFile,
  transformSource
} from "../../compiler/bundle"
import { digestOf, digestsOf } from "./digest"
import { messageOf, PackageCompileError } from "./error"
import {
  hasUnsupportedIconImport,
  ICONS_MODULE,
  type Icons,
  iconHints,
  iconImports,
  pickIcons
} from "../../compiler/icons"
import { checkSource, isScript, type PackageSource } from "./source"
import { candidatesOf } from "../../compiler/candidates"
import { buildStyle } from "./styles"

export type { PackageSource } from "./source"
export { PackageCompileError } from "./error"

/**
 * The compiler that made an artifact, written into every release.
 *
 * A published package records it, so a rebuild that disagrees can say whether the source
 * changed or the compiler did. It changes whenever the bytes this file writes for
 * unchanged source would change.
 */
export const COMPILER =
  "morph-compiler-1+sucrase-3.35.1.tailwindcss-4.3.3.hugeicons-4.3.0"

export const PACKAGE_COMPILE_LIMITS = {
  candidates: 5_000,
  scriptBytes: 2_500_000,
  styleBytes: 1_000_000
} as const

export interface CompilerPorts {
  /**
   * The bare module ids the runtime hands the artifact at load, and therefore the only
   * ones a package may import. The sandbox's list lives in `sandbox/lentModules.ts`; the
   * compiler takes it as a port so it holds no opinion about which runtime it serves.
   */
  readonly lent: ReadonlyArray<string>
  /** The stylesheets the runtime lends, by the name a package imports them under. */
  readonly sheets: Readonly<Record<string, string>>
  /** The icon set, loaded only when a package imports from it. */
  readonly icons: Icons
}

export interface CompiledPackage {
  readonly compiler: string
  /** A body the sandbox runs with `require`, `exports`, `module` and `morph` in scope. */
  readonly script: string
  readonly style: string
  /** Every source file by path, with the digest of its bytes, in path order. */
  readonly sources: Readonly<Record<string, string>>
  /** The digests of the two artifacts, in the shape a manifest and the installer use. */
  readonly artifacts: {
    readonly script: string
    readonly css: string
  }
}

/**
 * Node's own modules, named so the refusal can say what is wrong rather than "unknown
 * import". A package runs in a frame in a browser; `fs` there is not a missing dependency,
 * it is a misunderstanding about where the code runs.
 */
const NODE_MODULES = new Set([
  "assert", "buffer", "child_process", "cluster", "console", "crypto", "dns", "events", "fs", "http", "http2",
  "https", "module", "net", "os", "path", "process", "punycode", "querystring", "readline", "stream",
  "string_decoder", "timers", "tls", "tty", "url", "util", "v8", "vm", "worker_threads", "zlib"
])

const refuse = (message: string, file: string, id?: string): never => {
  throw new PackageCompileError(message, { reason: "import", file, ...(id === undefined ? {} : { id }) })
}

/**
 * The sandbox's half of the contract, written onto the end of the body.
 *
 * The guest builds the artifact with `Function("require", "exports", "module", "morph", code)`
 * and forks whatever the call returns, so a package entry exports `start` and the artifact
 * hands it the `morph` it was given. Every sandbox package ends this way, which is why it
 * is the compiler's line and not something an author remembers to write.
 */
const SANDBOX_TAIL = "\nreturn module.exports.start(morph);\n"

/** The stylesheet as a module: it exists so `import "./style.css"` resolves, and does nothing. */
const STYLE_MODULE = "/* the package stylesheet ships as style.css */"

interface Bound {
  readonly modules: ReadonlyArray<BoundModule>
  readonly iconNames: ReadonlyArray<string>
}

const bindOne = (source: PackageSource, ports: CompilerPorts, path: string): BoundModule => {
  const text = source.files[path] ?? ""
  if (hasUnsupportedIconImport(text)) {
    throw new PackageCompileError(
      `${path} imports ${ICONS_MODULE} in a form the compiler cannot inline; use named imports`,
      { reason: "icon", file: path, id: ICONS_MODULE }
    )
  }
  let js: string
  try {
    js = transformSource(path, text)
  } catch (cause) {
    throw new PackageCompileError(`${path} does not compile: ${messageOf(cause)}`, { reason: "syntax", file: path })
  }
  if (
    path === source.entry &&
    !/\bexports(?:\.start|\[["']start["']\])\s*=/.test(js)
  ) {
    throw new PackageCompileError(
      `${path} must export start, the function the sandbox calls`,
      { reason: "source", file: path }
    )
  }
  if (js.includes("import.meta")) {
    refuse(
      `${path} reads import.meta; the sandbox runs a package as a function body, where import.meta cannot be written, and a package has no build to read it from`,
      path
    )
  }
  const links: Record<string, string> = {}
  for (const id of requiredIds(js)) {
    if (isRelative(id)) {
      if (leavesPackage(path, id)) {
        refuse(`${path} imports ${JSON.stringify(id)}, which leaves the package`, path, id)
      }
      const found =
        resolveFile(source.files, path, id) ??
        refuse(`${path} imports ${JSON.stringify(id)}, and the package has no such file`, path, id)
      if (found.endsWith(".css") && found !== source.style) {
        refuse(`${path} imports ${JSON.stringify(id)}; a package has one stylesheet and it is ${source.style}`, path, id)
      }
      links[id] = found
      continue
    }
    if (id === ICONS_MODULE) continue
    if (id.startsWith("node:") || NODE_MODULES.has(id)) {
      refuse(`${path} imports ${JSON.stringify(id)}; a package runs in a browser frame and has none of Node`, path, id)
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(id) || id.startsWith("//")) {
      refuse(`${path} imports ${JSON.stringify(id)}; a package cannot load code from an address`, path, id)
    }
    if (id.startsWith("/")) {
      refuse(`${path} imports ${JSON.stringify(id)}; a package imports its own files by relative path`, path, id)
    }
    if (!ports.lent.includes(id)) {
      refuse(
        `${path} imports ${JSON.stringify(id)}, which the runtime does not lend; a package may import ${[...ports.lent, ICONS_MODULE].join(", ")} and its own files`,
        path,
        id
      )
    }
  }
  return { path, js, links }
}

/** Every source file compiled and checked, in path order, with the icons they ask for. */
const bindAll = (source: PackageSource, ports: CompilerPorts): Bound => {
  const paths = Object.keys(source.files).sort()
  const modules = paths
    .filter((path) => isScript(path))
    .map((path) => bindOne(source, ports, path))
  return {
    modules: [...modules, { path: source.style, js: STYLE_MODULE, links: {} }],
    iconNames: [...new Set(paths.flatMap((path) => iconImports(source.files[path] ?? "")))].sort()
  }
}

const inlinedIcons = async (names: ReadonlyArray<string>, ports: CompilerPorts): Promise<Readonly<Record<string, string>>> => {
  if (names.length === 0) return {}
  const set = await ports.icons()
  const hints = iconHints(names, set)
  if (hints.length > 0) {
    throw new PackageCompileError(
      `${ICONS_MODULE} has no ${hints.join("; ")}. Names are PascalCase and end in Icon, most with a two-digit variant: Search01Icon, ArrowRight01Icon.`,
      { reason: "icon" }
    )
  }
  return { [ICONS_MODULE]: JSON.stringify(pickIcons(names, set)) }
}

/**
 * Source in; a script, a stylesheet and the digests of all three out, or one
 * `PackageCompileError` saying which file and which import stopped it.
 *
 * Deterministic by construction: the files are compiled in path order, the icons are
 * written in name order, and nothing here reads a clock, a random number or an
 * environment. The same source and the same ports give the same bytes.
 */
export const compilePackage = async (input: PackageSource, ports: CompilerPorts): Promise<CompiledPackage> => {
  const source = checkSource(input)
  for (const path of Object.keys(source.files)) {
    if (Object.hasOwn(ports.sheets, path)) {
      throw new PackageCompileError(
        `${path} has the same name as a runtime stylesheet`,
        { reason: "source", file: path, id: path }
      )
    }
  }
  const { modules, iconNames } = bindAll(source, ports)
  const candidates = [
    ...new Set(
      Object.keys(source.files)
        .sort()
        .filter((path) => isScript(path) && !path.startsWith("vendor/"))
        .flatMap((path) => candidatesOf(source.files[path] ?? ""))
    )
  ]
  if (candidates.length > PACKAGE_COMPILE_LIMITS.candidates) {
    throw new PackageCompileError(
      `the package can use at most ${PACKAGE_COMPILE_LIMITS.candidates} Tailwind candidates; it uses ${candidates.length}`,
      { reason: "source" }
    )
  }
  const inlined = await inlinedIcons(iconNames, ports)
  const script = bindModules(modules, source.entry, inlined) + SANDBOX_TAIL
  const scriptBytes = new TextEncoder().encode(script).byteLength
  if (scriptBytes > PACKAGE_COMPILE_LIMITS.scriptBytes) {
    throw new PackageCompileError(
      `the compiled script can contain at most ${PACKAGE_COMPILE_LIMITS.scriptBytes} bytes; it contains ${scriptBytes}`,
      { reason: "source" }
    )
  }
  const style = await buildStyle({ files: source.files, entry: source.style, sheets: ports.sheets }, candidates)
  const styleBytes = new TextEncoder().encode(style).byteLength
  if (styleBytes > PACKAGE_COMPILE_LIMITS.styleBytes) {
    throw new PackageCompileError(
      `the compiled stylesheet can contain at most ${PACKAGE_COMPILE_LIMITS.styleBytes} bytes; it contains ${styleBytes}`,
      { reason: "style", file: source.style }
    )
  }
  const [sources, scriptDigest, cssDigest] = await Promise.all([digestsOf(source.files), digestOf(script), digestOf(style)])
  return { compiler: COMPILER, script, style, sources, artifacts: { script: scriptDigest, css: cssDigest } }
}
