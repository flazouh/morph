/**
 * The digest a manifest carries and the installer checks, over text the compiler wrote.
 *
 * `crypto.subtle` rather than a hash from npm: it is in the extension, in the build and
 * in a test runner without any of them agreeing on a package, and the installer already
 * reads a downloaded artifact with it. One implementation on both sides of a release is
 * the whole point of comparing digests at all.
 */
const hex = (value: ArrayBuffer): string =>
  [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("")

/** `sha256:` and 64 lowercase hex digits, over the bytes themselves. */
export const digestOfBytes = async (bytes: Uint8Array<ArrayBuffer>): Promise<string> =>
  `sha256:${hex(await crypto.subtle.digest("SHA-256", bytes))}`

/** `sha256:` and 64 lowercase hex digits, over the UTF-8 bytes of the text. */
export const digestOf = (text: string): Promise<string> => digestOfBytes(new TextEncoder().encode(text))

/** Digests for a whole file table, in path order so the result reads the same every time. */
export const digestsOf = async (files: Readonly<Record<string, string>>): Promise<Readonly<Record<string, string>>> =>
  Object.fromEntries(
    await Promise.all(Object.keys(files).sort().map(async (path) => [path, await digestOf(files[path] ?? "")] as const))
  )
