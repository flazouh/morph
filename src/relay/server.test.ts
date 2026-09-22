import { afterEach, describe, expect, test } from "bun:test"
import { Duration, Effect, Exit, Schema, Scope } from "effect"
import WebSocket from "ws"
import { decodeRelayEnvironment } from "./environment"
import {
  SocketOutbound,
  SocketProtocolError,
  SocketRegistered,
  SocketRequest,
  type BridgeId,
  type ResumeSecret,
  type SocketOutbound as SocketOutboundMessage
} from "./protocol"
import { serveRelay, type RelayOptions, type RelayServer } from "./server"

const openSockets: WebSocket[] = []
const openScopes: Scope.Closeable[] = []

afterEach(async () => {
  for (const socket of openSockets.splice(0)) socket.close()
  for (const scope of openScopes.splice(0)) {
    await Effect.runPromise(Scope.close(scope, Exit.void))
  }
})

const openSocket = async (
  url: string,
  origin: string | null = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  headers: Record<string, string> = {}
): Promise<WebSocket> => {
  const socket = new WebSocket(url, {
    headers: { ...(origin === null ? {} : { Origin: origin }), ...headers }
  })
  openSockets.push(socket)
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true })
    socket.addEventListener("error", () => reject(new Error("WebSocket failed to open")), { once: true })
  })
  return socket
}

const nextMessage = (socket: WebSocket): Promise<unknown> =>
  new Promise((resolve, reject) => {
    socket.addEventListener(
      "message",
      (event) => {
        try {
          resolve(JSON.parse(String(event.data)))
        } catch (error) {
          reject(error)
        }
      },
      { once: true }
    )
  })

const nextSocketRequest = async (socket: WebSocket) =>
  Schema.decodeUnknownSync(SocketRequest)(await nextMessage(socket))

const nextRegistration = async (socket: WebSocket) =>
  Schema.decodeUnknownSync(SocketRegistered)(await nextMessage(socket))

const nextSocketError = async (socket: WebSocket) =>
  Schema.decodeUnknownSync(SocketProtocolError)(await nextMessage(socket))

const start = async (options: RelayOptions = {}) => {
  const scope = Effect.runSync(Scope.make())
  openScopes.push(scope)
  return Effect.runPromise(Scope.provide(serveRelay({ port: 0, ...options }), scope))
}

const register = async (
  relay: RelayServer
): Promise<{ socket: WebSocket; bridgeId: BridgeId; mcpUrl: string; token: ResumeSecret }> => {
  const socket = await openSocket(`${relay.url.replace("http", "ws")}/ws`)
  const registrationMessage = nextRegistration(socket)
  socket.send(JSON.stringify({ type: "register" }))
  const registration = await registrationMessage
  expect(registration).toEqual({
    type: "registered",
    bridgeId: expect.any(String),
    token: expect.any(String),
    mcpUrl: `${relay.url}/mcp/${registration.bridgeId}`
  })
  return {
    socket,
    bridgeId: registration.bridgeId,
    mcpUrl: registration.mcpUrl,
    token: registration.token
  }
}

const rpc = (
  mcpUrl: string,
  token: string | null,
  method: string,
  params: unknown = {},
  id: string | number = 1
) =>
  fetch(mcpUrl, {
    method: "POST",
    headers: {
      ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream"
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params })
  })

/** The deployed relay, behind Railway's TLS terminator. */
const PRODUCTION_ORIGIN = "https://morph-relay-production.up.railway.app"
const MORPH_EXTENSION_ORIGIN = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const OTHER_EXTENSION_ORIGIN = "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

