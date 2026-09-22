import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { directWeb, Web } from "./web"

const answering = (body: string, init: ResponseInit = {}): typeof fetch =>
  ((): Promise<Response> => Promise.resolve(new Response(body, init))) as unknown as typeof fetch

describe("directWeb", () => {
  test("the worker reads the web itself: no message, so no missing answer", async () => {
    const page = await Effect.runPromise(
      Effect.flatMap(Web, (web) => web.fetch("https://api.example.com/film/1", "json")).pipe(
        Effect.provide(directWeb(answering('{"rating":8.1}', { status: 200, headers: { "content-type": "application/json" } })))
      )
    )
    expect(page.status).toBe(200)
    expect(page.body).toBe('{"rating":8.1}')
  })

  test("a refused address is the same failure the worker gives a page", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        Effect.flatMap(Web, (web) => web.fetch("file:///etc/passwd", "text")).pipe(
          Effect.provide(directWeb(answering("")))
        )
      )
    )
    expect(failure._tag).toBe("WebFailure")
    expect(failure.message).toContain("http")
  })
})
