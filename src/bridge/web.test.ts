import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { decodeWebAsk, NOT_A_MORPH_PAGE, readWeb, WEB_LIMITS, webHandler, webSenderAllowed } from "./web"

const calls: Array<{ url: string; init: RequestInit | undefined }> = []
const answering = (body: string, init: ResponseInit = {}, url = ""): typeof fetch =>
    ((input: RequestInfo | URL, requestInit?: RequestInit): Promise<Response> => {
      calls.push({ url: String(input), init: requestInit })
      const response = new Response(body, init)
      if (url !== "") Object.defineProperty(response, "url", { value: url })
      return Promise.resolve(response)
    }) as unknown as typeof fetch

describe("readWeb", () => {
  test("a GET without cookies, and the status, type and body come back as the server sent them", async () => {
    calls.length = 0
    const page = await Effect.runPromise(
      readWeb(answering('{"rating":8.1}', { status: 200, headers: { "content-type": "application/json; charset=utf-8" } }, "https://api.example.com/film/1"))(
        "https://api.example.com/film/1",
        "json"
      )
    )
    expect(page).toEqual({
      url: "https://api.example.com/film/1",
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: '{"rating":8.1}',
      truncated: false
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.init).toMatchObject({ method: "GET", credentials: "omit", redirect: "follow", headers: { Accept: "application/json" } })
  })

  test("a non-2xx answer is still an answer", async () => {
    const page = await Effect.runPromise(readWeb(answering("gone", { status: 404, headers: { "content-type": "text/plain" } }))("https://example.com/x"))
    expect(page.status).toBe(404)
    expect(page.body).toBe("gone")
  })

  test("a body past the limit is cut and says so", async () => {
    const page = await Effect.runPromise(
      readWeb(answering("a".repeat(WEB_LIMITS.bodyChars + 5), { headers: { "content-type": "text/html" } }))("https://example.com/long")
    )
    expect(page.body).toHaveLength(WEB_LIMITS.bodyChars)
    expect(page.truncated).toBe(true)
  })

  test("only http and https addresses", async () => {
    for (const url of ["chrome://settings", "file:///etc/passwd", "chrome-extension://abc/panel.html", "not a url", "javascript:alert(1)"]) {
      const failure = await Effect.runPromise(Effect.flip(readWeb(answering(""))(url)))
      expect(failure.message).toBe("only http and https addresses can be fetched")
    }
  })

  test("a binary answer is refused, so the worker never hands a page a file as text", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(readWeb(answering("PNG", { headers: { "content-type": "image/png" } }))("https://example.com/a.png"))
    )
    expect(failure.message).toBe("the answer is image/png, not text or JSON")
  })

  test("a request that throws is a plain failure without the cause's text", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(readWeb((() => Promise.reject(new TypeError("Failed to fetch: secret internal detail"))) as unknown as typeof fetch)("https://example.com/"))
    )
    expect(failure.message).toBe("the request failed")
  })
})

describe("webHandler and decodeWebAsk", () => {
  test("an ask is fetchWeb with a url and an optional accept", () => {
    expect(decodeWebAsk({ type: "fetchWeb", url: "https://a" })).toEqual({ type: "fetchWeb", url: "https://a" })
    expect(decodeWebAsk({ type: "fetchWeb", url: "https://a", accept: "json" })).toEqual({ type: "fetchWeb", url: "https://a", accept: "json" })
    expect(decodeWebAsk({ type: "fetchWeb", url: "https://a", accept: "blob" })).toBeUndefined()
    expect(decodeWebAsk({ type: "fetchWeb" })).toBeUndefined()
    expect(decodeWebAsk({ type: "readAsset", url: "https://a" })).toBeUndefined()
  })

  test("the handler answers a page or a failure message, never a rejection", async () => {
    expect(await webHandler(answering("hi", { headers: { "content-type": "text/plain" } }))({ type: "fetchWeb", url: "https://example.com/" })).toMatchObject({
      type: "webFetched",
      page: { status: 200, body: "hi" }
    })
    expect(await webHandler(answering(""))({ type: "fetchWeb", url: "file:///x" })).toEqual({
      type: "webFailed",
      message: "only http and https addresses can be fetched"
    })
  })
})

describe("webSenderAllowed", () => {
  const origin = "chrome-extension://abc/"
  const wearing = (url: string) => Promise.resolve(url === "https://www.cineswellington.com/")

  test("Morph's own pages always may: that is the agent's tool", async () => {
    expect(await webSenderAllowed({ url: "chrome-extension://abc/panel.html" }, origin, wearing)).toBe(true)
  })

  test("a page may only while it wears a Morph, so the worker is no site's proxy", async () => {
    expect(await webSenderAllowed({ url: "https://www.cineswellington.com/", tab: { url: "https://www.cineswellington.com/" } }, origin, wearing)).toBe(true)
    expect(await webSenderAllowed({ url: "https://evil.example/", tab: { url: "https://evil.example/" } }, origin, wearing)).toBe(false)
    expect(await webSenderAllowed({}, origin, wearing)).toBe(false)
  })

  test("a refused sender gets the refusal as the answer, and nothing is fetched", async () => {
    calls.length = 0
    const answer = await webHandler(answering("secret"), () => Promise.resolve(false))({ type: "fetchWeb", url: "https://example.com/" }, { tab: { url: "https://evil.example/" } })
    expect(answer).toEqual({ type: "webFailed", message: NOT_A_MORPH_PAGE })
    expect(calls).toHaveLength(0)
  })
})
