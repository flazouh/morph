import { BunRuntime } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { decodeRelayEnvironment } from "./environment"
import { relayServerLayer } from "./server"

/**
 * The relay as Railway runs it.
 *
 * Railway terminates TLS and forwards plain HTTP to this process, so the address the
 * relay sees for itself is `http://` on a private port. The MCP URL it mints is handed to
 * a Cursor cloud agent, which must reach it over the public name, so that origin is
 * configuration and never a request header.
 *
 * Railway variables the deployed service needs:
 *
 * - `RELAY_PUBLIC_ORIGIN=https://morph-relay-production.up.railway.app`
 * - `RELAY_EXTENSION_ORIGINS=["chrome-extension://<the published extension id>"]`
 * - `RELAY_ALLOWED_ORIGINS` stays unset: Cursor calls server to server and sends no
 *   `Origin`, and no browser page is meant to reach `/mcp`.
 */
decodeRelayEnvironment(Bun.env).pipe(
  Effect.flatMap((environment) =>
    relayServerLayer({
      allowedOrigins: environment.RELAY_ALLOWED_ORIGINS ?? [],
      extensionOrigins: environment.RELAY_EXTENSION_ORIGINS ?? [],
      publicOrigin: environment.RELAY_PUBLIC_ORIGIN,
      hostname: "0.0.0.0",
      port: environment.PORT ?? 3000
    }).pipe(Layer.launch)
  ),
  BunRuntime.runMain
)
