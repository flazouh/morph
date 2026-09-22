import { describe, expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import {
  CURSOR_API,
  CursorClient,
  type CursorFetch,
  isAgentBusy,
  isAgentGone,
  isRunNotCancellable,
  isTerminal,
  roleOfSubagentType,
  type CursorEvent
} from "./api"

/**
 * The seam under test is the one between Morph and the documented Cloud Agents API:
 * which request Morph sends, what it reads back, and what a reader-safe failure holds.
 */

interface Call {
  readonly url: string
  readonly method: string
  readonly headers: Record<string, string>
  readonly body: unknown
}

const record =
  (calls: Array<Call>, answer: (call: Call) => Response): CursorFetch =>
  (input, init) => {
    const headers = new Headers(init?.headers as HeadersInit | undefined)
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(headers.entries()),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined
    }
    calls.push(call)
    return Promise.resolve(answer(call))
  }

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })

const events = (text: string) =>
  new Response(text, { status: 200, headers: { "Content-Type": "text/event-stream" } })

const run = <A, E>(effect: Effect.Effect<A, E, CursorClient>, fetchImpl: CursorFetch) =>
  Effect.runPromise(Effect.provide(effect, CursorClient.layerWith(fetchImpl)))

const MCP = [
  {
    name: "morph",
    type: "http" as const,
    url: "https://relay.test/mcp/bridge-1",
    headers: { Authorization: "Bearer secret-token" }
  }
]

