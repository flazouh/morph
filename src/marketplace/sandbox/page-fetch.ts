import { Effect } from "effect"
import { CapabilityPortFailure, type CapabilityPorts } from "./firewall"

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export const makePageFetch = (fetch: Fetch): CapabilityPorts["fetch"] =>
  Effect.fn("sandbox.pageFetch")(function* ({ url, method, accept, requestedWith, credentials, body, contentType, verifiedFetch }) {
    return yield* Effect.tryPromise({
      try: async (signal) => {
        const response = await fetch(url, {
          method,
          headers: {
            ...(accept === undefined ? {} : { Accept: accept }),
            ...(requestedWith === undefined ? {} : { "X-Requested-With": requestedWith }),
            ...(contentType === undefined ? {} : { "Content-Type": contentType }),
            ...(verifiedFetch ? { "GitHub-Verified-Fetch": "true" } : {})
          },
          credentials,
          redirect: "error",
          referrerPolicy: "no-referrer",
          ...(body === undefined ? {} : { body }),
          signal
        })
        return {
          status: response.status,
          body: accept === "application/json" ? ((await response.json()) as unknown) : await response.text()
        }
      },
      catch: () => new CapabilityPortFailure({ message: "declared network request failed" })
    })
  })
