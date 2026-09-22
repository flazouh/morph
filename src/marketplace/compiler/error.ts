/**
 * Why a package did not compile, in words its author can act on.
 *
 * One error type for the whole compiler, because there is one caller shape behind every
 * use of it: a chat that has to tell the author what to change, and a publisher that has
 * to refuse a release with the same sentence. A union of failures per stage would make
 * each of those match on stages nobody outside here can name.
 *
 * The fields carry what a message alone cannot be searched for: which file, and which
 * import inside it. `reason` says which rule refused, so a caller can group without
 * reading English.
 */
export type CompileReason =
  /** The project's shape: no entry, no files, a path that is not package-relative. */
  | "source"
  /** A file that TypeScript or JSX could not read. */
  | "syntax"
  /** An import a package may not make, or one that names nothing. */
  | "import"
  /** The stylesheet, its imports, or the utilities it asks Tailwind for. */
  | "style"
  /** An icon name the set does not have. */
  | "icon"

export interface CompileDetail {
  readonly reason: CompileReason
  /** The package-relative path of the file that failed, when one file is at fault. */
  readonly file?: string
  /** The import specifier that failed, as written. */
  readonly id?: string
}

export class PackageCompileError extends Error {
  readonly _tag = "PackageCompileError"
  readonly reason: CompileReason
  readonly file: string | undefined
  readonly id: string | undefined

  constructor(message: string, detail: CompileDetail) {
    super(message)
    this.name = "PackageCompileError"
    this.reason = detail.reason
    this.file = detail.file
    this.id = detail.id
  }
}

export const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))
