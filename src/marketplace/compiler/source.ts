/**
 * What a package's source is allowed to be, before a line of it is compiled.
 *
 * A package is a folder of TypeScript with one stylesheet in it, and nothing else: no
 * build step, no configuration, no path that leaves the folder. The rules are here rather
 * than spread through the compiler so that the answer to "what may I write" is one file
 * long, and so that a draft written in chat is refused for the same reasons a published
 * release is.
 */
import { PackageCompileError } from "./error"

export interface PackageSource {
  /** The TypeScript file the runtime loads: package-relative, `.ts` or `.tsx`. */
  readonly entry: string
  /** The one stylesheet the package ships: package-relative, `.css`. */
  readonly style: string
  /** Every file of the package, by package-relative path. */
  readonly files: Readonly<Record<string, string>>
}

export const SCRIPT_ENDINGS: ReadonlyArray<string> = [".ts", ".tsx"]

export const PACKAGE_SOURCE_LIMITS = {
  files: 256,
  fileBytes: 512_000,
  totalBytes: 4_000_000
} as const

const refuse = (message: string, file?: string): never => {
  throw new PackageCompileError(message, { reason: "source", ...(file === undefined ? {} : { file }) })
}

export const isScript = (path: string): boolean => SCRIPT_ENDINGS.some((ending) => path.endsWith(ending))

/**
 * A package-relative path, written the one way it can be written.
 *
 * Two spellings of one file are two files to a digest and one file to a resolver, which
 * is a release whose manifest does not describe what the sandbox runs. So the canonical
 * spelling is the only spelling: no leading `./`, no `..`, no repeated or trailing
 * slashes, no backslashes, no address.
 */
export const canonicalPath = (path: string): boolean => {
  if (path === "" || path.includes("\\") || path.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(path)) return false
  const parts = path.split("/")
  return parts.every((part) => part !== "" && part !== "." && part !== "..")
}

/** The source contract, checked. Returns the project when it holds and throws when it does not. */
export const checkSource = (source: PackageSource): PackageSource => {
  const paths = Object.keys(source.files)
  if (paths.length === 0) refuse("the package has no files")
  if (paths.length > PACKAGE_SOURCE_LIMITS.files) {
    refuse(`the package can contain at most ${PACKAGE_SOURCE_LIMITS.files} files; it contains ${paths.length}`)
  }
  let totalBytes = 0
  for (const path of paths) {
    if (!canonicalPath(path)) refuse(`${JSON.stringify(path)} is not a package-relative path`, path)
    if (!isScript(path) && !path.endsWith(".css")) {
      refuse(`${path} is neither TypeScript nor a stylesheet; a package is .ts, .tsx and .css files`, path)
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
  if (!Object.hasOwn(source.files, source.entry)) {
    refuse(`the package entry ${JSON.stringify(source.entry)} is not one of its files: ${paths.join(", ")}`, source.entry)
  }
  if (!isScript(source.entry)) refuse(`the package entry ${source.entry} must be a .ts or .tsx file`, source.entry)
  if (!Object.hasOwn(source.files, source.style)) {
    refuse(`the package stylesheet ${JSON.stringify(source.style)} is not one of its files: ${paths.join(", ")}`, source.style)
  }
  if (!source.style.endsWith(".css")) refuse(`the package stylesheet ${source.style} must be a .css file`, source.style)
  return source
}
