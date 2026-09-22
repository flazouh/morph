import { describe, expect, test } from "bun:test"
import type { WebAnswer, WebAsk } from "./web"
import { pageWebFetch } from "../kit/web"
import { relayWebAsks, type BridgeWindow } from "./web-page"

/**
 * One window both worlds share: a post to it is heard by every listener on it, the way
 * the page's world and the content script's world hear the same window.
 */
const sharedWindow = () => {
  const target = new EventTarget()
  const posted: Array<unknown> = []
  const win: BridgeWindow = {
    postMessage: ((data: unknown) => {
      posted.push(data)
      queueMicrotask(() => {
        const event = new MessageEvent("message", { data })
        Object.defineProperty(event, "source", { value: win })
        target.dispatchEvent(event)
      })
    }) as BridgeWindow["postMessage"],
    addEventListener: target.addEventListener.bind(target) as BridgeWindow["addEventListener"],
    removeEventListener: target.removeEventListener.bind(target) as BridgeWindow["removeEventListener"]
  }
  return { win, posted, target }
}

const page = { url: "https://api.example.com/film/1", status: 200, contentType: "application/json", body: '{"rating":8.1}', truncated: false }

describe("window.__beui.fetch, both halves on one window", () => {
  test("the page asks, the content script carries the ask to the worker, and the answer comes back to the page", async () => {
    const { win } = sharedWindow()
    const sent: Array<WebAsk> = []
    const stop = relayWebAsks(win, (ask) => {
      sent.push(ask)
      return Promise.resolve<WebAnswer>({ type: "webFetched", page })
    })
    const got = await pageWebFetch(win)("https://api.example.com/film/1", { accept: "json" })
    expect(got).toEqual(page)
    expect(sent).toEqual([{ type: "fetchWeb", url: "https://api.example.com/film/1", accept: "json" }])
    stop()
  })

  test("the worker's refusal is the page's rejection, one line, no more", async () => {
    const { win } = sharedWindow()
    relayWebAsks(win, () => Promise.resolve<WebAnswer>({ type: "webFailed", message: "the answer is image/png, not text or JSON" }))
    await expect(pageWebFetch(win)("https://example.com/a.png")).rejects.toThrow("__beui.fetch: the answer is image/png, not text or JSON")
  })

  test("two asks in flight each get their own answer", async () => {
    const { win } = sharedWindow()
    relayWebAsks(win, (ask) => Promise.resolve<WebAnswer>({ type: "webFetched", page: { ...page, url: ask.url, body: ask.url } }))
    const fetch = pageWebFetch(win)
    const [a, b] = await Promise.all([fetch("https://example.com/a"), fetch("https://example.com/b")])
    expect(a.body).toBe("https://example.com/a")
    expect(b.body).toBe("https://example.com/b")
  })

  test("a message from another window is not an ask, and a stray answer is not a reply", async () => {
    const { win, target } = sharedWindow()
    const sent: Array<WebAsk> = []
    relayWebAsks(win, (ask) => {
      sent.push(ask)
      return Promise.resolve<WebAnswer>({ type: "webFetched", page })
    })
    const foreign = new MessageEvent("message", { data: { morph: "morph:fetchWeb", id: "x", url: "https://example.com/" } })
    Object.defineProperty(foreign, "source", { value: {} })
    target.dispatchEvent(foreign)
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(sent).toEqual([])
  })

  test("no answer in time rejects with a reason the skin author can act on", async () => {
    const { win } = sharedWindow()
    await expect(pageWebFetch(win, 10)("https://example.com/")).rejects.toThrow("__beui.fetch: no answer from Morph; is the extension on?")
  })

  test("a send that rejects becomes a failed answer, not a hung page", async () => {
    const { win } = sharedWindow()
    relayWebAsks(win, () => Promise.reject(new Error("Extension context invalidated.")))
    await expect(pageWebFetch(win)("https://example.com/")).rejects.toThrow("__beui.fetch: the request could not reach the extension")
  })
})