describe("relay public boundary", () => {
  test("mints the bridge id and secret during initial registration", async () => {
    const relay = await start()
    const socket = await openSocket(`${relay.url.replace("http", "ws")}/ws`)
    const response = nextMessage(socket)
    socket.send(JSON.stringify({ type: "register" }))

    expect(await response).toEqual({
      type: "registered",
      bridgeId: expect.any(String),
      token: expect.any(String),
      mcpUrl: expect.stringContaining("/mcp/")
    })
  })

  test("refuses a client-selected bridge id during initial registration", async () => {
    const relay = await start()
    const socket = await openSocket(`${relay.url.replace("http", "ws")}/ws`)
    const response = nextMessage(socket)
    socket.send(
      JSON.stringify({
        type: "register",
        bridgeId: "11111111-1111-4111-8111-111111111111",
        token: "client-selected"
      })
    )

    expect(await response).toEqual({
      type: "error",
      error: "Invalid WebSocket message"
    })
  })

  test("rejects repeated registration on one socket", async () => {
    const relay = await start()
    const registration = await register(relay)
    const response = nextMessage(registration.socket)
    registration.socket.send(JSON.stringify({ type: "register" }))

    expect(await response).toEqual({
      type: "error",
      error: "Socket already owns a bridge"
    })
    registration.socket.close()
    await new Promise<void>((resolve) => {
      registration.socket.addEventListener("close", () => resolve(), { once: true })
    })
    expect(
      await (await rpc(registration.mcpUrl, registration.token, "tools/list")).json()
    ).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32002, message: "The reader closed the panel" }
    })
  })

  test("atomically rejects two immediate registrations on one socket", async () => {
    const relay = await start()
    const socket = await openSocket(`${relay.url.replace("http", "ws")}/ws`)
    const responses = new Promise<SocketOutboundMessage[]>((resolve) => {
      const messages: SocketOutboundMessage[] = []
      socket.addEventListener("message", (event) => {
        messages.push(
          Schema.decodeUnknownSync(SocketOutbound)(JSON.parse(String(event.data)))
        )
        if (messages.length === 2) resolve(messages)
      })
    })

    socket.send(JSON.stringify({ type: "register" }))
    socket.send(JSON.stringify({ type: "register" }))

    expect((await responses).map((message) => message.type).toSorted()).toEqual([
      "error",
      "registered"
    ])
  })

  test("refuses reconnect for a bridge that does not exist", async () => {
    const relay = await start()
    const socket = await openSocket(`${relay.url.replace("http", "ws")}/ws`)
    const response = nextSocketError(socket)
    socket.send(
      JSON.stringify({
        type: "reconnect",
        bridgeId: "11111111-1111-4111-8111-111111111111",
        token: "22222222-2222-4222-8222-222222222222"
      })
    )

    expect(await response).toEqual({
      type: "error",
      error: "Bridge does not exist"
    })
  })

  test("answers a keepalive ping with a pong, before and after registration", async () => {
    const relay = await start()
    const socket = await openSocket(`${relay.url.replace("http", "ws")}/ws`)
    const early = nextMessage(socket)
    socket.send(JSON.stringify({ type: "ping" }))
    expect(await early).toEqual({ type: "pong" })

    const registrationMessage = nextRegistration(socket)
    socket.send(JSON.stringify({ type: "register" }))
    const registration = await registrationMessage

    const late = nextMessage(socket)
    socket.send(JSON.stringify({ type: "ping" }))
    expect(await late).toEqual({ type: "pong" })

    // The ping is not a second registration, so the bridge still serves its thread.
    const request = nextSocketRequest(socket)
    const answering = rpc(registration.mcpUrl, registration.token, "tools/call", { name: "look" })
    const asked = await request
    socket.send(
      JSON.stringify({ type: "response", id: asked.id, result: { content: [] } })
    )
    expect(await (await answering).json()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [] }
    })
  })

  test("rejects untrusted HTTP and WebSocket origins", async () => {
    const relay = await start()
    const registration = await register(relay)
    const httpResponse = await fetch(registration.mcpUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${registration.token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Origin: "https://evil.example"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "1" }
        }
      })
    })

    expect(httpResponse.status).toBe(403)
    await expect(
      openSocket(`${relay.url.replace("http", "ws")}/ws`, "https://evil.example")
    ).rejects.toThrow("WebSocket failed to open")
    await expect(
      openSocket(`${relay.url.replace("http", "ws")}/ws`, null)
    ).rejects.toThrow("WebSocket failed to open")
  })

  test("accepts an exact origin from the decoded production allowlist", async () => {
    const environment = Effect.runSync(
      decodeRelayEnvironment({
        RELAY_ALLOWED_ORIGINS: "[\"https://relay.example\"]"
      })
    )
    const relay = await start({
      allowedOrigins: environment.RELAY_ALLOWED_ORIGINS
    })
    const socket = await openSocket(
      `${relay.url.replace("http", "ws")}/ws`,
      "https://relay.example"
    )
    const registrationResponse = nextRegistration(socket)
    socket.send(JSON.stringify({ type: "register" }))
    const registration = await registrationResponse

    const response = await fetch(registration.mcpUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${registration.token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Origin: "https://relay.example"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "1" }
        }
      })
    })

    expect(response.status).toBe(200)
  })

  test("mints the configured public MCP URL behind a TLS-terminating proxy", async () => {
    const environment = Effect.runSync(
      decodeRelayEnvironment({ RELAY_PUBLIC_ORIGIN: PRODUCTION_ORIGIN })
    )
    const relay = await start({ publicOrigin: environment.RELAY_PUBLIC_ORIGIN })
    // Railway terminates TLS and forwards plain HTTP, with the public name in the headers.
    const socket = await openSocket(`${relay.url.replace("http", "ws")}/ws`, undefined, {
      Host: "morph-relay-production.up.railway.app",
      "X-Forwarded-Proto": "https",
      "X-Forwarded-Host": "morph-relay-production.up.railway.app"
    })
    const registrationMessage = nextRegistration(socket)
    socket.send(JSON.stringify({ type: "register" }))
    const registration = await registrationMessage

    expect(registration.mcpUrl).toBe(`${PRODUCTION_ORIGIN}/mcp/${registration.bridgeId}`)
  })

  test("never lets a request header choose the MCP URL", async () => {
    const relay = await start()
    const socket = await openSocket(`${relay.url.replace("http", "ws")}/ws`, undefined, {
      Host: "evil.example",
      "X-Forwarded-Proto": "https",
      "X-Forwarded-Host": "evil.example"
    })
    const registrationMessage = nextRegistration(socket)
    socket.send(JSON.stringify({ type: "register" }))
    const registration = await registrationMessage

    expect(registration.mcpUrl).toBe(`${relay.url}/mcp/${registration.bridgeId}`)
  })

  test("accepts an MCP call that sends no Origin, the Cursor server-to-server case", async () => {
    const relay = await start({
      allowedOrigins: [],
      publicOrigin: undefined
    })
    const { socket, mcpUrl, token } = await register(relay)
    const socketRequest = nextSocketRequest(socket)
    const answering = rpc(mcpUrl, token, "tools/list")

    const asked = await socketRequest
    socket.send(JSON.stringify({ type: "response", id: asked.id, result: { tools: [] } }))

    const response = await answering
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ jsonrpc: "2.0", id: 1, result: { tools: [] } })
  })

  test("only a configured extension origin may open the relay socket", async () => {
    const environment = Effect.runSync(
      decodeRelayEnvironment({
        RELAY_EXTENSION_ORIGINS: JSON.stringify([MORPH_EXTENSION_ORIGIN])
      })
    )
    const relay = await start({ extensionOrigins: environment.RELAY_EXTENSION_ORIGINS })
    const allowed = await openSocket(`${relay.url.replace("http", "ws")}/ws`, MORPH_EXTENSION_ORIGIN)
    expect(allowed.readyState).toBe(WebSocket.OPEN)

    await expect(
      openSocket(`${relay.url.replace("http", "ws")}/ws`, OTHER_EXTENSION_ORIGIN)
    ).rejects.toThrow("WebSocket failed to open")
  })

  test("registers a thread and forwards tools/list over MCP HTTP", async () => {
    const relay = await start()
    const { socket, mcpUrl, token } = await register(relay)

    const socketRequest = nextSocketRequest(socket)
    const responsePromise = rpc(mcpUrl, token, "tools/list")

    const request = await socketRequest
    expect(request).toEqual({
      type: "request",
      id: expect.any(String),
      method: "tools/list",
      params: {}
    })
    socket.send(
      JSON.stringify({
        type: "response",
        id: request.id,
        result: {
          tools: [{ name: "look", description: "Look at the page", inputSchema: { type: "object" } }]
        }
      })
    )

    const response = await responsePromise
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("application/json")
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        tools: [{ name: "look", description: "Look at the page", inputSchema: { type: "object" } }]
      }
    })
  })

  test("uses an opaque bridge id without a thread id or page URL", async () => {
    const relay = await start()
    const registration = await register(relay)
    const url = new URL(registration.mcpUrl)

    expect(registration.bridgeId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
    expect(url.pathname).toBe(`/mcp/${registration.bridgeId}`)
    expect(registration.mcpUrl).not.toContain("morph-thread-private")
    expect(registration.mcpUrl).not.toContain("example.com")
  })

  test("round-trips a tool input and image result unchanged", async () => {
    const relay = await start()
    const { socket, mcpUrl, token } = await register(relay)
    const input = { name: "look", arguments: { target: "main", scale: 2 } }
    const imageResult = {
      content: [
        { type: "text", text: "Current page" },
        { type: "image", data: "iVBORw0KGgoAAAANSUhEUg==", mimeType: "image/png" }
      ]
    }

    const socketRequest = nextSocketRequest(socket)
    const responsePromise = rpc(mcpUrl, token, "tools/call", input, "call-1")
    const request = await socketRequest
    expect(request.params).toEqual(input)
    socket.send(JSON.stringify({ type: "response", id: request.id, result: imageResult }))

    expect(await (await responsePromise).json()).toEqual({
      jsonrpc: "2.0",
      id: "call-1",
      result: imageResult
    })
  })

  test("matches concurrent responses to their HTTP callers", async () => {
    const relay = await start()
    const { socket, mcpUrl, token } = await register(relay)
    const firstRequest = nextSocketRequest(socket)
    const firstResponse = rpc(mcpUrl, token, "tools/call", { name: "first" }, 10)
    const first = await firstRequest
    const secondRequest = nextSocketRequest(socket)
    const secondResponse = rpc(mcpUrl, token, "tools/call", { name: "second" }, 20)
    const second = await secondRequest

    expect(first.id).not.toBe(second.id)
    socket.send(JSON.stringify({ type: "response", id: second.id, result: { content: [{ type: "text", text: "two" }] } }))
    socket.send(JSON.stringify({ type: "response", id: first.id, result: { content: [{ type: "text", text: "one" }] } }))

    expect(await (await firstResponse).json()).toEqual({
      jsonrpc: "2.0",
      id: 10,
      result: { content: [{ type: "text", text: "one" }] }
    })
    expect(await (await secondResponse).json()).toEqual({
      jsonrpc: "2.0",
      id: 20,
      result: { content: [{ type: "text", text: "two" }] }
    })
  })

  test("refuses missing and wrong tokens without reaching the socket", async () => {
    const relay = await start()
    const { socket, mcpUrl, token } = await register(relay)
    const received: unknown[] = []
    socket.addEventListener("message", (event) => received.push(JSON.parse(String(event.data))))

    const missing = await rpc(mcpUrl, null, "tools/list", {}, "missing")
    const wrong = await rpc(mcpUrl, "wrong-token", "tools/call", { name: "look" }, "wrong")
    await Bun.sleep(10)

    expect(await missing.json()).toEqual({
      jsonrpc: "2.0",
      id: "missing",
      error: { code: -32001, message: "Missing or invalid bearer token" }
    })
    expect(await wrong.json()).toEqual({
      jsonrpc: "2.0",
      id: "wrong",
      error: { code: -32001, message: "Missing or invalid bearer token" }
    })
    expect(received).toEqual([])
  })

  test("reports that the reader closed the panel when the socket is gone", async () => {
    const relay = await start()
    const { socket, mcpUrl, token } = await register(relay)
    socket.close()
    await new Promise<void>((resolve) => socket.addEventListener("close", () => resolve(), { once: true }))

    expect(await (await rpc(mcpUrl, token, "tools/list")).json()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32002, message: "The reader closed the panel" }
    })
  })

  test("finishes an in-flight call when its socket closes", async () => {
    const relay = await start()
    const { socket, mcpUrl, token } = await register(relay)
    const socketRequest = nextSocketRequest(socket)
    const responsePromise = rpc(mcpUrl, token, "tools/call", { name: "look" })
    await socketRequest
    socket.close()

    expect(await (await responsePromise).json()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32002, message: "The reader closed the panel" }
    })
  })

  test("reconnects without replaying an in-flight tool call", async () => {
    const relay = await start()
    const first = await register(relay)
    const firstRequest = nextSocketRequest(first.socket)
    const responsePromise = rpc(first.mcpUrl, first.token, "tools/call", { name: "look" })
    await firstRequest

    const replacement = await openSocket(`${relay.url.replace("http", "ws")}/ws`)
    const replacementMessages: SocketOutboundMessage[] = []
    replacement.addEventListener("message", (event) => {
      replacementMessages.push(
        Schema.decodeUnknownSync(SocketOutbound)(JSON.parse(String(event.data)))
      )
    })
    const registered = new Promise<SocketOutboundMessage>((resolve) => {
      const messages: SocketOutboundMessage[] = []
      replacement.addEventListener("message", (event) => {
        const message = Schema.decodeUnknownSync(SocketOutbound)(JSON.parse(String(event.data)))
        messages.push(message)
        if (messages.length === 1) resolve(message)
      })
    })
    replacement.send(
      JSON.stringify({ type: "reconnect", bridgeId: first.bridgeId, token: first.token })
    )

    expect(await registered).toEqual({
      type: "registered",
      bridgeId: first.bridgeId,
      token: first.token,
      mcpUrl: first.mcpUrl
    })
    await Bun.sleep(20)
    expect(replacementMessages).toHaveLength(1)
    expect(await (await responsePromise).json()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32002, message: "The reader closed the panel" }
    })
  })

  test("does not let another token replace a registered bridge", async () => {
    const relay = await start()
    const first = await register(relay)
    const attacker = await openSocket(`${relay.url.replace("http", "ws")}/ws`)
    const refusal = nextSocketError(attacker)
    attacker.send(
      JSON.stringify({
        type: "reconnect",
        bridgeId: first.bridgeId,
        token: "22222222-2222-4222-8222-222222222222"
      })
    )
    expect(await refusal).toEqual({
      type: "error",
      error: "Bridge token does not match"
    })

    const socketRequest = nextSocketRequest(first.socket)
    const responsePromise = rpc(first.mcpUrl, first.token, "tools/list")
    const request = await socketRequest
    first.socket.send(JSON.stringify({ type: "response", id: request.id, result: { tools: [] } }))
    expect(await (await responsePromise).json()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { tools: [] }
    })
  })

  test("times out a slow socket and accepts a later call", async () => {
    const relay = await start({ requestTimeout: Duration.millis(10) })
    const { socket, mcpUrl, token } = await register(relay)
    const slowRequest = nextSocketRequest(socket)
    const slowResponse = rpc(mcpUrl, token, "tools/call", { name: "slow" }, "slow")
    const slow = await slowRequest

    expect(await (await slowResponse).json()).toEqual({
      jsonrpc: "2.0",
      id: "slow",
      error: { code: -32003, message: "The reader did not answer before the timeout" }
    })
    socket.send(JSON.stringify({ type: "response", id: slow.id, result: { stale: true } }))

    const nextRequest = nextSocketRequest(socket)
    const nextResponse = rpc(mcpUrl, token, "tools/call", { name: "next" }, "next")
    const next = await nextRequest
    socket.send(JSON.stringify({ type: "response", id: next.id, result: { content: [] } }))
    expect(await (await nextResponse).json()).toEqual({
      jsonrpc: "2.0",
      id: "next",
      result: { content: [] }
    })
  })

  test("rejects a socket response with both result and error", async () => {
    const relay = await start({ requestTimeout: Duration.millis(50) })
    const registration = await register(relay)
    const request = nextSocketRequest(registration.socket)
    const responsePromise = rpc(
      registration.mcpUrl,
      registration.token,
      "tools/call",
      { name: "look" }
    )
    const forwarded = await request
    const protocolResponse = nextMessage(registration.socket)
    registration.socket.send(
      JSON.stringify({
        type: "response",
        id: forwarded.id,
        result: { content: [] },
        error: { message: "ambiguous" }
      })
    )

    expect(await protocolResponse).toEqual({
      type: "error",
      error: "Invalid WebSocket message"
    })
    expect(await (await responsePromise).json()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32003, message: "The reader did not answer before the timeout" }
    })
  })

  test("drops a disconnected thread after its idle period", async () => {
    const relay = await start({
      idleTimeout: Duration.millis(20),
      cleanupInterval: Duration.millis(5)
    })
    const { socket, mcpUrl, token } = await register(relay)
    socket.close()
    await new Promise<void>((resolve) => socket.addEventListener("close", () => resolve(), { once: true }))
    await Bun.sleep(30)

    expect(await (await rpc(mcpUrl, token, "tools/list")).json()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32004, message: "Unknown or expired thread" }
    })
  })

  test("does not expose tool payloads through console logs", async () => {
    const relay = await start()
    const { socket, mcpUrl, token } = await register(relay)
    const sensitiveInput = "private-page-input"
    const sensitiveResult = "private-tool-result"
    const logged: unknown[][] = []
    const originalLog = console.log
    const originalError = console.error
    console.log = (...args) => logged.push(args)
    console.error = (...args) => logged.push(args)
    try {
      const socketRequest = nextSocketRequest(socket)
      const responsePromise = rpc(mcpUrl, token, "tools/call", {
        name: "run_script",
        arguments: { source: sensitiveInput }
      })
      const request = await socketRequest
      socket.send(
        JSON.stringify({
          type: "response",
          id: request.id,
          result: { content: [{ type: "text", text: sensitiveResult }] }
        })
      )
      await responsePromise
    } finally {
      console.log = originalLog
      console.error = originalError
    }

    const output = JSON.stringify(logged)
    expect(output).not.toContain(sensitiveInput)
    expect(output).not.toContain(sensitiveResult)
  })

  test("supports MCP initialization and a health check", async () => {
    const relay = await start()
    const { mcpUrl, token } = await register(relay)

    expect(await (await fetch(`${relay.url}/health`)).json()).toEqual({ status: "ok" })
    expect(await (await rpc(mcpUrl, token, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" }
    })).json()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "morph-relay", version: "1.0.0" }
      }
    })
  })

  test("enforces Streamable HTTP media types", async () => {
    const relay = await start()
    const { mcpUrl, token } = await register(relay)
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })

    const badContentType = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "text/plain",
        Accept: "application/json, text/event-stream"
      },
      body
    })
    expect(badContentType.status).toBe(415)

    const badAccept = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body
    })
    expect(badAccept.status).toBe(406)
  })
})
