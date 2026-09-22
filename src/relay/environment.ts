/**
 * How the deployed relay is configured, and nothing the browser side needs.
 *
 * The wire contract lives in `protocol.ts`, which the extension imports. Railway's
 * variables are the server's own, so they stay here and never ship inside the extension.
 */

import { Schema } from "effect"

const Port = Schema.NumberFromString.pipe(
  Schema.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 65_535 }))
)

export const AllowedOrigin = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value) => {
      const url = URL.parse(value)
      return (
        url !== null &&
        (url.protocol === "http:" || url.protocol === "https:") &&
        url.origin === value
      )
    })
  )
)
export type AllowedOrigin = typeof AllowedOrigin.Type

export const ChromeExtensionOrigin = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^chrome-extension:\/\/[a-p]{32}$/))
)
export type ChromeExtensionOrigin = typeof ChromeExtensionOrigin.Type

const AllowedOrigins = Schema.fromJsonString(Schema.Array(AllowedOrigin))
const ExtensionOrigins = Schema.fromJsonString(Schema.Array(ChromeExtensionOrigin))

export const RelayEnvironment = Schema.Struct({
  PORT: Schema.optionalKey(Port),
  /**
   * The origin the reader's cloud agent must call back through. Railway terminates TLS
   * and forwards plain HTTP, so the address the relay sees for itself is not the address
   * Cursor can reach. Set this to the public `https://` origin of the deployed service.
   */
  RELAY_PUBLIC_ORIGIN: Schema.optionalKey(AllowedOrigin),
  /** Exact browser origins that may POST to `/mcp`. Cursor itself sends no Origin. */
  RELAY_ALLOWED_ORIGINS: Schema.optionalKey(AllowedOrigins),
  /** Exact extension origins that may open `/ws`. Unset accepts any well-formed one. */
  RELAY_EXTENSION_ORIGINS: Schema.optionalKey(ExtensionOrigins)
})
export type RelayEnvironment = typeof RelayEnvironment.Type

export const decodeRelayEnvironment = Schema.decodeUnknownEffect(RelayEnvironment)
