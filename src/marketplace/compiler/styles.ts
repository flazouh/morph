/**
 * The stylesheet half of compilation: which classes a source spends, and the one sheet a
 * package writes, built by Tailwind in the browser.
 *
 * Tailwind normally finds its candidates by reading the filesystem, which is exactly what
 * neither the extension nor a sandboxed compile has. So the candidates are scanned out of
 * the sources here and handed to the compiler, and every `@import` is answered from the
 * package's own files or from the sheets the runtime lends. Nothing is read from a disk
 * and nothing is fetched.
 */
import { compile } from "tailwindcss"
import { leavesPackage, normalise } from "../../compiler/bundle"
import { messageOf, PackageCompileError } from "./error"

/** Comments first: every one of these sheets explains itself, and an `@import` inside a paragraph is prose. */
const withoutComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "")

const IMPORT = /@import\b\s*(?:url\(\s*(['"]?)([^'")]*)\1\s*\)|(['"])([^'"]*)\3)/g
const URL = /\burl\(\s*(['"]?)([^'")]+)\1\s*\)/g

/** What each `@import` in a sheet names, ignoring the ones written about rather than written. */
export const styleImports = (css: string): ReadonlyArray<string> =>
  Array.from(withoutComments(css).matchAll(IMPORT), (match) => match[2] ?? match[4] ?? "")

const isRemote = (id: string): boolean => /^[a-z][a-z0-9+.-]*:/i.test(id) || id.startsWith("//")

/**
 * A sheet a package cannot have: one that scans a filesystem.
 *
 * `@source` and `source(...)` tell Tailwind which folder to read class names out of, and
 * there is no folder here — the candidates come from the package's own sources and from
 * nowhere else. Left in, they are a silent difference between what the author's build
 * found and what the extension finds.
 */
const SCANS = /@source\b|@import[^;]*\bsource\(/

interface Resolved {
  readonly path: string
  readonly content: string
}

interface StyleProject {
  readonly files: Readonly<Record<string, string>>
  readonly entry: string
  readonly sheets: Readonly<Record<string, string>>
}

const refuse = (message: string, file?: string, id?: string): never => {
  throw new PackageCompileError(message, { reason: "style", ...(file === undefined ? {} : { file }), ...(id === undefined ? {} : { id }) })
}

/** The file or lent sheet an `@import` names, refused with the reason it cannot be had. */
const resolveImport = ({ files, sheets }: StyleProject, from: string, id: string): Resolved => {
  if (id === "") refuse(`${from} has an @import with no stylesheet in it`, from, id)
  if (isRemote(id)) refuse(`${from} imports ${JSON.stringify(id)}; a package stylesheet cannot import from a network address`, from, id)
  if (id.startsWith("/")) refuse(`${from} imports ${JSON.stringify(id)}; a package stylesheet imports its own files by relative path`, from, id)
  if (id.startsWith(".")) {
    if (leavesPackage(from, id)) {
      refuse(`${from} imports ${JSON.stringify(id)}, which leaves the package`, from, id)
    }
    const path = normalise(from, id)
    const content =
      files[path] ??
      refuse(`${from} imports ${JSON.stringify(id)}, and the package has no ${path}`, from, id)
    return { path, content }
  }
  const lent =
    sheets[id] ??
    refuse(
      `${from} imports ${JSON.stringify(id)}; a package stylesheet may import ${Object.keys(sheets).join(", ")} and its own files`,
      from,
      id
    )
  return { path: id, content: lent }
}

/**
 * The whole import graph, walked before Tailwind sees any of it.
 *
 * Tailwind asks for one sheet at a time and would follow a cycle until the stack ran out,
 * with nothing in the failure naming the two files. So the graph is walked here first,
 * where a repeat inside the current chain is a sentence the author can act on.
 */
const walk = (project: StyleProject): void => {
  const done = new Set<string>()
  const visit = (path: string, content: string, chain: ReadonlyArray<string>): void => {
    const rules = withoutComments(content)
    if (SCANS.test(rules)) {
      refuse(`${path} uses @source or source(...); a package stylesheet cannot scan a folder for class names`, path)
    }
    for (const match of rules.replace(IMPORT, "").matchAll(URL)) {
      const id = match[2] ?? ""
      if (!id.startsWith("#") && !id.startsWith("data:")) {
        refuse(`${path} uses url(${JSON.stringify(id)}); a package stylesheet cannot load an asset`, path, id)
      }
    }
    for (const id of styleImports(content)) {
      const next = resolveImport(project, path, id)
      if (chain.includes(next.path)) {
        refuse(`${[...chain, next.path].join(" imports ")}, which is a cycle`, path, id)
      }
      if (done.has(next.path)) continue
      done.add(next.path)
      visit(next.path, next.content, [...chain, next.path])
    }
  }
  const root =
    project.files[project.entry] ??
    refuse(`the package has no ${project.entry}`, project.entry)
  done.add(project.entry)
  visit(project.entry, root, [project.entry])
}

/**
 * The package's own stylesheet: its entry, its imports resolved among its files and the
 * lent sheets, and the utilities its sources ask for.
 */
export const buildStyle = async (project: StyleProject, candidates: ReadonlyArray<string>): Promise<string> => {
  walk(project)
  const root = project.files[project.entry] ?? ""
  try {
    const compiler = await compile(root, {
      base: project.entry,
      loadStylesheet: async (id: string, base: string) => {
        const found = resolveImport(project, base, id)
        return { path: found.path, base: found.path, content: found.content }
      },
      loadModule: (id: string) => Promise.reject(new Error(`a package stylesheet cannot load ${JSON.stringify(id)}`))
    })
    return compiler.build([...candidates])
  } catch (cause) {
    if (cause instanceof PackageCompileError) throw cause
    return refuse(`${project.entry} does not build: ${messageOf(cause)}`, project.entry)
  }
}
