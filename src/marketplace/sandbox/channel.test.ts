import { describe, expect, test } from "bun:test"
import { Effect, Option, Ref } from "effect"
import { acceptGuestReady, acceptHostInit } from "./channel"

const ready = { type: "morph:ready" }
const fromGuest = { sourceMatches: true, origin: "null", message: ready }

describe("guest ready gate", () => {
  test("accepts one valid ready message from the expected sandbox", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const connected = yield* Ref.make(false)
        const first = yield* acceptGuestReady(connected, fromGuest)
        const second = yield* acceptGuestReady(connected, fromGuest)
        return { first, second }
      })
    )

    expect(result).toEqual({ first: true, second: false })
  })

  test("rejects a foreign sender, a real origin, or malformed data without consuming the connection", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const connected = yield* Ref.make(false)
        const foreign = yield* acceptGuestReady(connected, { ...fromGuest, sourceMatches: false })
        const page = yield* acceptGuestReady(connected, { ...fromGuest, origin: "https://github.com" })
        const malformed = yield* acceptGuestReady(connected, { ...fromGuest, message: { ...ready, request: "smuggled" } })
        const valid = yield* acceptGuestReady(connected, fromGuest)
        return { foreign, page, malformed, valid }
      })
    )

    expect(result).toEqual({ foreign: false, page: false, malformed: false, valid: true })
  })
})

const init = {
  type: "morph:init",
  nonce: "n-1",
  code: "1",
  css: "",
  at: "https://github.com/pulls",
  lends: { storage: false, navigate: false, traverse: false, assets: false }
} as const
const fromHost = { nonce: "n-1", sourceIsParent: true, ports: 1, message: init }

describe("host init gate", () => {
  test("accepts one init that carries the frame nonce", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const connected = yield* Ref.make(false)
        const first = yield* acceptHostInit(connected, fromHost)
        const second = yield* acceptHostInit(connected, fromHost)
        return { first: Option.getOrNull(first), second: Option.isNone(second) }
      })
    )

    expect(result).toEqual({ first: init, second: true })
  })

  test("rejects a wrong nonce, a missing nonce, a non-parent sender, or a wrong port count without consuming the connection", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const connected = yield* Ref.make(false)
        const wrongNonce = yield* acceptHostInit(connected, { ...fromHost, message: { ...init, nonce: "guess" } })
        const noNonce = yield* acceptHostInit(connected, { ...fromHost, nonce: "", message: { ...init, nonce: "" } })
        const notParent = yield* acceptHostInit(connected, { ...fromHost, sourceIsParent: false })
        const noPort = yield* acceptHostInit(connected, { ...fromHost, ports: 0 })
        const twoPorts = yield* acceptHostInit(connected, { ...fromHost, ports: 2 })
        const extra = yield* acceptHostInit(connected, { ...fromHost, message: { ...init, secrets: "smuggled" } })
        const valid = yield* acceptHostInit(connected, fromHost)
        return [wrongNonce, noNonce, notParent, noPort, twoPorts, extra].map(Option.isNone).concat(Option.isSome(valid))
      })
    )

    expect(result).toEqual([true, true, true, true, true, true, true])
  })
})
