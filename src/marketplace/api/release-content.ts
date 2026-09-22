/**
 * What a release is made of: the files it commits, the two images it shows, the manifest
 * it carries, and the digest that names the whole of it.
 *
 * This half of publishing is pure. Nothing here reaches a network, a clock or a database,
 * so every rule about what may be published can be read, and tested, without driving a
 * state machine through it. The state machine next door decides when to apply these rules;
 * this module decides what they are.
 *
 * The images are the reason a file is not always text. A reader fetches
 * `preview-before.webp` from raw GitHub, so those bytes have to be in the commit, and
 * bytes cross a JSON port as base64. Every check on them happens over the decoded bytes.
 */
import type { CompiledPackage } from "../compiler/compile"
import { digestOf, digestOfBytes } from "../compiler/digest"
import { messageOf } from "../compiler/error"
import type { PackageSource } from "../compiler/source"
import { parseManifest, type PackageRuntime, type PagePermission, type RedesignManifest, type SandboxCapabilities } from "../manifest"

/** Content a release will not carry, named by field and reason, and never by its bytes. */
export class ReleaseContentError extends Error {
  readonly _tag = "ReleaseContentError"
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = "ReleaseContentError"
    this.code = code
  }
}

const refuse = (code: string, message: string): ReleaseContentError => new ReleaseContentError(code, message)

/** A committed file: text, or bytes carried as base64 so every port stays JSON-safe. */
export type ReleaseFile = string | { readonly base64: string }

const encoder = new TextEncoder()

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

/** Base64 to bytes. The caller decides what a failure means; this only reports one. */
export const bytesOfBase64 = (base64: string): Uint8Array<ArrayBuffer> => {
  if (base64.length === 0 || base64.length % 4 !== 0 || !BASE64.test(base64)) {
    throw new Error("the value is not base64")
  }
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/** Async even for a malformed payload, so one `catch` covers every way a digest fails. */
export const digestOfFile = async (file: ReleaseFile): Promise<string> =>
  typeof file === "string" ? digestOf(file) : digestOfBytes(bytesOfBase64(file.base64))

/** Digests for a whole tree, in path order so the result reads the same every time. */
export const digestsOfFiles = async (
  files: Readonly<Record<string, ReleaseFile>>
): Promise<Readonly<Record<string, string>>> =>
  Object.fromEntries(
    await Promise.all(Object.keys(files).sort().map(async (path) => [path, await digestOfFile(files[path] ?? "")] as const))
  )

const decodedLengthOf = (base64: string): number =>
  (base64.length / 4) * 3 - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0)

/** What a file costs in the repository: an image by its bytes, not by the base64 of them. */
export const byteLengthOf = (file: ReleaseFile): number =>
  typeof file === "string" ? encoder.encode(file).byteLength : decodedLengthOf(file.base64)

/** The two screenshots a release shows, at the names a reader's raw URL asks for. */
export const PREVIEW_FILES = { before: "preview-before.webp", after: "preview-after.webp" } as const

/**
 * The most one preview may weigh, decoded. A viewport WebP is a small fraction of this.
 * The limit bounds two things at once: what a release commits, and what a run row holds
 * while it waits to be resumed, since a resume publishes from stored content alone.
 */
export const PREVIEW_LIMIT_BYTES = 1_048_576

export interface PreviewImage {
  /** The image itself: base64, or a `data:image/webp;base64,` URL, so JSON can carry it. */
  readonly data: string
  /** The digest the submission claims over the decoded bytes, checked before anything is written. */
  readonly digest: string
}

export interface ReleasePreviews { readonly before: PreviewImage; readonly after: PreviewImage }

interface ImageSize { readonly width: number; readonly height: number }

const ascii = (bytes: Uint8Array, start: number, end: number): string =>
  String.fromCharCode(...bytes.subarray(start, end))

/** A little-endian number of `width` bytes, multiplied rather than shifted to stay unsigned. */
const numberAt = (bytes: Uint8Array, at: number, width: number): number => {
  let value = 0
  for (let index = width - 1; index >= 0; index -= 1) value = value * 256 + (bytes[at + index] ?? 0)
  return value
}

