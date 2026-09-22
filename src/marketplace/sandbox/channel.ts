import { Effect, Option, Ref } from "effect"
import { decodeGuestReady, decodeHostInit, type HostInit } from "./messages"

/**
 * The two gates on the window boundary.
 *
 * A window `message` event is public: on a web page the page's own scripts see the same
 * events Morph's content script sees, and can post their own. So each side accepts exactly
 * one handshake message, and only from the peer it expects.
 */

interface GuestReadyAttempt {
  /** Whether `event.source` is the sandbox frame's window. */
  readonly sourceMatches: boolean
  /** `event.origin`; a sandboxed frame has the opaque origin, spelled `"null"`. */
  readonly origin: string
  readonly message: unknown
}

/** The host accepts one `ready` from its own sandbox frame, and never a second. */
export const acceptGuestReady = Effect.fn("sandbox.acceptGuestReady")(function* (
  connected: Ref.Ref<boolean>,
  attempt: GuestReadyAttempt
) {
  if (!attempt.sourceMatches || attempt.origin !== "null") return false
  const ready = yield* decodeGuestReady(attempt.message).pipe(Effect.option)
  if (Option.isNone(ready)) return false
  return !(yield* Ref.getAndSet(connected, true))
})

interface HostInitAttempt {
  /** The secret the guest read from its own URL fragment. */
  readonly nonce: string
  /** Whether `event.source` is the parent window. */
  readonly sourceIsParent: boolean
  /** How many `MessagePort`s came with the event; the host sends exactly one. */
  readonly ports: number
  readonly message: unknown
}

/**
 * The guest accepts one `init`, and only one that knows the nonce.
 *
 * The parent window is the page, and on a web page any script in it can post to a frame.
 * The nonce is what tells Morph's message from the page's: it travels in the frame URL,
 * which only the host that built the frame and the guest inside it can read.
 */
export const acceptHostInit = Effect.fn("sandbox.acceptHostInit")(function* (
  connected: Ref.Ref<boolean>,
  attempt: HostInitAttempt
): Effect.fn.Return<Option.Option<HostInit>> {
  if (!attempt.sourceIsParent || attempt.ports !== 1 || attempt.nonce === "") return Option.none()
  const init = yield* decodeHostInit(attempt.message).pipe(Effect.option)
  if (Option.isNone(init) || init.value.nonce !== attempt.nonce) return Option.none()
  return (yield* Ref.getAndSet(connected, true)) ? Option.none() : init
})
