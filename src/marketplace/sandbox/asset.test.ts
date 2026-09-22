import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { assetHandler, isAssetAsk, makeAssetLoader, readAsset } from "./asset"

const answering = (body: BodyInit, init: ResponseInit = {}): typeof fetch =>
  (async () => new Response(body, init)) as unknown as typeof fetch

const PNG = new Uint8Array([137, 80, 78, 71])
const AS_DATA = `data:image/png;base64,${btoa("\x89PNG")}`

describe("reading an asset in the worker", () => {
  test("hands an image back as data, because neither the frame nor the page may fetch it", async () => {
    const read = readAsset(answering(PNG, { headers: { "content-type": "image/png" } }))
    expect(await Effect.runPromise(read("https://avatars.githubusercontent.com/u/1"))).toBe(AS_DATA)
  })

  test("drops the charset a server adds to the type", async () => {
    const read = readAsset(answering(PNG, { headers: { "content-type": "image/png; charset=binary" } }))
    expect(await Effect.runPromise(read("https://github.com/octocat.png"))).toBe(AS_DATA)
  })

  test("follows a redirect, which is how a login becomes a face", async () => {
    const seen: Array<RequestInit | undefined> = []
    const watched = (async (_url: string, init?: RequestInit) => {
      seen.push(init)
      return new Response(PNG, { headers: { "content-type": "image/png" } })
    }) as unknown as typeof fetch
    await Effect.runPromise(readAsset(watched)("https://github.com/octocat.png"))
    expect(seen[0]?.redirect).toBe("follow")
  })

  test("reads without the reader's cookies", async () => {
    const seen: Array<RequestInit | undefined> = []
    const watched = (async (_url: string, init?: RequestInit) => {
      seen.push(init)
      return new Response(PNG, { headers: { "content-type": "image/png" } })
    }) as unknown as typeof fetch
    await Effect.runPromise(readAsset(watched)("https://github.com/octocat.png"))
    expect(seen[0]?.credentials).toBe("omit")
  })

  test("refuses anything that is not an image or a font", async () => {
    const read = readAsset(answering("<script>", { headers: { "content-type": "text/html" } }))
    const failed = await Effect.runPromise(Effect.flip(read("https://github.com/octocat.png")))
    expect(failed.message).toBe("asset is not an image or a font")
  })

  test("refuses an answer with no type at all", async () => {
    const read = readAsset(
      (async () => new Response(PNG, { headers: {} })) as unknown as typeof fetch
    )
    const failed = await Effect.runPromise(Effect.flip(read("https://github.com/octocat.png")))
    expect(failed.message).toBe("asset is not an image or a font")
  })

  test("refuses an answer the frame would have to hold twice", async () => {
    const huge = new Uint8Array(2 * 1024 * 1024 + 1)
    const read = readAsset(answering(huge, { headers: { "content-type": "image/png" } }))
    const failed = await Effect.runPromise(Effect.flip(read("https://github.com/octocat.png")))
    expect(failed.message).toBe("asset is too large")
  })

  test("keeps one exactly at the limit", async () => {
    const full = new Uint8Array(2 * 1024 * 1024)
    const read = readAsset(answering(full, { headers: { "content-type": "image/png" } }))
    const data = await Effect.runPromise(read("https://github.com/octocat.png"))
    expect(data.startsWith("data:image/png;base64,")).toBe(true)
  })

  test("refuses a status the host did not ask for", async () => {
    const read = readAsset(answering("", { status: 404, headers: { "content-type": "image/png" } }))
    const failed = await Effect.runPromise(Effect.flip(read("https://github.com/ghost.png")))
    expect(failed.message).toBe("asset could not be read")
  })

  test("refuses a read that never answered", async () => {
    const read = readAsset((() => Promise.reject(new Error("offline"))) as unknown as typeof fetch)
    const failed = await Effect.runPromise(Effect.flip(read("https://github.com/octocat.png")))
    expect(failed.message).toBe("asset could not be read")
  })
})

describe("the ask that crosses from the page to the worker", () => {
  test("recognises its own message and nothing else", () => {
    expect(isAssetAsk({ type: "readAsset", url: "https://github.com/octocat.png" })).toBe(true)
    expect(isAssetAsk({ type: "readAsset" })).toBe(false)
    expect(isAssetAsk({ type: "installPackage", url: "https://github.com/x.png" })).toBe(false)
    expect(isAssetAsk(null)).toBe(false)
    expect(isAssetAsk("readAsset")).toBe(false)
  })

  test("answers a good read and a refused one without throwing either", async () => {
    const good = assetHandler(answering(PNG, { headers: { "content-type": "image/png" } }))
    expect(await good({ type: "readAsset", url: "https://github.com/octocat.png" })).toEqual({
      type: "assetRead",
      data: AS_DATA
    })

    const bad = assetHandler(answering("", { status: 500 }))
    expect(await bad({ type: "readAsset", url: "https://github.com/octocat.png" })).toEqual({
      type: "assetFailed",
      message: "asset could not be read"
    })
  })

  test("carries the worker's answer back to the frame", async () => {
    const load = makeAssetLoader(async () => ({ type: "assetRead", data: AS_DATA }))
    expect(await Effect.runPromise(load("https://github.com/octocat.png"))).toBe(AS_DATA)
  })

  test("carries the worker's refusal back with its reason", async () => {
    const load = makeAssetLoader(async () => ({ type: "assetFailed", message: "asset is too large" }))
    const failed = await Effect.runPromise(Effect.flip(load("https://github.com/octocat.png")))
    expect(failed.message).toBe("asset is too large")
  })

  test("refuses when the worker is asleep, or answers with something else entirely", async () => {
    const asleep = makeAssetLoader(() => Promise.reject(new Error("no receiving end")))
    expect((await Effect.runPromise(Effect.flip(asleep("https://github.com/a.png")))).message).toBe(
      "asset could not be read"
    )

    for (const odd of [undefined, "data:image/png;base64,AAAA", { type: "somethingElse" }]) {
      const strange = makeAssetLoader(async () => odd)
      const failed = await Effect.runPromise(Effect.flip(strange("https://github.com/a.png")))
      expect(failed.message).toBe("asset could not be read")
    }
  })
})