describe("cursor cloud agents client", () => {
  test("a subagent type names its role in every shape Cursor sends", () => {
    expect(roleOfSubagentType(undefined)).toBeUndefined()
    expect(roleOfSubagentType("reviewer")).toBe("reviewer")
    expect(roleOfSubagentType({ kind: "computerUse" })).toBe("computerUse")
    expect(roleOfSubagentType({ kind: "custom", name: "reviewer" })).toBe("reviewer")
    expect(roleOfSubagentType({ computerUse: {} })).toBe("computerUse")
    expect(roleOfSubagentType({ custom: { name: "reviewer" } })).toBe("reviewer")
    expect(roleOfSubagentType({ custom: {}, other: {} })).toBeUndefined()
    expect(roleOfSubagentType({})).toBeUndefined()
  })

  test("creates a no-repository agent with the model, the prompt and the inline MCP server", async () => {
    const calls: Array<Call> = []
    const created = await run(
      CursorClient.use((client) =>
        client.createAgent({
          apiKey: "key-1",
          prompt: "Restyle https://x.test/page",
          model: "composer-2",
          mcpServers: MCP
        })
      ),
      record(calls, () =>
        json(200, {
          agent: { id: "bc-1", status: "ACTIVE" },
          run: { id: "run-1", agentId: "bc-1", status: "CREATING" }
        })
      )
    )

    expect(created).toEqual({ agentId: "bc-1", runId: "run-1", status: "CREATING" })
    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.url).toBe(`${CURSOR_API}/v1/agents`)
    expect(call.method).toBe("POST")
    expect(call.headers.authorization).toBe("Bearer key-1")
    expect(call.body).toEqual({
      prompt: { text: "Restyle https://x.test/page" },
      model: { id: "composer-2" },
      mcpServers: MCP
    })
  })

  test("sends the crew roles as custom subagents, each inheriting the parent's model", async () => {
    const calls: Array<Call> = []
    const roles = [{ name: "reviewer", description: "Reviews.", prompt: "Review the page." }]
    await run(
      CursorClient.use((client) =>
        client.createAgent({ apiKey: "key-1", prompt: "hello", mcpServers: MCP, customSubagents: roles })
      ),
      record(calls, () =>
        json(200, { agent: { id: "bc-1" }, run: { id: "run-1", status: "CREATING" } })
      )
    )

    expect(calls[0]?.body).toEqual({
      prompt: { text: "hello" },
      mcpServers: MCP,
      customSubagents: [{ name: "reviewer", description: "Reviews.", prompt: "Review the page.", model: "inherit" }]
    })
  })

  test("omits the model when no Cursor model is chosen, so the account default applies", async () => {
    const calls: Array<Call> = []
    await run(
      CursorClient.use((client) =>
        client.createAgent({ apiKey: "key-1", prompt: "hello", mcpServers: MCP })
      ),
      record(calls, () =>
        json(200, { agent: { id: "bc-1" }, run: { id: "run-1", status: "CREATING" } })
      )
    )

    expect(calls[0]?.body).toEqual({ prompt: { text: "hello" }, mcpServers: MCP })
  })

  test("creates a follow-up run on the stored agent and resends the MCP configuration", async () => {
    const calls: Array<Call> = []
    const created = await run(
      CursorClient.use((client) =>
        client.createRun({ apiKey: "key-1", agentId: "bc-1", prompt: "again", mcpServers: MCP })
      ),
      record(calls, () => json(200, { run: { id: "run-2", agentId: "bc-1", status: "CREATING" } }))
    )

    expect(created).toEqual({ runId: "run-2", status: "CREATING" })
    expect(calls[0]?.url).toBe(`${CURSOR_API}/v1/agents/bc-1/runs`)
    expect(calls[0]?.body).toEqual({ prompt: { text: "again" }, mcpServers: MCP })
  })

  test("a Cursor error body becomes a tagged failure with Cursor's own message", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        Effect.provide(
          CursorClient.use((client) =>
            client.createRun({ apiKey: "key-1", agentId: "bc-1", prompt: "again", mcpServers: MCP })
          ),
          CursorClient.layerWith(
            record([], () =>
              json(409, { error: { code: "agent_busy", message: "This agent already has an active run." } })
            )
          )
        )
      )
    )

    expect(failure._tag).toBe("CursorApiError")
    expect(failure.message).toBe("This agent already has an active run.")
    expect(isAgentBusy(failure)).toBe(true)
    expect(isAgentGone(failure)).toBe(false)
  })

  test("an unreadable error body never reaches the reader as a raw body", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        Effect.provide(
          CursorClient.use((client) =>
            client.createAgent({ apiKey: "key-1", prompt: "hi", mcpServers: MCP })
          ),
          CursorClient.layerWith(
            record([], () => new Response("<html>gateway down</html>", { status: 502 }))
          )
        )
      )
    )

    expect(failure.message).toBe("Cursor refused the request (502).")
    expect(failure.message).not.toContain("gateway")
  })

  test("a missing agent marks the stored agent as gone", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        Effect.provide(
          CursorClient.use((client) =>
            client.createRun({ apiKey: "key-1", agentId: "bc-old", prompt: "again", mcpServers: MCP })
          ),
          CursorClient.layerWith(
            record([], () => json(404, { error: { code: "agent_not_found", message: "Agent not found." } }))
          )
        )
      )
    )

    expect(isAgentGone(failure)).toBe(true)
  })

  test("the run stream decodes the documented events, keeps a tool call as a boundary that knows whether it runs, reads a task call as a subagent, and drops the rest", async () => {
    const stream = [
      "event: status\ndata: {\"runId\":\"run-1\",\"status\":\"RUNNING\"}\n\n",
      "id: 1-0\nevent: assistant\ndata: {\"text\":\"Ap\"}\n\n",
      ": keepalive comment\n\n",
      "id: 1-1\nevent: heartbeat\ndata: {}\n\n",
      "id: 1-2\nevent: thinking\ndata: {\"text\":\"I will restyle.\"}\n\n",
      "id: 1-3\nevent: tool_call\ndata: {\"callId\":\"c1\",\"name\":\"mcp\",\"status\":\"running\"}\n\n",
      "id: 1-3b\nevent: tool_call\ndata: {\"callId\":\"c1\",\"name\":\"mcp\",\"status\":\"completed\"}\n\n",
      "id: 1-3c\nevent: tool_call\ndata: {\"callId\":\"t1\",\"name\":\"task\",\"status\":\"running\",\"args\":{\"subagent_type\":\"reviewer\",\"description\":\"Review the header\",\"prompt\":\"Read the header and report defects.\"}}\n\n",
      "id: 1-3d\nevent: interaction_update\ndata: {\"type\":\"tool-call-delta\",\"callId\":\"t1\",\"taskUpdate\":{\"type\":\"text-delta\",\"text\":\"clean\"}}\n\n",
      "id: 1-3e\nevent: tool_call\ndata: {\"callId\":\"t1\",\"name\":\"task\",\"status\":\"completed\",\"args\":{\"subagent_type\":\"reviewer\"},\"result\":{\"success\":{\"output\":\"clean\"}}}\n\n",
      "id: 1-3f\nevent: tool_call\ndata: {\"callId\":\"t2\",\"name\":\"task\",\"status\":\"running\"}\n\n",
      "id: 1-4\nevent: assistant\ndata: {\"text\":\"plied.\"}\n\n",
      "id: 1-5\nevent: assistant\ndata: not json\n\n",
      "id: 1-6\nevent: result\ndata: {\"runId\":\"run-1\",\"status\":\"FINISHED\",\"text\":\"Applied.\"}\n\n",
      "id: 1-7\nevent: done\ndata: {}\n\n"
    ].join("")

    const calls: Array<Call> = []
    const seen: Array<CursorEvent> = []
    await run(
      CursorClient.use((client) =>
        Stream.runForEach(
          client.streamRun({ apiKey: "key-1", agentId: "bc-1", runId: "run-1" }),
          (event) => Effect.sync(() => seen.push(event))
        )
      ),
      record(calls, () => events(stream))
    )

    expect(calls[0]?.url).toBe(`${CURSOR_API}/v1/agents/bc-1/runs/run-1/stream`)
    expect(calls[0]?.headers.accept).toBe("text/event-stream")
    expect(calls[0]?.headers["last-event-id"]).toBeUndefined()
    expect(seen).toEqual([
      { _tag: "status", status: "RUNNING" },
      { _tag: "assistant", text: "Ap", id: "1-0" },
      { _tag: "thinking", text: "I will restyle.", id: "1-2" },
      { _tag: "toolCall", running: true, id: "1-3" },
      { _tag: "toolCall", running: false, id: "1-3b" },
      { _tag: "subagent", callId: "t1", running: true, role: "reviewer", title: "Review the header", brief: "Read the header and report defects.", id: "1-3c" },
      { _tag: "subagent", callId: "t1", running: false, role: "reviewer", output: "clean", id: "1-3e" },
      { _tag: "subagent", callId: "t2", running: true, id: "1-3f" },
      { _tag: "assistant", text: "plied.", id: "1-4" },
      { _tag: "result", status: "FINISHED", text: "Applied.", id: "1-6" },
      { _tag: "done", id: "1-7" }
    ])
  })

  test("a stream resume sends the Last-Event-ID header", async () => {
    const calls: Array<Call> = []
    await run(
      CursorClient.use((client) =>
        Stream.runDrain(
          Stream.take(
            client.streamRun({ apiKey: "key-1", agentId: "bc-1", runId: "run-1", lastEventId: "1713033006000-0" }),
            1
          )
        )
      ),
      record(calls, () => events("event: status\ndata: {\"runId\":\"run-1\",\"status\":\"RUNNING\"}\n\n"))
    )

    expect(calls[0]?.headers["last-event-id"]).toBe("1713033006000-0")
  })

  test("reads a run's status and final reply with Get A Run", async () => {
    const calls: Array<Call> = []
    const runInfo = await run(
      CursorClient.use((client) => client.getRun({ apiKey: "key-1", agentId: "bc-1", runId: "run-1" })),
      record(calls, () =>
        json(200, { id: "run-1", agentId: "bc-1", status: "FINISHED", result: "Applied." })
      )
    )

    expect(runInfo).toEqual({ runId: "run-1", status: "FINISHED", result: "Applied." })
    expect(calls[0]?.url).toBe(`${CURSOR_API}/v1/agents/bc-1/runs/run-1`)
    expect(calls[0]?.method).toBe("GET")
    expect(calls[0]?.headers.authorization).toBe("Bearer key-1")
  })

  test("a missing run reads as gone, so the caller stops following it", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        Effect.provide(
          CursorClient.use((client) => client.getRun({ apiKey: "key-1", agentId: "bc-1", runId: "run-9" })),
          CursorClient.layerWith(
            record([], () => json(404, { error: { code: "run_not_found", message: "Run not found." } }))
          )
        )
      )
    )

    expect(failure._tag).toBe("CursorApiError")
    expect(failure._tag === "CursorApiError" && failure.status).toBe(404)
  })

  test("reads the agent's lifecycle status and latest run", async () => {
    const calls: Array<Call> = []
    const agent = await run(
      CursorClient.use((client) => client.getAgent({ apiKey: "key-1", agentId: "bc-1" })),
      record(calls, () => json(200, { id: "bc-1", status: "IDLE", latestRunId: "run-9" }))
    )

    expect(agent).toEqual({ agentId: "bc-1", status: "IDLE", latestRunId: "run-9" })
    expect(calls[0]?.url).toBe(`${CURSOR_API}/v1/agents/bc-1`)
    expect(calls[0]?.method).toBe("GET")
  })

  test("a missing agent read marks the agent as gone", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        Effect.provide(
          CursorClient.use((client) => client.getAgent({ apiKey: "key-1", agentId: "bc-old" })),
          CursorClient.layerWith(
            record([], () => json(404, { error: { code: "agent_not_found", message: "Agent not found." } }))
          )
        )
      )
    )

    expect(isAgentGone(failure)).toBe(true)
  })

  test("a stream error event carries Cursor's code and message", async () => {
    const seen: Array<CursorEvent> = []
    await run(
      CursorClient.use((client) =>
        Stream.runForEach(
          client.streamRun({ apiKey: "key-1", agentId: "bc-1", runId: "run-1" }),
          (event) => Effect.sync(() => seen.push(event))
        )
      ),
      record([], () =>
        events("event: error\ndata: {\"code\":\"upstream_error\",\"message\":\"The worker went away.\"}\n\n")
      )
    )

    expect(seen).toEqual([{ _tag: "error", code: "upstream_error", message: "The worker went away." }])
  })

  test("cancel posts to the run's cancel path and reports a finished run as not cancellable", async () => {
    const calls: Array<Call> = []
    await run(
      CursorClient.use((client) =>
        client.cancelRun({ apiKey: "key-1", agentId: "bc-1", runId: "run-1" })
      ),
      record(calls, () => json(200, { id: "run-1" }))
    )
    expect(calls[0]?.url).toBe(`${CURSOR_API}/v1/agents/bc-1/runs/run-1/cancel`)
    expect(calls[0]?.method).toBe("POST")

    const failure = await Effect.runPromise(
      Effect.flip(
        Effect.provide(
          CursorClient.use((client) =>
            client.cancelRun({ apiKey: "key-1", agentId: "bc-1", runId: "run-1" })
          ),
          CursorClient.layerWith(
            record([], () =>
              json(409, { error: { code: "run_not_cancellable", message: "Run is not cancellable." } })
            )
          )
        )
      )
    )
    expect(isRunNotCancellable(failure)).toBe(true)
  })

  test("archive posts to the agent's archive path", async () => {
    const calls: Array<Call> = []
    await run(
      CursorClient.use((client) => client.archiveAgent({ apiKey: "key-1", agentId: "bc-1" })),
      record(calls, () => json(200, { id: "bc-1" }))
    )
    expect(calls[0]?.url).toBe(`${CURSOR_API}/v1/agents/bc-1/archive`)
    expect(calls[0]?.method).toBe("POST")
  })

  test("reads the documented cumulative agent usage shape", async () => {
    const calls: Array<Call> = []
    const usage = await run(
      CursorClient.use((client) => client.getAgentUsage({ apiKey: "key-1", agentId: "bc-1" })),
      record(calls, () =>
        json(200, {
          totalUsage: {
            inputTokens: 12_480,
            outputTokens: 3_110,
            cacheWriteTokens: 18_200,
            cacheReadTokens: 42_600,
            totalTokens: 76_390
          },
          runs: []
        })
      )
    )

    expect(usage).toEqual({
      inputTokens: 12_480,
      outputTokens: 3_110,
      cacheWriteTokens: 18_200,
      cacheReadTokens: 42_600,
      totalTokens: 76_390
    })
    expect(calls[0]?.url).toBe(`${CURSOR_API}/v1/agents/bc-1/usage`)
    expect(calls[0]?.method).toBe("GET")
    expect(calls[0]?.headers.authorization).toBe("Bearer key-1")
  })

  test("a dead network is one safe transport failure that names no host detail", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        Effect.provide(
          CursorClient.use((client) =>
            client.createAgent({ apiKey: "key-1", prompt: "hi", mcpServers: MCP })
          ),
          CursorClient.layerWith(() => Promise.reject(new Error("ECONNREFUSED 1.2.3.4:443")))
        )
      )
    )

    expect(failure._tag).toBe("CursorTransportError")
    expect(failure.message).toBe("Could not reach Cursor.")
  })

  test("terminal statuses are the four documented ones", () => {
    expect(["FINISHED", "ERROR", "CANCELLED", "EXPIRED"].every(isTerminal)).toBe(true)
    expect(["CREATING", "RUNNING"].some(isTerminal)).toBe(false)
  })
})
