/**
 * Reading an image or a font for a package, in the one place in Morph that may.
 *
 * Three walls stand between package code and a picture, and each is there for a reason.
 * The sandbox frame has no network at all. The content script has one, but it is the
 * page's, so GitHub's `connect-src` refuses an address GitHub itself never fetches. Only
 * the service worker holds the extension's own host permissions.
 *
 * So the frame asks the content script, the content script asks the worker, and the
 * worker answers with the bytes as text. The firewall has already checked the address
 * against the origins the package declared, before any of this runs.
 */
import { Effect } from "effect"
import { CapabilityPortFailure, type CapabilityPorts } from "./firewall"

export interface AssetAsk {
  readonly type: "readAsset"
  readonly url: string
}

export type AssetAnswer =
  | { readonly type: "assetRead"; readonly data: string }
  | { readonly type: "assetFailed"; readonly message: string }

export const isAssetAsk = (value: unknown): value is AssetAsk =>
  typeof value === "object" &&
  value !== null &&
  (value as AssetAsk).type === "readAsset" &&
  typeof (value as AssetAsk).url === "string"

const fail = (message: string) => new CapabilityPortFailure({ message })

/**
 * The most a single asset may weigh, in bytes.
 *
 * It crosses to the frame as base64 inside a message, which costs a third again on top of
 * the bytes and cannot be streamed. Two megabytes is far above any face and far below a
 * size that would hurt to hold twice.
 */
const MOST_ASSET_BYTES = 2 * 1024 * 1024

/**
 * The read itself, for the worker to run.
 *
 * Without the reader's cookies. A face is public, and a request whose address the package
 * chose must not be one that carries their session.
 *
 * Images and fonts only. The answer is handed to a package as a URL it can put in an
 * element, so anything else would be Morph fetching a document on a package's behalf and
 * giving it the text.
 */
export const readAsset = (fetcher: typeof fetch) =>
  Effect.fn("sandbox.readAsset")(function* (url: string) {
    const answer = yield* Effect.tryPromise({
      try: () => fetcher(url, { credentials: "omit", redirect: "follow" }),
      catch: () => fail("asset could not be read")
    })
    if (!answer.ok) return yield* Effect.fail(fail("asset could not be read"))
    const type = answer.headers.get("content-type") ?? ""
    if (!type.startsWith("image/") && !type.startsWith("font/")) {
      return yield* Effect.fail(fail("asset is not an image or a font"))
    }
    const bytes = yield* Effect.tryPromise({
      try: () => answer.arrayBuffer(),
      catch: () => fail("asset could not be read")
    })
    if (bytes.byteLength > MOST_ASSET_BYTES) return yield* Effect.fail(fail("asset is too large"))
    const encoded = yield* Effect.sync(() => {
      let binary = ""
      for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte)
      return btoa(binary)
    })
    return `data:${type.split(";")[0]};base64,${encoded}`
  })

/** The worker's side of the ask. */
export const assetHandler =
  (fetcher: typeof fetch) =>
  async (message: AssetAsk): Promise<AssetAnswer> =>
    Effect.runPromise(
      readAsset(fetcher)(message.url).pipe(
        Effect.map((data): AssetAnswer => ({ type: "assetRead", data })),
        Effect.catch((failure) =>
          Effect.succeed<AssetAnswer>({ type: "assetFailed", message: failure.message })
        )
      )
    )

/** The content script's side: the port the firewall calls, which only forwards. */
export const makeAssetLoader = (
  ask: (message: AssetAsk) => Promise<unknown>
): CapabilityPorts["loadAsset"] =>
  Effect.fn("sandbox.loadAsset")(function* (url) {
    const answer = yield* Effect.tryPromise({
      try: () => ask({ type: "readAsset", url }),
      catch: () => fail("asset could not be read")
    })
    if (typeof answer !== "object" || answer === null) {
      return yield* Effect.fail(fail("asset could not be read"))
    }
    const said = answer as AssetAnswer
    if (said.type !== "assetRead") {
      return yield* Effect.fail(fail(said.type === "assetFailed" ? said.message : "asset could not be read"))
    }
    return said.data
  })
