import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { makePageFetch } from "./page-fetch"

describe("page capability fetch", () => {
  test("uses only the firewall-approved session and headers", async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    const fetchPage = makePageFetch(async (input, init) => {
      calls.push({ input, init })
      return new Response(JSON.stringify({ payload: { results: [] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    })

    const result = await Effect.runPromise(
      fetchPage({
        url: "https://github.com/pulls/inbox/queries?filter=needs-action",
        method: "GET",
        accept: "application/json",
        requestedWith: "XMLHttpRequest",
        credentials: "include",
        body: undefined,
        contentType: undefined,
        verifiedFetch: undefined
      })
    )

    expect(calls).toEqual([
      {
        input: "https://github.com/pulls/inbox/queries?filter=needs-action",
        init: {
          method: "GET",
          headers: { Accept: "application/json", "X-Requested-With": "XMLHttpRequest" },
          credentials: "include",
          redirect: "error",
          referrerPolicy: "no-referrer",
          signal: expect.any(AbortSignal)
        }
      }
    ])
    expect(result).toEqual({ status: 200, body: { payload: { results: [] } } })
  })
})
