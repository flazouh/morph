import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { fakeBrowser } from "@webext-core/fake-browser"
import { isAssetAsk } from "../marketplace/sandbox/asset"
import { isOverlaySignal } from "../overlay/messages"
import { decodePageAsk } from "./messages"
import { accepting, answer, ask, forgetAnswers, signal } from "./messaging"
import { decodeWebAsk } from "./web"

const previous = (globalThis as { chrome?: unknown }).chrome

beforeEach(() => {
  fakeBrowser.reset()
  Object.assign(globalThis, { chrome: fakeBrowser })
})

afterEach(() => {
  forgetAnswers()
  Object.assign(globalThis, { chrome: previous })
})

describe("the extension protocol", () => {
  test("an ask reaches its handler with Chrome's sender, and the answer comes back", async () => {
    const seen: Array<unknown> = []
    answer("fetchWeb", decodeWebAsk, (data, sender) => {
      seen.push([data, sender])
      return { type: "webFailed", message: "no network" }
    })
    const web = await ask("fetchWeb", { type: "fetchWeb", url: "https://example.com/", accept: "text" })
    expect(web).toEqual({ type: "webFailed", message: "no network" })
    expect(seen).toEqual([[{ type: "fetchWeb", url: "https://example.com/", accept: "text" }, {}]])
  })

  test("a handler that throws rejects the sender with the error, not an undefined answer", async () => {
    answer("asset", accepting(isAssetAsk), () => {
      throw new Error("the package has no such face")
    })
    await expect(ask("asset", { type: "readAsset", url: "https://x.test/a.png" })).rejects.toThrow(
      "the package has no such face"
    )
  })

  test("an ask the decoder refuses rejects the sender and never reaches the handler", async () => {
    let reached = 0
    answer("asset", accepting(isAssetAsk), () => {
      reached += 1
      return { type: "assetFailed", message: "unreachable" }
    })
    const wire = ask("asset", { type: "readAsset" } as never)
    await expect(wire).rejects.toThrow("the asset ask was malformed")
    expect(reached).toBe(0)
  })

  test("an ask no context claims rejects instead of resolving to nothing", async () => {
    answer("overlaySignal", accepting(isOverlaySignal), () => undefined)
    await expect(ask("cursor", { type: "cursor/clear", threadId: "t" })).rejects.toThrow()
  })

  test("a message in another shape is left to whoever listens for it", async () => {
    let handled = 0
    answer("overlaySignal", accepting(isOverlaySignal), () => {
      handled += 1
    })
    const ours: Array<unknown> = []
    fakeBrowser.runtime.onMessage.addListener((message: unknown) => {
      ours.push(message)
      return false
    })
    await fakeBrowser.runtime.sendMessage({ type: "chatReady" })
    expect(handled).toBe(0)
    expect(ours).toEqual([{ type: "chatReady" }])
  })

  test("a signal never rejects, even with no listener awake", async () => {
    signal("overlaySignal", { type: "chatClosed" })
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

  test("two answers for one kind in one context is a programming error, said at once", () => {
    answer("page", decodePageAsk, () => ({ type: "error", message: "x" }))
    expect(() => answer("page", decodePageAsk, () => ({ type: "error", message: "y" }))).toThrow()
  })
})