const isWebp = (bytes: Uint8Array): boolean =>
  bytes.length >= 16 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP"

/**
 * The canvas size the WebP header states, or null for a variant this cannot read. Taken
 * from the RIFF container rather than from a decoder: the API has no browser, and the
 * header is enough to hold a before and an after to one viewport. A size nobody can read
 * is not a reason to refuse a release, so an unknown variant returns null and passes.
 */
const webpSizeOf = (bytes: Uint8Array): ImageSize | null => {
  const chunk = ascii(bytes, 12, 16)
  if (chunk === "VP8X" && bytes.length >= 30) {
    return { width: numberAt(bytes, 24, 3) + 1, height: numberAt(bytes, 27, 3) + 1 }
  }
  if (chunk === "VP8 " && bytes.length >= 30 && ascii(bytes, 23, 26) === "\u009d\u0001\u002a") {
    return { width: numberAt(bytes, 26, 2) & 0x3fff, height: numberAt(bytes, 28, 2) & 0x3fff }
  }
  if (chunk === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
    const bits = numberAt(bytes, 21, 4)
    return { width: (bits & 0x3fff) + 1, height: (Math.floor(bits / 0x4000) & 0x3fff) + 1 }
  }
  return null
}

const DATA_URL = /^data:([^;,]+);base64,([\s\S]*)$/

/** The base64 of a bare payload or of a WebP data URL, and never any of it in an error. */
const payloadOf = (field: string, data: string): string => {
  if (!data.startsWith("data:")) return data
  const parsed = DATA_URL.exec(data)
  if (parsed === null) throw refuse("preview_encoding_invalid", `${field} is not a base64 data URL`)
  const type = (parsed[1] ?? "").slice(0, 40)
  if (type.toLowerCase() !== "image/webp") {
    throw refuse("preview_not_webp", `${field} calls itself ${type} rather than image/webp`)
  }
  return parsed[2] ?? ""
}

const checkedPreview = async (
  field: string,
  image: PreviewImage
): Promise<{ readonly preview: PreviewImage; readonly size: ImageSize | null }> => {
  const payload = payloadOf(field, image.data)
  let bytes: Uint8Array<ArrayBuffer>
  try {
    bytes = bytesOfBase64(payload)
  } catch {
    throw refuse("preview_encoding_invalid", `${field} is not valid base64`)
  }
  if (bytes.length > PREVIEW_LIMIT_BYTES) {
    throw refuse("preview_too_large", `${field} is ${bytes.length} bytes, over the ${PREVIEW_LIMIT_BYTES} byte limit`)
  }
  if (!isWebp(bytes)) throw refuse("preview_not_webp", `${field} is not a WebP image`)
  const digest = await digestOfBytes(bytes)
  if (digest !== image.digest) throw refuse("preview_digest_mismatch", `${field} is not the image its digest names`)
  return { preview: { data: payload, digest }, size: webpSizeOf(bytes) }
}

const sizeText = ({ width, height }: ImageSize): string => `${width}x${height}`

/**
 * Both images, decoded and held to what they claim, with the payload normalised to bare
 * base64 so a run stores one form of one image. The pair is checked together because the
 * two shots are a comparison: a before and an after of different sizes show a redesign
 * that did not happen.
 */
export const checkedPreviews = async (previews: ReleasePreviews): Promise<ReleasePreviews> => {
  const before = await checkedPreview("previews.before", previews.before)
  const after = await checkedPreview("previews.after", previews.after)
  const [left, right] = [before.size, after.size]
  if (left !== null && right !== null && (left.width !== right.width || left.height !== right.height)) {
    throw refuse(
      "preview_dimension_mismatch",
      `previews.before and previews.after are ${sizeText(left)} and ${sizeText(right)}; a release shows one viewport`
    )
  }
  return { before: before.preview, after: after.preview }
}

