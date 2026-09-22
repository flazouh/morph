import { Schema } from "effect"

/**
 * The wire between Morph's trusted host and the sandboxed guest frame.
 *
 * `ready` and `init` cross the window boundary once to open a private
 * `MessageChannel`. Requests, cancellation, and responses then travel on that channel
 * only, where no page script can hear them. Every decoder refuses extra fields.
 */

export const GuestReady = Schema.Struct({ type: Schema.Literals(["morph:ready"]) })

export const HostInit = Schema.Struct({
  type: Schema.Literals(["morph:init"]),
  /** The secret the host put in the frame's URL fragment; only the guest and the host can read it. */
  nonce: Schema.String,
  code: Schema.String,
  /** The package's stylesheet. The host cannot reach into an opaque origin, so the guest applies it. */
  css: Schema.String,
  /**
   * The address of the page the package took over.
   *
   * The frame's own address is an extension URL and names nothing a reader can visit, so
   * this is what a relative link inside the package resolves against.
   */
  at: Schema.String,
  /**
   * Which parts of a browser the frame may stand in for, read off the same manifest the
   * firewall reads.
   *
   * A sandboxed frame with an opaque origin throws on `localStorage`, refuses to follow a
   * link, refuses to walk history and has no network for an image. The guest puts each of
   * those back by asking the host, and it only does so where the package declared the
   * matching capability — otherwise every package would get a browser Morph never granted
   * it, and the refusal would arrive as a dead control rather than as an undeclared one.
   */
  lends: Schema.Struct({
    storage: Schema.Boolean,
    navigate: Schema.Boolean,
    traverse: Schema.Boolean,
    assets: Schema.Boolean
  })
})

export const GuestMessage = Schema.Union([
  Schema.Struct({
    type: Schema.Literals(["morph:started"])
  }),
  Schema.Struct({
    type: Schema.Literals(["morph:start-failed"]),
    error: Schema.String
  }),
  Schema.Struct({
    type: Schema.Literals(["morph:request"]),
    id: Schema.String,
    request: Schema.Unknown
  }),
  Schema.Struct({
    type: Schema.Literals(["morph:cancel"]),
    id: Schema.String
  }),
  /** How tall the package drew itself. The guest cannot resize its own frame. */
  Schema.Struct({
    type: Schema.Literals(["morph:size"]),
    height: Schema.Number
  })
])

export const HostResponse = Schema.Union([
  Schema.Struct({ type: Schema.Literals(["morph:response"]), id: Schema.String, ok: Schema.Literal(true), value: Schema.Unknown }),
  Schema.Struct({ type: Schema.Literals(["morph:response"]), id: Schema.String, ok: Schema.Literal(false), error: Schema.String })
])

export type HostInit = typeof HostInit["Type"]
export type GuestMessage = typeof GuestMessage["Type"]
export type HostResponse = typeof HostResponse["Type"]

const strict = { onExcessProperty: "error" } as const

export const decodeGuestReady = Schema.decodeUnknownEffect(GuestReady, strict)
export const decodeHostInit = Schema.decodeUnknownEffect(HostInit, strict)
export const decodeGuestMessage = Schema.decodeUnknownEffect(GuestMessage, strict)
export const decodeHostResponse = Schema.decodeUnknownEffect(HostResponse, strict)
export const decodeGuestReadyOption = Schema.decodeUnknownOption(GuestReady, strict)
export const decodeHostInitOption = Schema.decodeUnknownOption(HostInit, strict)
