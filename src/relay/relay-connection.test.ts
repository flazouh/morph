import { describe, expect, test } from "bun:test"
import { Effect, Exit, Fiber, Layer, Queue, Scope } from "effect"
import {
  ExtensionRelay,
  RelayConnectionError,
  RelayLink,
  RelayThreadOwnership,
  type RelayConnection,
  type RelayWebSocket
} from "./extension"
import { BridgeId, ResumeSecret, type SocketInbound, type SocketOutbound } from "./protocol"
import { askUserCallId, CURSOR_TOOL_NAMES, fakeWorld, memoryLink, waitUntil } from "./testing"

describe("extension relay connection", () => {
  test("closes a WebSocket when connection acquisition is interrupted", async () => {
    let closes = 0
    class PendingSocket extends EventTarget implements RelayWebSocket {
      close() {
        closes += 1
      }
      send() {}
    }
    const socket = new PendingSocket()
    const acquisition = Effect.runFork(
      Effect.scoped(
        Effect.provide(
          RelayLink.use((link) => link.connect("wss://relay.example/ws")),
          RelayLink.webSocketLayerWith(() => socket)
        )
      )
    )
    await Bun.sleep(1)
    await Effect.runPromise(Fiber.interrupt(acquisition))

    expect(closes).toBe(1)
  })

  test("allows only one tab to own an active site thread", async () => {
    const program = Effect.gen(function* () {
      const ownership = yield* RelayThreadOwnership
      const firstScope = yield* Scope.make()
      yield* Scope.provide(ownership.claim("thread-1", 7), firstScope)

      const conflict = yield* Effect.exit(
        Effect.scoped(ownership.claim("thread-1", 8))
      )
      expect(conflict._tag).toBe("Failure")

      yield* Scope.close(firstScope, Exit.void)
      yield* Effect.scoped(ownership.claim("thread-1", 8))
    })

    await Effect.runPromise(
      Effect.provide(program, RelayThreadOwnership.layer)
    )
  })

  test("reports an identity only while a registered relay connection is live", async () => {
    const connections = memoryLink()
    const scope = Effect.runSync(Scope.make())
    const relay = await Effect.runPromise(
      Scope.provide(
        Effect.provide(
          ExtensionRelay.make({
            relayUrl: "https://relay.example",
            threadId: "thread-live",
            tabId: 3,
            pageUrl: "https://example.com/products",
            world: fakeWorld(),
            reconnectBaseDelayMs: 1,
            onStep: () => Effect.void
          }),
          Layer.merge(connections.layer, RelayThreadOwnership.layer)
        ),
        scope
      )
    )
    const connected = () => Effect.runPromise(relay.connected())

    await waitUntil(() => connections.list.length === 1, "the first connection")
    expect(await connected()).toBeUndefined()

    const first = BridgeId.make("11111111-1111-4111-8111-111111111111")
    const token = ResumeSecret.make("22222222-2222-4222-8222-222222222222")
    await Effect.runPromise(
      Queue.offer(connections.list[0]!.incoming, {
        type: "registered",
        bridgeId: first,
        token,
        mcpUrl: "https://relay.example/mcp/first"
      })
    )
    await waitUntil(async () => (await connected())?.bridgeId === first, "the live identity")

    await Effect.runPromise(
      Queue.fail(connections.list[0]!.incoming, new RelayConnectionError({ detail: "lost" }))
    )
    await waitUntil(async () => (await connected()) === undefined, "the dropped identity")
    // The stored identity survives as a reconnect hint, but it is not a live bridge.
    expect(await Effect.runPromise(relay.identity())).not.toBeUndefined()

    await waitUntil(() => connections.list.length === 2, "the second connection")
    const second = BridgeId.make("33333333-3333-4333-8333-333333333333")
    await Effect.runPromise(
      Queue.offer(connections.list[1]!.incoming, {
        type: "registered",
        bridgeId: second,
        token,
        mcpUrl: "https://relay.example/mcp/second"
      })
    )
    await waitUntil(async () => (await connected())?.bridgeId === second, "the new identity")

    await Effect.runPromise(Scope.close(scope, Exit.void))
  })

  test("keeps the worker alive with a heartbeat that runs only while a run is open", async () => {
    const connections = memoryLink()
    const scope = Effect.runSync(Scope.make())
    const relay = await Effect.runPromise(
      Scope.provide(
        Effect.provide(
          ExtensionRelay.make({
            relayUrl: "https://relay.example",
            threadId: "thread-beat",
            tabId: 4,
            pageUrl: "https://example.com/products",
            world: fakeWorld(),
            reconnectBaseDelayMs: 1,
            heartbeatMs: 5,
            onStep: () => Effect.void
          }),
          Layer.merge(connections.layer, RelayThreadOwnership.layer)
        ),
        scope
      )
    )
    const pings = () =>
      connections.list.reduce(
        (total, connection) =>
          total + connection.sent.filter((message) => message.type === "ping").length,
        0
      )

    await waitUntil(() => connections.list.length === 1, "the connection")
    await Effect.runPromise(
      Queue.offer(connections.list[0]!.incoming, {
        type: "registered",
        bridgeId: BridgeId.make("11111111-1111-4111-8111-111111111111"),
        token: ResumeSecret.make("22222222-2222-4222-8222-222222222222"),
        mcpUrl: "https://relay.example/mcp/first"
      })
    )
    await Bun.sleep(40)
    expect(pings()).toBe(0)

    await Effect.runPromise(relay.openRun())
    await waitUntil(() => pings() >= 2, "two heartbeats")

    await Effect.runPromise(relay.closeRun())
    const settled = pings()
    await Bun.sleep(40)
    expect(pings()).toBe(settled)

    await Effect.runPromise(relay.openRun())
    await waitUntil(() => pings() > settled, "the heartbeat of the next run")
    await Effect.runPromise(Scope.close(scope, Exit.void))
    const closed = pings()
    await Bun.sleep(40)
    expect(pings()).toBe(closed)
  })

  test("reconnects after an unexpected relay-link defect", async () => {
    let attempts = 0
    const sent: SocketInbound[] = []
    const link = Layer.succeed(RelayLink, {
      connect: () => {
        attempts += 1
        if (attempts === 1) return Effect.die("unexpected socket defect")
        return Effect.gen(function* () {
          const incoming =
            yield* Queue.make<SocketOutbound, RelayConnectionError>()
          return {
            receive: Queue.take(incoming),
            send: (message) => Effect.sync(() => sent.push(message))
          } satisfies RelayConnection
        })
      }
    })
    const scope = Effect.runSync(Scope.make())
    await Effect.runPromise(
      Scope.provide(
        Effect.provide(
          ExtensionRelay.make({
            relayUrl: "https://relay.example",
            threadId: "thread-defect",
            tabId: 9,
            pageUrl: "https://example.com/products",
            world: fakeWorld(),
            reconnectBaseDelayMs: 1,
            onStep: () => Effect.void
          }),
          Layer.merge(link, RelayThreadOwnership.layer)
        ),
        scope
      )
    )

    for (let index = 0; attempts < 2 && index < 40; index += 1) {
      await Bun.sleep(1)
    }
    expect(attempts).toBe(2)
    expect(sent).toEqual([{ type: "register" }])
    await Effect.runPromise(Scope.close(scope, Exit.void))
  })

  test("registers through an in-memory relay link and reconnects with its minted identity", async () => {
    const connections: Array<{
      readonly incoming: Queue.Queue<SocketOutbound, RelayConnectionError>
      readonly sent: SocketInbound[]
    }> = []
    const link = Layer.succeed(RelayLink, {
      connect: () =>
        Effect.gen(function* () {
          const incoming =
            yield* Queue.make<SocketOutbound, RelayConnectionError>()
          const sent: SocketInbound[] = []
          connections.push({ incoming, sent })
          return {
            receive: Queue.take(incoming),
            send: (message) => Effect.sync(() => sent.push(message))
          } satisfies RelayConnection
        })
    })
    const steps: unknown[] = []
    const scope = Effect.runSync(Scope.make())
    const relay = await Effect.runPromise(
      Scope.provide(
        Effect.provide(
          ExtensionRelay.make({
            relayUrl: "https://relay.example",
            threadId: "thread-1",
            tabId: 7,
            pageUrl: "https://example.com/products",
            world: fakeWorld(),
            reconnectBaseDelayMs: 1,
            onStep: (step) => Effect.sync(() => steps.push(step))
          }),
          Layer.merge(link, RelayThreadOwnership.layer)
        ),
        scope
      )
    )
    await Effect.runPromise(relay.openRun())

    for (let index = 0; connections.length < 1 && index < 20; index += 1) {
      await Bun.sleep(1)
    }
    expect(connections[0]?.sent).toEqual([{ type: "register" }])

    const bridgeId = BridgeId.make("11111111-1111-4111-8111-111111111111")
    const token = ResumeSecret.make("22222222-2222-4222-8222-222222222222")
    await Effect.runPromise(
      Queue.offer(connections[0]!.incoming, {
        type: "registered",
        bridgeId,
        token,
        mcpUrl: "https://relay.example/mcp/11111111-1111-4111-8111-111111111111"
      })
    )
    await Effect.runPromise(
      Queue.offer(connections[0]!.incoming, {
        type: "request",
        id: "relay-list",
        method: "tools/list",
        params: {}
      })
    )
    for (
      let index = 0;
      !connections[0]?.sent.some(
        (message) => message.type === "response" && message.id === "relay-list"
      ) && index < 20;
      index += 1
    ) {
      await Bun.sleep(1)
    }
    const listed = connections[0]?.sent.find(
      (message) => message.type === "response" && message.id === "relay-list"
    )
    expect(
      listed !== undefined && "result" in listed
        ? (listed.result as { tools: ReadonlyArray<{ name: string }> }).tools.map(
            (tool) => tool.name
          )
        : []
    ).toEqual([...CURSOR_TOOL_NAMES])
    await Effect.runPromise(
      Queue.offer(connections[0]!.incoming, {
        type: "request",
        id: "relay-call",
        method: "tools/call",
        params: { name: "read_text", arguments: { selector: "main" } }
      })
    )
    for (
      let index = 0;
      !connections[0]?.sent.some(
        (message) => message.type === "response" && message.id === "relay-call"
      ) && index < 20;
      index += 1
    ) {
      await Bun.sleep(1)
    }
    expect(
      connections[0]?.sent.find(
        (message) => message.type === "response" && message.id === "relay-call"
      )
    ).toEqual({
      type: "response",
      id: "relay-call",
      result: {
        content: [{ type: "text", text: JSON.stringify(["Products"]) }]
      }
    })

    await Effect.runPromise(
      Queue.fail(
        connections[0]!.incoming,
        new RelayConnectionError({ detail: "lost" })
      )
    )
    for (let index = 0; connections.length < 2 && index < 40; index += 1) {
      await Bun.sleep(1)
    }
    expect(connections[1]?.sent).toEqual([
      { type: "reconnect", bridgeId, token }
    ])
    await Effect.runPromise(
      Queue.offer(connections[1]!.incoming, {
        type: "error",
        error: "Invalid WebSocket message"
      })
    )
    for (let index = 0; connections.length < 3 && index < 40; index += 1) {
      await Bun.sleep(1)
    }
    expect(connections[2]?.sent).toEqual([
      { type: "reconnect", bridgeId, token }
    ])
    await Effect.runPromise(
      Queue.offer(connections[2]!.incoming, {
        type: "request",
        id: "relay-call",
        method: "tools/call",
        params: { name: "read_text", arguments: { selector: "main" } }
      })
    )
    for (
      let index = 0;
      !connections[2]?.sent.some(
        (message) => message.type === "response" && message.id === "relay-call"
      ) && index < 20;
      index += 1
    ) {
      await Bun.sleep(1)
    }
    await Effect.runPromise(
      Queue.offer(connections[2]!.incoming, {
        type: "error",
        error: "Bridge token does not match"
      })
    )
    for (let index = 0; connections.length < 4 && index < 40; index += 1) {
      await Bun.sleep(1)
    }
    expect(connections[3]?.sent).toEqual([{ type: "register" }])
    expect(steps).toHaveLength(2)
    expect(
      new Set(
        steps.map((step) =>
          typeof step === "object" && step !== null && "callId" in step
            ? step.callId
            : undefined
        )
      ).size
    ).toBe(2)

    await Effect.runPromise(Scope.close(scope, Exit.void))
  })

  test("a parked ask_user leaves the socket reading: later frames are answered and a drop reconnects", async () => {
    const connections = memoryLink()
    const question = askUserCallId()
    const scope = Effect.runSync(Scope.make())
    const relay = await Effect.runPromise(
      Scope.provide(
        Effect.provide(
          ExtensionRelay.make({
            relayUrl: "https://relay.example",
            threadId: "thread-parked",
            tabId: 3,
            pageUrl: "https://example.com/products",
            world: fakeWorld(),
            reconnectBaseDelayMs: 1,
            onToolStart: question.onToolStart,
            onStep: () => Effect.void
          }),
          Layer.merge(connections.layer, RelayThreadOwnership.layer)
        ),
        scope
      )
    )
    await Effect.runPromise(relay.openRun())
    await waitUntil(() => connections.list.length === 1, "the first connection")
    const first = connections.list[0]!
    const answered = (connection: typeof first, id: string) =>
      connection.sent.find((message) => message.type === "response" && message.id === id)

    await Effect.runPromise(
      Queue.offer(first.incoming, {
        type: "request",
        id: "ask",
        method: "tools/call",
        params: {
          name: "ask_user",
          arguments: { question: "Grid or list?", options: [{ id: "grid", label: "Grid" }, { id: "list", label: "List" }] }
        }
      })
    )
    await question.callId

    // The question is parked. A list request behind it on the same socket is still answered.
    await Effect.runPromise(
      Queue.offer(first.incoming, { type: "request", id: "list", method: "tools/list", params: {} })
    )
    await waitUntil(() => answered(first, "list") !== undefined, "the list answer behind a parked question")
    expect(answered(first, "ask")).toBeUndefined()

    // The reader's click still lands, and the answer goes out on this socket, naming its call.
    const parkedCallId = await question.callId
    expect(relay.answerQuestion(parkedCallId, ["list"])).toBe(true)
    await waitUntil(() => answered(first, "ask") !== undefined, "the question answer")
    expect(answered(first, "ask")).toMatchObject({
      result: { content: [{ type: "text", text: JSON.stringify({ callId: parkedCallId, selected: [{ id: "list", label: "List" }] }) }] }
    })

    // A second question parks, and the socket drops under it: the drop is seen and a new socket opens.
    await Effect.runPromise(
      Queue.offer(first.incoming, {
        type: "request",
        id: "ask-2",
        method: "tools/call",
        params: { name: "ask_user", arguments: { question: "Again?", options: [{ id: "y", label: "Yes" }] } }
      })
    )
    await Effect.runPromise(
      Queue.fail(first.incoming, new RelayConnectionError({ detail: "lost" }))
    )
    await waitUntil(() => connections.list.length === 2, "the reconnect under a parked question")

    await Effect.runPromise(Scope.close(scope, Exit.void))
  })
})