/** The image files a release commits, at the paths `publicFilesOf` points a reader at. */
export const previewFilesOf = (previews: ReleasePreviews): Readonly<Record<string, ReleaseFile>> => ({
  [PREVIEW_FILES.before]: { base64: previews.before.data },
  [PREVIEW_FILES.after]: { base64: previews.after.data }
})

/**
 * The images as everything but the commit refers to them. The manifest and the content key
 * take the same two digests from here, so what a reader checks and what a run is keyed by
 * can never drift apart.
 */
const previewDigests = (previews: ReleasePreviews): { readonly before: string; readonly after: string } => ({
  before: previews.before.digest,
  after: previews.after.digest
})

/** The exact release a fork was made from. A fork names it and never replaces it. */
export interface ParentRelease { readonly slug: string; readonly version: string; readonly commit: string }

/** The runtimes a release can publish for. `declarative-v1` has no publisher. */
export type ReleaseRuntime = Extract<PackageRuntime, "sandbox-v1" | "script-v1">

/**
 * What a release descends from and what it may do, which go together by runtime. A sandbox
 * package is always a fork: it names the released version it changed, and declares the
 * capabilities the sandbox will hold it to. A page package runs in the page with the
 * page's own power, so it declares no capabilities; it may still name a parent, because a
 * reader can fork a published page redesign the same way they fork a sandbox program.
 * With no capabilities on either side, such a fork widens nothing and asks nothing.
 */
export type ReleaseKind =
  | { readonly runtime: "sandbox-v1"; readonly parent: ParentRelease; readonly capabilities: SandboxCapabilities }
  | { readonly runtime: "script-v1"; readonly parent?: ParentRelease; readonly capabilities?: undefined }

/** `Omit` over each member of a union, so the runtime keeps telling the other fields apart. */
type OmitEach<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/**
 * What the extension submits, and the whole of what the release publishes. The digests are
 * the client's claim about its own build: the server compiles the same source and compares,
 * so a submission cannot describe an artifact or an image it did not produce.
 */
export type ReleaseSubmission = ReleaseKind & {
  readonly ownerId: string
  readonly slug: string
  readonly version: string
  readonly name: string
  readonly summary: string
  readonly license: string
  readonly scope: { readonly kind: "page" | "site"; readonly origin: string; readonly paths: ReadonlyArray<string> }
  readonly source: PackageSource
  /** The submitted digest of every source file, by package-relative path. */
  readonly sources: Readonly<Record<string, string>>
  /** The submitted digests of the two compiled artifacts. */
  readonly artifacts: { readonly script: string; readonly css: string }
  readonly compatibility: { readonly kit: string; readonly chrome: string }
  /** The before and after screenshots, as bytes rather than as a promise of bytes. */
  readonly previews: ReleasePreviews
  /**
   * The added permissions the creator confirmed, as they were shown. A list rather than a
   * flag, so a draft that widens further afterwards is refused rather than riding it.
   */
  readonly approvedPermissions: ReadonlyArray<string>
}

/**
 * The publishable half of a submission: everything that lands in the repository and none of
 * the caller's decisions. A run stores this rather than the submission, so who pressed
 * Publish and what they confirmed cannot reach the content key or the committed bytes.
 */
export type ReleaseContent = OmitEach<ReleaseSubmission, "ownerId" | "approvedPermissions">

export const contentOf = (submission: ReleaseSubmission): ReleaseContent => {
  const { ownerId: _owner, approvedPermissions: _approved, ...content } = submission
  return content
}

/** The parent, without whatever else the caller's record of it carries. */
export const lineageOf = ({ slug, version, commit }: ParentRelease): ParentRelease => ({ slug, version, commit })

/**
 * JSON with object keys in order, which is what a digest and a signature are taken over.
 * Two callers that hash "the same content" have to agree on bytes, and `JSON.stringify`
 * only agrees when the keys happen to be written in the same order. Array order is kept:
 * a list the author wrote in another order is other content.
 */
export const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}

/**
 * The identity of a release: everything it publishes, and nothing a caller decides. The
 * source, the lineage, the capabilities, the images and every field that lands in
 * `manifest.json` are in. The signed-in user and the permission confirmation are out, so
 * pressing Publish twice, or approving permissions on the second try, meets the same run.
 *
 * The images enter by digest rather than by payload. A digest is the bytes for this
 * purpose, and it keeps the key the same whether the client sent a data URL or bare base64.
 */
export const releaseContentKey = (content: ReleaseContent): Promise<string> =>
  digestOf(
    canonicalJson({
      schema: 2,
      runtime: content.runtime,
      slug: content.slug,
      version: content.version,
      name: content.name,
      summary: content.summary,
      license: content.license,
      scope: content.scope,
      compatibility: content.compatibility,
      previews: previewDigests(content.previews),
      entry: content.source.entry,
      style: content.source.style,
      files: content.source.files,
      capabilities: content.capabilities ?? null,
      parent: content.parent === undefined ? null : lineageOf(content.parent)
    })
  )

/** The immutable folder a release lives at forever, one per package version. */
export const releasePathOf = (slug: string, version: string): string => `packages/${slug}/${version}`

/**
 * The coarse permission summary a manifest carries beside its capabilities. Derived rather
 * than submitted, so the two can never disagree: the capabilities are what the sandbox
 * enforces, and this list only exists for readers that show a short line.
 */
const summaryPermissions = (content: ReleaseContent): RedesignManifest["permissions"] => {
  // A page script runs in the page with the page's power, so the summary says all of it.
  if (content.runtime === "script-v1") return { page: ["read:text", "read:attributes", "navigate"], network: [] }
  const { capabilities } = content
  const page: PagePermission[] = []
  if (capabilities.page.read.length > 0) page.push("read:text", "read:attributes")
  if (capabilities.page.navigate.length > 0 || capabilities.page.traverse) page.push("navigate")
  const network = [...new Set([...capabilities.network.map((grant) => grant.origin), ...capabilities.assets])].sort()
  return { page, network }
}

export type ArtifactDigests = Pick<ReleaseSubmission, "sources" | "artifacts">

/** The manifest a release commits, built the one way, from digests both sides agreed on. */
export const manifestOf = (content: ReleaseContent, digests: ArtifactDigests): RedesignManifest => {
  try {
    return parseManifest({
      schema: 1,
      slug: content.slug,
      version: content.version,
      summary: content.summary,
      license: content.license,
      author: { handle: content.slug.split("/")[0] ?? "" },
      scope: content.scope,
      runtime: content.runtime,
      entry: content.source.entry,
      files: digests.sources,
      compatibility: content.compatibility,
      artifacts: digests.artifacts,
      previews: previewDigests(content.previews),
      permissions: summaryPermissions(content),
      ...(content.runtime === "sandbox-v1" ? { capabilities: content.capabilities } : {})
    })
  } catch (cause) {
    throw refuse("manifest_invalid", messageOf(cause))
  }
}

/**
 * The tree a release commits: what a reader installs, what they look at before they
 * install it, and the source it was all built from.
 */
export const releaseFilesOf = (
  content: ReleaseContent,
  compiled: CompiledPackage,
  manifest: RedesignManifest
): Readonly<Record<string, ReleaseFile>> => ({
  "manifest.json": `${JSON.stringify(manifest, null, 2)}\n`,
  "script.js": compiled.script,
  "style.css": compiled.style,
  ...previewFilesOf(content.previews),
  ...Object.fromEntries(
    Object.keys(content.source.files).sort().map((path) => [`source/${path}`, content.source.files[path] ?? ""])
  )
})

export const sameFiles = (
  left: Readonly<Record<string, ReleaseFile>>,
  right: Readonly<Record<string, ReleaseFile>>
): boolean => canonicalJson(left) === canonicalJson(right)

/** What the whole release weighs, which is what the catalog reports as its size. */
export const releaseBytesOf = (files: Readonly<Record<string, ReleaseFile>>): number =>
  Object.values(files).reduce((total, file) => total + byteLengthOf(file), 0)
