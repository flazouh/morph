import { describe, expect, test } from "bun:test"
import { Effect, Queue } from "effect"
import type { CursorStepStorage } from "./state"
import { CURSOR_RECORD_VERSION, CursorStorageError, memoryCursorStorage } from "./state"
import {
  CURSOR_KEY_MISSING,
  HISTORY_UNREADABLE,
  RELAY_UNREACHABLE,
  RUN_BUSY_NOT_SENT
} from "./session"
import { CURSOR_AGENT_GONE, CURSOR_RUN_GONE, NO_TERMINAL_STATUS, streamUnreadable } from "./read"
import { CREW_ROLES } from "../agent/crew/roles"
import {
  done,
  flakySteps,
  IDENTITY,
  json,
  kinds,
  liveStream,
  MCP_URL,
  NEXT_IDENTITY,
  openCursorSession,
  PAGE,
  said,
  sse,
  TOKEN,
  until,
  within,
  type Bridge,
  type OpenOptions,
  type RelayControl
} from "./testing"

/**
 * The seam under test is the Session the panel sees. Every assertion is what a reader
 * sees: the steps, the run state, and the requests Morph did or did not make.
 */

const open = (options: OpenOptions = {}) => openCursorSession(options)

describe("cursor session", () => {
  test("an empty Cursor key is one error step, before any relay or Cursor request", async () => {
    const opened = await open({ settings: { cursorKey: "" } })
    await opened.session.send("Restyle it")

    expect(said(opened.session.steps())).toEqual(["user:Restyle it", `error:${CURSOR_KEY_MISSING}`])
    expect(opened.calls).toEqual([])
    expect(opened.session.state()).toBe("idle")
    await opened.close()
  })

  test("a Cursor key of nothing but spaces is the same error, and asks Cursor nothing", async () => {
    const opened = await open({ settings: { cursorKey: "   \t\n  " } })
    await opened.session.send("Restyle it")

    expect(said(opened.session.steps())).toEqual(["user:Restyle it", `error:${CURSOR_KEY_MISSING}`])
    expect(opened.calls).toEqual([])
    expect(opened.session.state()).toBe("idle")
    await opened.close()
  })

  test("an unreachable relay is one error step that names the relay, before any Cursor request", async () => {
    const opened = await open({ relayFails: true })
    await opened.session.send("Restyle it")

    expect(said(opened.session.steps())).toEqual(["user:Restyle it", `error:${RELAY_UNREACHABLE}`])
    expect(opened.calls).toEqual([])
    expect(opened.session.state()).toBe("idle")
    await opened.close()
  })

  test("the first send creates a no-repository agent with the page URL, the model and the relay MCP server", async () => {
    const opened = await open()
    await opened.session.send("Restyle it")

    const create = opened.calls[0]!
    expect(create.url).toBe("https://api.cursor.com/v1/agents")
    const body = create.body as {
      prompt: { text: string }
      model: { id: string }
      mcpServers: ReadonlyArray<{ name: string; type: string; url: string; headers: Record<string, string> }>
      customSubagents?: ReadonlyArray<{ name: string; prompt: string; model: string }>
      repos?: unknown
      env?: unknown
    }
    expect(body.prompt.text).toContain(PAGE)
    expect(body.prompt.text).toContain("Restyle it")
    expect(body.model).toEqual({ id: "composer-2" })
    expect(body.repos).toBeUndefined()
    expect(body.env).toBeUndefined()
    expect(body.mcpServers).toEqual([
      { name: "morph", type: "http", url: MCP_URL, headers: { Authorization: `Bearer ${TOKEN}` } }
    ])
    expect(body.customSubagents?.map((role) => role.name)).toEqual(CREW_ROLES.map((role) => role.name))
    expect(body.customSubagents?.every((role) => role.model === "inherit" && role.prompt !== "")).toBe(true)
    // Cursor takes the roles, but its Task tool refuses them (see the create/run evidence in
    // docs/agents/qa.md). A prompt that named them made the model claim subagents it could
    // not call, so the roles ride on the create alone and say nothing to the model.
    for (const role of CREW_ROLES) expect(body.prompt.text).not.toContain(role.name)
    expect(body.prompt.text).not.toContain("You have subagents")
    expect(said(opened.session.steps())).toEqual(["user:Restyle it", "assistant:Done."])
    expect(opened.session.state()).toBe("idle")
    await opened.close()
  })

  test("a later send creates a run on the stored agent and resends the MCP configuration and the page URL", async () => {
    const opened = await open()
    await opened.session.send("one")
    await opened.session.send("two")

    const follow = opened.calls.find((call) => call.url.endsWith("/v1/agents/bc-1/runs"))!
    const body = follow.body as {
      prompt: { text: string }
      mcpServers: ReadonlyArray<{ url: string }>
    }
    expect(body.prompt.text).toContain(PAGE)
    expect(body.prompt.text).toContain("two")
    expect(body.mcpServers[0]?.url).toBe(MCP_URL)
    expect(opened.calls.filter((call) => call.url === "https://api.cursor.com/v1/agents")).toHaveLength(1)
    await opened.close()
  })

  test("a send reports working while Cursor is still creating the run", async () => {
    let createSignal: AbortSignal | undefined
    const opened = await open({
      script: {
        createRun: (_body, signal) =>
          new Promise<Response>((_resolve, reject) => {
            createSignal = signal
            signal?.addEventListener("abort", () => reject(new Error("create aborted")), { once: true })
          })
      }
    })
    await opened.session.send("one")

    const sending = opened.session.send("two")
    await until(
      () => opened.session.steps().some((step) => step.kind === "user" && step.text === "two"),
      "the pending user step"
    )

    expect(opened.session.state()).toBe("working")

    await within(opened.session.stop(), "Stop during Cursor run creation", 100)
    await within(sending, "the aborted Cursor run creation", 100)
    expect(createSignal?.aborted).toBe(true)
    expect(said(opened.session.steps()).slice(-1)).toEqual(["user:two"])
    expect(opened.session.state()).toBe("idle")
    await opened.close()
  })

  test("assistant narration stays in the live turn until the terminal result becomes the answer", async () => {
    const live = liveStream()
    const opened = await open({ script: { stream: (signal) => live.respond(signal) } })
    const sending = opened.session.send("Restyle it")

    await until(() => opened.session.state() === "working", "the working state")
    live.push(`event: status\ndata: {"runId":"run-1","status":"RUNNING"}\n\n`)
    live.push(`id: 1\nevent: assistant\ndata: {"text":"Ap"}\n\n`)
    await until(
      () => opened.session.turn().answerDraft === "Ap",
      "the first narration token"
    )
    expect(said(opened.session.steps())).toEqual(["user:Restyle it"])
    expect(opened.session.turn().activityText).toBe("Ap")
    expect(opened.session.state()).toBe("working")

    live.push(`id: 2\nevent: assistant\ndata: {"text":"plied."}\n\n`)
    await until(
      () => opened.session.turn().answerDraft === "Applied.",
      "the joined narration text"
    )
    expect(said(opened.session.steps())).toEqual(["user:Restyle it"])
    expect(opened.session.state()).toBe("working")

    live.push(`id: 3\nevent: result\ndata: {"runId":"run-1","status":"FINISHED","text":"Applied."}\n\n`)
    live.push(`id: 4\nevent: done\ndata: {}\n\n`)
    live.close()
    await sending

    expect(said(opened.session.steps())).toEqual(["user:Restyle it", "assistant:Applied."])
    expect(opened.session.turn().phase).toBe("complete")
    expect(opened.session.state()).toBe("idle")
    await opened.close()
  })

  test("Cursor's own tool_call frame moves the turn to running tools before the relay call lands", async () => {
    const live = liveStream()
    const opened = await open({ script: { stream: (signal) => live.respond(signal) } })
    const sending = opened.session.send("Restyle it")

    await until(() => opened.session.state() === "working", "the working state")
    live.push(`event: status\ndata: {"runId":"run-1","status":"RUNNING"}\n\n`)
    live.push(`id: 1\nevent: assistant\ndata: {"text":"I'll write the skin."}\n\n`)
    await until(() => opened.session.turn().phase === "answering", "the narration")

    live.push(`id: 2\nevent: tool_call\ndata: {"runId":"run-1","status":"running","name":"mcp"}\n\n`)
    await until(() => opened.session.turn().phase === "runningTool", "the announced tool call")
    expect(opened.session.turn().activeTool).toBeUndefined()
    expect(opened.session.turn().answerDraft).toBe("")

    live.push(`id: 3\nevent: tool_call\ndata: {"runId":"run-1","status":"completed","name":"mcp"}\n\n`)
    live.push(`id: 4\nevent: assistant\ndata: {"text":"Done."}\n\n`)
    await until(() => opened.session.turn().answerDraft === "Done.", "the text after the call")
    expect(opened.session.turn().phase).toBe("answering")

    live.push(`id: 5\nevent: result\ndata: {"runId":"run-1","status":"FINISHED","text":"I'll write the skin.Done."}\n\n`)
    live.push(`id: 6\nevent: done\ndata: {}\n\n`)
    live.close()
    await sending
    expect(said(opened.session.steps()).slice(-1)).toEqual(["assistant:Done."])
    await opened.close()
  })

  test("a task frame is a delegation step: the role, the title and the brief while it runs, the bot's answer when it ends", async () => {
    const live = liveStream()
    const opened = await open({ script: { stream: (signal) => live.respond(signal) } })
    const sending = opened.session.send("Restyle it")

    await until(() => opened.session.state() === "working", "the working state")
    live.push(`event: status\ndata: {"runId":"run-1","status":"RUNNING"}\n\n`)
    live.push(
      `id: 1\nevent: tool_call\ndata: {"callId":"t1","name":"task","status":"running","args":{"subagent_type":"reviewer","description":"Review the header","prompt":"Read the header and report defects."}}\n\n`
    )
    await until(() => opened.session.steps().some((step) => step.kind === "tool"), "the delegation step")
    const running = opened.session.steps().find((step) => step.kind === "tool")!
    expect(running).toMatchObject({
      kind: "tool",
      callId: "cursor-task:t1",
      name: "spawn_agent",
      input: { role: "reviewer", title: "Review the header", brief: "Read the header and report defects." }
    })
    expect(running.kind === "tool" && running.result).toBeUndefined()
    expect(opened.session.turn().phase).toBe("runningTool")
    expect(opened.session.turn().activeTool?.callId).toBe("cursor-task:t1")

    live.push(
      `id: 2\nevent: tool_call\ndata: {"callId":"t1","name":"task","status":"completed","args":{"subagent_type":"reviewer"},"result":{"success":{"output":"clean"}}}\n\n`
    )
    await until(
      () => opened.session.steps().some((step) => step.kind === "tool" && step.result !== undefined),
      "the finished delegation"
    )
    const finished = opened.session.steps().find((step) => step.kind === "tool")!
    expect(finished.kind === "tool" && finished.result).toEqual({ id: "reviewer", role: "reviewer", output: "clean" })
    expect(finished.kind === "tool" && finished.input).toEqual(running.input)
    expect(opened.session.turn().activeTool).toBeUndefined()

    live.push(`id: 3\nevent: result\ndata: {"runId":"run-1","status":"FINISHED","text":"Reviewed: clean."}\n\n`)
    live.push(`id: 4\nevent: done\ndata: {}\n\n`)
    live.close()
    await sending
    expect(said(opened.session.steps())).toEqual(["user:Restyle it", "tool:spawn_agent", "assistant:Reviewed: clean."])
    await opened.close()
  })

  test("a task frame as Cursor sends it today (subagentType as a tagged object, extra args, a truncated result) is still a delegation step", async () => {
    const live = liveStream()
    const opened = await open({ script: { stream: (signal) => live.respond(signal) } })
    const sending = opened.session.send("Have the reviewer check the header")

    await until(() => opened.session.state() === "working", "the working state")
    live.push(`event: status\ndata: {"runId":"run-1","status":"RUNNING"}\n\n`)
    live.push(`id: 1789395110765-0\nevent: thinking\ndata: {"text":"I will delegate."}\n\n`)
    // Cursor's own probe of the MCP tool list, with an error result while still "running".
    live.push(
      `id: 1789395110765-1\nevent: tool_call\ndata: {"callId":"toolu_1","name":"get_mcp_tools","status":"running","args":{"toolCallId":"unknown-tool-call-id"},"result":{"error":{"error":"Invalid arguments"}}}\n\n`
    )
    live.push(
      `id: 1789395110765-2\nevent: tool_call\ndata: {"callId":"toolu_1","name":"get_mcp_tools","status":"completed","args":{"server":"morph","toolName":"read_page","toolCallId":"toolu_1"},"result":{"success":{}}}\n\n`
    )
    const args =
      `{"description":"Review redesigned HN header","prompt":"Open the URL and review ONLY the page header.","subagentType":{"computerUse":{}},"model":"claude-4.5-sonnet","agentId":"bc-7fcb487e","machine":{"sameMachine":{}}}`
    live.push(
      `id: 1789395129354-0\nevent: tool_call\ndata: {"callId":"toolu_2","name":"task","status":"running","args":${args}}\n\n`
    )
    live.push(
      `id: 1789395129354-0\nevent: interaction_update\ndata: {"type":"tool-call-started","callId":"toolu_2","toolCall":{"type":"task","args":{"description":"Review redesigned HN header","subagentType":{"kind":"computerUse"}}}}\n\n`
    )
    await until(
      () => opened.session.steps().some((step) => step.kind === "tool" && step.name === "spawn_agent"),
      "the delegation step"
    )
    const running = opened.session.steps().find((step) => step.kind === "tool" && step.name === "spawn_agent")!
    expect(running).toMatchObject({
      callId: "cursor-task:toolu_2",
      input: {
        role: "computerUse",
        title: "Review redesigned HN header",
        brief: "Open the URL and review ONLY the page header."
      }
    })
    expect(opened.session.turn().activeTool?.callId).toBe("cursor-task:toolu_2")

    live.push(
      `id: 1789395312787-0\nevent: tool_call\ndata: {"callId":"toolu_2","name":"task","status":"completed","args":${args},"truncated":{"result":true}}\n\n`
    )
    await until(
      () =>
        opened.session
          .steps()
          .some((step) => step.kind === "tool" && step.name === "spawn_agent" && step.result !== undefined),
      "the finished delegation"
    )
    const finished = opened.session.steps().find((step) => step.kind === "tool" && step.name === "spawn_agent")!
    expect(finished.kind === "tool" && finished.result).toEqual({ id: "computerUse", role: "computerUse" })
    expect(opened.session.turn().activeTool).toBeUndefined()

    live.push(`id: 1789395312787-1\nevent: assistant\ndata: {"text":"The reviewer saw the classic header."}\n\n`)
    live.push(`id: 1789395312787-2\nevent: result\ndata: {"runId":"run-1","status":"FINISHED","text":"The reviewer saw the classic header."}\n\n`)
    live.push(`id: 1789395312787-3\nevent: done\ndata: {}\n\n`)
    live.close()
    await sending
    expect(said(opened.session.steps()).filter((line) => line.startsWith("tool:"))).toEqual([
      "tool:spawn_agent"
    ])
    await opened.close()
  })

  test("a tool call the extension ran becomes a step with its real input and result, and the page reads as applied", async () => {
    const live = liveStream()
    const opened = await open({ script: { stream: (signal) => live.respond(signal) } })
    const sending = opened.session.send("Restyle it")
    await until(() => opened.bridges.length > 0, "the relay bridge")
    const bridge = opened.bridges[0]!

    await Effect.runPromise(
      Queue.offer(bridge.incoming, {
        type: "request",
        id: "call-1",
        method: "tools/call",
        params: { name: "apply_styles", arguments: { css: "body{color:red}" } }
      })
    )
    await until(
      () => opened.session.steps().some((step) => step.kind === "tool"),
      "the tool step"
    )

    const tool = opened.session.steps().find((step) => step.kind === "tool")!
    expect(tool).toMatchObject({
      kind: "tool",
      name: "apply_styles",
      input: { css: "body{color:red}" },
      result: { ok: true, bytes: 15, persisted: true, applied: { css: "body{color:red}" } }
    })
    expect(bridge.sent.some((message) => message.type === "response" && message.id === "call-1")).toBe(true)

    live.push(`event: result\ndata: {"runId":"run-1","status":"FINISHED","text":"Done."}\n\n`)
    live.push(`event: done\ndata: {}\n\n`)
    live.close()
    await sending

    expect(kinds(opened.session.steps())).toEqual(["user", "tool", "assistant"])
    expect(opened.session.state()).toBe("applied")
    await opened.close()
  })

  test("a thread with a publisher is told about publishing and reads what it applied as the page package", async () => {
    const live = liveStream()
    const published: Array<string> = []
    const opened = await open({
      script: { stream: (signal) => live.respond(signal) },
      publisher: {
        publishPage: async (source) => {
          published.push(source.entry)
          return { id: "r", state: "completed", slug: "alex/page", version: "1.0.0", commit: "c", receipt: "t", retryable: false, error: null }
        }
      }
    })
    const sending = opened.session.send("Restyle it")
    await until(() => opened.bridges.length > 0, "the relay bridge")
    const bridge = opened.bridges[0]!
    const create = opened.calls[0]!.body as { prompt: { text: string } }
    expect(create.prompt.text).toContain('draftId "page"')

    const ask = (id: string, name: string, args: Record<string, unknown>) =>
      Effect.runPromise(Queue.offer(bridge.incoming, { type: "request", id, method: "tools/call", params: { name, arguments: args } }))
    const answer = async (id: string): Promise<unknown> => {
      await until(() => bridge.sent.some((m) => m.type === "response" && m.id === id), `the ${id} response`)
      const message = bridge.sent.find((m) => m.type === "response" && m.id === id) as { result: { content: ReadonlyArray<{ text: string }> } }
      return JSON.parse(message.result.content[0]!.text)
    }

    await ask("list-0", "read_morph_source", {})
    expect(await answer("list-0")).toEqual({ error: "nothing is applied on this page yet; redesign it before publishing" })
    await ask("apply", "apply_styles", { css: "body{color:red}" })
    await answer("apply")
    await ask("list-1", "read_morph_source", {})
    expect(await answer("list-1")).toMatchObject({ parent: null, draftId: "page", entry: "style.css", files: ["style.css"] })
    await ask("read", "read_morph_source", { path: "style.css" })
    expect(await answer("read")).toEqual({ path: "style.css", content: "body{color:red}" })
    await ask("publish", "publish_morph", { name: "P", slug: "alex/page", summary: "s", version: "1.0.0", confirmationCallId: "none" })
    expect(await answer("publish")).toEqual({ error: "the reader must confirm this exact release before publishing" })
    expect(published).toEqual([])

    live.push(`event: result\ndata: {"runId":"run-1","status":"FINISHED","text":"Done."}\n\n`)
    live.push(`event: done\ndata: {}\n\n`)
    live.close()
    await sending
    await opened.close()
  })

  test("a thread without a publisher has no publish tools", async () => {
    const live = liveStream()
    const opened = await open({ script: { stream: (signal) => live.respond(signal) } })
    const sending = opened.session.send("Restyle it")
    await until(() => opened.bridges.length > 0, "the relay bridge")
    const bridge = opened.bridges[0]!
    const create = opened.calls[0]!.body as { prompt: { text: string } }
    expect(create.prompt.text).not.toContain("publish_morph")
    await Effect.runPromise(
      Queue.offer(bridge.incoming, { type: "request", id: "list", method: "tools/list", params: {} })
    )
    await until(() => bridge.sent.some((m) => m.type === "response" && m.id === "list"), "the list")
    const listed = bridge.sent.find((m) => m.type === "response" && m.id === "list") as { result: { tools: ReadonlyArray<{ name: string }> } }
    expect(listed.result.tools.map((tool) => tool.name)).not.toContain("publish_morph")
    live.push(`event: result\ndata: {"runId":"run-1","status":"FINISHED","text":"Done."}\n\n`)
    live.push(`event: done\ndata: {}\n\n`)
    live.close()
    await sending
    await opened.close()
  })

  test("a result that glues the narration before a tool onto the answer after it shows only the answer", async () => {
    const live = liveStream()
    const opened = await open({ script: { stream: (signal) => live.respond(signal) } })
    const sending = opened.session.send("Restyle it")
    await until(() => opened.bridges.length > 0, "the relay bridge")
    const bridge = opened.bridges[0]!

    live.push(`id: 1\nevent: assistant\ndata: {"text":"I will restyle it now."}\n\n`)
    await until(() => opened.session.turn().answerDraft === "I will restyle it now.", "the narration")
    await Effect.runPromise(
      Queue.offer(bridge.incoming, {
        type: "request",
        id: "call-1",
        method: "tools/call",
        params: { name: "apply_styles", arguments: { css: "body{color:red}" } }
      })
    )
    await until(() => opened.session.steps().some((step) => step.kind === "tool"), "the tool step")
    live.push(`id: 2\nevent: assistant\ndata: {"text":"The header is red now."}\n\n`)
    await until(() => opened.session.turn().answerDraft === "The header is red now.", "the answer segment")

    // Cursor's result frame joins both segments with no separator.
    live.push(
      `id: 3\nevent: result\ndata: {"runId":"run-1","status":"FINISHED","text":"I will restyle it now.The header is red now."}\n\n`
    )
    live.push(`id: 4\nevent: done\ndata: {}\n\n`)
    live.close()
    await sending

    expect(said(opened.session.steps())).toEqual([
      "user:Restyle it",
      "thinking:I will restyle it now.",
      "tool:apply_styles",
      "assistant:The header is red now."
    ])
    await opened.close()
  })

  test("a status frame that ends the run before its result frame keeps the narration and the last segment", async () => {
    // The order Cursor's stream showed live on 2026-09-12: text, tools, text, then an
    // id-less `status FINISHED` ahead of the `result` frame.
    const live = liveStream()
    const opened = await open({ script: { stream: (signal) => live.respond(signal) } })
    const sending = opened.session.send("Restyle it")
    await until(() => opened.bridges.length > 0, "the relay bridge")
    const bridge = opened.bridges[0]!

    live.push(`event: status\ndata: {"runId":"run-1","status":"RUNNING"}\n\n`)
    live.push(`id: 1\nevent: thinking\ndata: {"text":"I will ask first."}\n\n`)
    live.push(`id: 2\nevent: assistant\ndata: {"text":"I'll start by planning."}\n\n`)
    await until(() => opened.session.turn().answerDraft === "I'll start by planning.", "the narration")
    await Effect.runPromise(
      Queue.offer(bridge.incoming, {
        type: "request",
        id: "call-1",
        method: "tools/call",
        params: { name: "apply_styles", arguments: { css: "body{color:red}" } }
      })
    )
    await until(
      () => opened.session.steps().some((step) => step.kind === "tool" && step.result !== undefined),
      "the finished tool step"
    )
    live.push(`id: 3\nevent: assistant\ndata: {"text":"You chose a light header."}\n\n`)
    await until(() => opened.session.turn().answerDraft === "You chose a light header.", "the answer segment")
    live.push(`event: status\ndata: {"runId":"run-1","status":"FINISHED"}\n\n`)
    live.push(`id: 4\nevent: result\ndata: {"runId":"run-1","status":"FINISHED","text":"You chose a light header."}\n\n`)
    live.push(`id: 5\nevent: done\ndata: {}\n\n`)
    live.close()
    await sending

    expect(said(opened.session.steps())).toEqual([
      "user:Restyle it",
      "thinking:I will ask first.I'll start by planning.",
      "tool:apply_styles",
      "assistant:You chose a light header."
    ])
    await opened.close()
  })

  test("a create that answers after the run ended still shows the narration and the answer", async () => {
    // Seen live on 2026-09-12: Cursor's create answered 62 s after the send, 22 s after the
    // run finished, while the run's tools already went through the relay. The stream of a
    // finished run opens with an id-less `status FINISHED` snapshot, replays the run, then
    // ends with `status FINISHED`, `result`, `done`.
    let release!: () => void
    const created = new Promise<void>((resolve) => {
      release = resolve
    })
    const opened = await open({
      script: {
        createAgent: () =>
          created.then(() => json(200, { agent: { id: "bc-1" }, run: { id: "run-1", status: "FINISHED" } })),
        stream: () =>
          sse(
            [
              `event: status\ndata: {"runId":"run-1","status":"FINISHED"}\n\n`,
              `id: 1\nevent: thinking\ndata: {"text":"I will ask first."}\n\n`,
              `id: 2\nevent: assistant\ndata: {"text":"I'll ask you one choice."}\n\n`,
              `id: 3\nevent: tool_call\ndata: {"runId":"run-1","status":"running","name":"mcp"}\n\n`,
              `id: 4\nevent: tool_call\ndata: {"runId":"run-1","status":"completed","name":"mcp"}\n\n`,
              `id: 5\nevent: assistant\ndata: {"text":"You chose a light header."}\n\n`,
              `event: status\ndata: {"runId":"run-1","status":"FINISHED"}\n\n`,
              `id: 6\nevent: result\ndata: {"runId":"run-1","status":"FINISHED","text":"I'll ask you one choice.You chose a light header."}\n\n`,
              `id: 7\nevent: done\ndata: {}\n\n`
            ].join("")
          )
      }
    })
    const sending = opened.session.send("Restyle it")
    await until(() => opened.bridges.length > 0, "the relay bridge")
    const bridge = opened.bridges[0]!
    await Effect.runPromise(
      Queue.offer(bridge.incoming, {
        type: "request",
        id: "call-1",
        method: "tools/call",
        params: { name: "apply_styles", arguments: { css: "body{color:red}" } }
      })
    )
    await until(
      () => opened.session.steps().some((step) => step.kind === "tool" && step.result !== undefined),
      "the finished tool step"
    )
    release()
    await sending

    expect(said(opened.session.steps())).toEqual([
      "user:Restyle it",
      "tool:apply_styles",
      "thinking:I will ask first.I'll ask you one choice.",
      "assistant:You chose a light header."
    ])
    expect(opened.session.turn().phase).toBe("complete")
    await opened.close()
  })

  test("a resumed read that opens after the run finished reads the tail behind the status snapshot", async () => {
    const first = liveStream()
    let streams = 0
    const opened = await open({
      script: {
        stream: (signal) => {
          streams += 1
          return streams === 1
            ? first.respond(signal)
            : sse(
                [
                  `event: status\ndata: {"runId":"run-1","status":"FINISHED"}\n\n`,
                  `id: 7-1\nevent: assistant\ndata: {"text":" done."}\n\n`,
                  `event: status\ndata: {"runId":"run-1","status":"FINISHED"}\n\n`,
                  `id: 7-2\nevent: result\ndata: {"runId":"run-1","status":"FINISHED","text":"Half done."}\n\n`,
                  `id: 7-3\nevent: done\ndata: {}\n\n`
                ].join("")
              )
        },
        getRun: () => json(200, { id: "run-1", status: "RUNNING" })
      }
    })
    const sending = opened.session.send("Restyle it")
    await until(() => opened.session.state() === "working", "the working state")
    first.push(`event: status\ndata: {"runId":"run-1","status":"RUNNING"}\n\n`)
    first.push(`id: 7-0\nevent: assistant\ndata: {"text":"Half"}\n\n`)
    await until(() => opened.session.turn().activityText === "Half", "the first read's text")
    first.fail(new Error("connection reset"))
    await sending

    expect(said(opened.session.steps())).toEqual(["user:Restyle it", "assistant:Half done."])
    expect(opened.session.state()).toBe("idle")
    await opened.close()
  })

  test("a late join on a cancelled run with no trailing status settles from the run's record", async () => {
    const opened = await open({
      script: {
        stream: () =>
          sse(
            [
              `event: status\ndata: {"runId":"run-1","status":"CANCELLED"}\n\n`,
              `id: 1\nevent: assistant\ndata: {"text":"Starting"}\n\n`,
              `id: 2\nevent: done\ndata: {}\n\n`
            ].join("")
          ),
        getRun: () => json(200, { id: "run-1", status: "CANCELLED" })
      }
    })
    await within(opened.session.send("Restyle it"), "the send")

    expect(opened.session.turn().phase).toBe("stopped")
    expect(opened.session.state()).toBe("idle")
    await opened.close()
  })

  test("a stream that closes right after its status snapshot takes the answer from the run's record", async () => {
    const opened = await open({
      script: {
        stream: () => sse(`event: status\ndata: {"runId":"run-1","status":"FINISHED"}\n\n`),
        getRun: () => json(200, { id: "run-1", status: "FINISHED", result: "Applied." })
      }
    })
    await within(opened.session.send("Restyle it"), "the send")

    expect(said(opened.session.steps())).toEqual(["user:Restyle it", "assistant:Applied."])
    expect(opened.session.state()).toBe("idle")
    await opened.close()
  })

  test("a run that streamed no text and answers only in its result frame still shows that answer", async () => {
    const live = liveStream()
    const opened = await open({ script: { stream: (signal) => live.respond(signal) } })
    const sending = opened.session.send("Restyle it")
    await until(() => opened.bridges.length > 0, "the relay bridge")
    const bridge = opened.bridges[0]!

    await Effect.runPromise(
      Queue.offer(bridge.incoming, {
        type: "request",
        id: "call-1",
        method: "tools/call",
        params: { name: "apply_styles", arguments: { css: "body{color:red}" } }
      })
    )
    await until(
      () => opened.session.steps().some((step) => step.kind === "tool" && step.result !== undefined),
      "the finished tool step"
    )
    live.push(`id: 3\nevent: result\ndata: {"runId":"run-1","status":"FINISHED","text":"You chose a light header."}\n\n`)
    live.push(`id: 4\nevent: done\ndata: {}\n\n`)
    live.close()
    await sending

    expect(said(opened.session.steps())).toEqual([
      "user:Restyle it",
      "tool:apply_styles",
      "assistant:You chose a light header."
    ])
    await opened.close()
  })

  test("a step history that cannot be stored keeps the run going and the transcript whole", async () => {
    const failures: Array<CursorStorageError> = []
    const stepStorage: CursorStepStorage = {
      load: () => Effect.succeed(undefined),
      save: () => new CursorStorageError({ operation: "write", detail: "QuotaExceededError" }),
      drop: () => Effect.void
    }
    const opened = await open({
      stepStorage,
      onStorageFailure: (failure) =>
        Effect.sync(() => {
          failures.push(failure)
        }),
      script: { stream: () => done("FINISHED", "Applied.") }
    })
    await opened.session.send("Restyle it")

    expect(said(opened.session.steps())).toEqual(["user:Restyle it", "assistant:Applied."])
    expect(opened.session.state()).toBe("idle")
    expect(failures.length).toBeGreaterThan(0)
    // The diagnostic names the failure and never the reader's page.
    expect(failures.every((failure) => !failure.message.includes("Restyle it"))).toBe(true)
    await opened.close()
  })

  test("a session that could not read its history leaves the saved one alone", async () => {
    const history = [
      { kind: "user", text: "Restyle it", at: 1 },
      { kind: "assistant", text: "Applied.", at: 2 }
    ]
    const stepStorage = flakySteps({ "thread-1": history })
    const storage = memoryCursorStorage({
      "thread-1": { version: CURSOR_RECORD_VERSION, agentId: "bc-1" }
    })
    // The store cannot answer for this one open. The next one reads it back.
    stepStorage.failLoads(1)
    const opened = await open({
      storage,
      stepStorage,
      script: { stream: () => done("FINISHED", "Applied again.") }
    })
    // The transcript the reader sees is not the thread's history, and says so.
    expect(said(opened.session.steps())).toEqual([`error:${HISTORY_UNREADABLE}`])
    await opened.session.send("Restyle it again")
    await opened.close()

    // Every step of the history is still there, under the run that could not read it.
    expect(stepStorage.peek("thread-1")).toEqual(history)

    const reopened = await open({ storage, stepStorage })
    expect(said(reopened.session.steps())).toEqual(["user:Restyle it", "assistant:Applied."])
    await reopened.close()
  })

  test("stop cancels the active run and keeps the steps that already settled", async () => {
    const live = liveStream()
    const opened = await open({ script: { stream: (signal) => live.respond(signal) } })
    const sending = opened.session.send("Restyle it")
    await until(() => opened.session.state() === "working", "the working state")
    live.push(`event: status\ndata: {"runId":"run-1","status":"RUNNING"}\n\n`)
    live.push(`id: 1\nevent: assistant\ndata: {"text":"Half done."}\n\n`)
    await until(
      () => opened.session.turn().answerDraft === "Half done.",
      "the streamed text"
    )

    await opened.session.stop()
    await sending

    expect(opened.calls.some((call) => call.url.endsWith("/runs/run-1/cancel"))).toBe(true)
    expect(said(opened.session.steps())).toEqual(["user:Restyle it", "thinking:Half done."])
    expect(opened.session.turn().phase).toBe("stopped")
    expect(opened.session.state()).toBe("idle")
    await opened.close()
  })

  test("Stop shows the turn stopped at once, before Cursor answers the cancel", async () => {
    const live = liveStream()
    let cancelled = false
    const opened = await open({
      script: {
        stream: (signal) => live.respond(signal),
        cancel: () =>
          new Promise<Response>((resolve) =>
            setTimeout(() => {
              cancelled = true
              resolve(json(200, { id: "run-1" }))
            }, 400)
          )
      }
    })
    const sending = opened.session.send("Restyle it")
    await until(() => opened.session.state() === "working", "the working state")
    live.push(`event: status\ndata: {"runId":"run-1","status":"RUNNING"}\n\n`)
    live.push(`id: 1\nevent: assistant\ndata: {"text":"Half"}\n\n`)
    await until(() => opened.session.turn().answerDraft === "Half", "the streamed text")

    const stopping = opened.session.stop()
    await within(
      until(() => opened.session.turn().phase === "stopped" && opened.session.state() === "idle", "the stopped turn"),
      "the stopped turn",
      150
    )
    expect(cancelled).toBe(false)
    // A steer waits for the cancel, so the next send is not refused as busy.
    await stopping
    expect(cancelled).toBe(true)
    await sending
    expect(said(opened.session.steps())).toEqual(["user:Restyle it", "thinking:Half"])
    await opened.close()
  })

  test("a finished run answering cancel with 409 run_not_cancellable adds no error step", async () => {
    const live = liveStream()
    const opened = await open({
      script: {
        stream: (signal) => live.respond(signal),
        cancel: () =>
          json(409, { error: { code: "run_not_cancellable", message: "Run is not cancellable." } })
      }
    })
    const sending = opened.session.send("Restyle it")
    await until(() => opened.session.state() === "working", "the working state")

    await opened.session.stop()
    await sending

    expect(kinds(opened.session.steps())).toEqual(["user"])
    expect(opened.session.state()).toBe("idle")
    await opened.close()
  })

  test("a busy agent is one error step carrying Cursor's own message", async () => {
    const opened = await open({
      script: {
        createRun: () =>
          json(409, { error: { code: "agent_busy", message: "This agent already has an active run." } })
      }
    })
    await opened.session.send("one")
    await opened.session.send("two")

    expect(said(opened.session.steps()).slice(-2)).toEqual([
      "user:two",
      "error:This agent already has an active run."
    ])
    expect(opened.session.state()).toBe("idle")
    await opened.close()
  })

  test("a rejected key is one error step carrying Cursor's own message", async () => {
    const opened = await open({
      script: {
        createAgent: () => json(401, { error: { code: "unauthorized", message: "Invalid API key" } })
      }
    })
    await opened.session.send("one")

    expect(said(opened.session.steps())).toEqual(["user:one", "error:Invalid API key"])
    await opened.close()
  })

  test("a no-repository refusal is one error step carrying Cursor's own message", async () => {
    const opened = await open({
      script: {
        createAgent: () =>
          json(403, {
            error: {
              code: "repository_required",
              message: "No-repository agents are not enabled for your account."
            }
          })
      }
    })
    await opened.session.send("one")

    expect(said(opened.session.steps())).toEqual([
      "user:one",
      "error:No-repository agents are not enabled for your account."
    ])
    await opened.close()
  })

  test("an expired agent is one error step, and the next send creates a new agent", async () => {
    const storage = memoryCursorStorage()
    let agents = 0
    const opened = await open({
      storage,
      script: {
        createAgent: () => {
          agents += 1
          return json(200, { agent: { id: `bc-${agents}` }, run: { id: "run-1", status: "CREATING" } })
        },
        createRun: () => json(404, { error: { code: "agent_not_found", message: "Agent not found." } })
      }
    })
    await opened.session.send("one")
    await opened.session.send("two")

    expect(said(opened.session.steps()).slice(-1)).toEqual(["error:Agent not found."])
    await opened.session.send("three")

    expect(agents).toBe(2)
    expect(said(opened.session.steps()).slice(-2)).toEqual(["user:three", "assistant:Done."])
    await opened.close()
  })

  test("a stream that ends without a terminal status recovers the run's real state", async () => {
    const opened = await open({
      script: {
        stream: () => sse(`event: status\ndata: {"runId":"run-1","status":"RUNNING"}\n\n`),
        getRun: () => json(200, { id: "run-1", status: "FINISHED", result: "Wrapped up." })
      }
    })
    await opened.session.send("Restyle it")

    expect(said(opened.session.steps())).toEqual(["user:Restyle it", "assistant:Wrapped up."])
    expect(opened.session.state()).toBe("idle")
    await opened.close()
  })

  test("a stream that ends early and a run Cursor cannot check keeps the run for Stop", async () => {
    const opened = await open({
      script: {
        stream: () => sse(`event: status\ndata: {"runId":"run-1","status":"RUNNING"}\n\n`),
        getRun: () => {
          throw new Error("offline")
        }
      }
    })
    await opened.session.send("Restyle it")

    expect(said(opened.session.steps())).toEqual(["user:Restyle it", `error:${NO_TERMINAL_STATUS}`])
    expect(opened.session.state()).toBe("working")

    await opened.session.stop()
    expect(opened.calls.some((call) => call.url.endsWith("/runs/run-1/cancel"))).toBe(true)
    expect(opened.session.state()).toBe("idle")
    await opened.close()
  })

  test("a broken stream of a finished run folds the final answer, with no error step", async () => {
    const opened = await open({
      script: {
        stream: () =>
          json(410, { error: { code: "stream_expired", message: "Run stream is no longer available" } }),
        getRun: () => json(200, { id: "run-1", status: "FINISHED", result: "Applied while away." })
      }
    })
    await opened.session.send("Restyle it")

    expect(said(opened.session.steps())).toEqual(["user:Restyle it", "assistant:Applied while away."])
    expect(opened.session.turn().phase).toBe("complete")
    expect(opened.session.state()).toBe("idle")
    await opened.close()
  })

  test("a live run gets one resumed read with Last-Event-ID when its stream breaks", async () => {
    const first = liveStream()
    const second = liveStream()
    let streams = 0
    const opened = await open({
      script: {
        stream: (signal) => {
          streams += 1
          return streams === 1 ? first.respond(signal) : second.respond(signal)
        },
        getRun: () => json(200, { id: "run-1", status: "RUNNING" })
      }
    })
    const sending = opened.session.send("Restyle it")
    await until(() => opened.session.state() === "working", "the working state")
    first.push(`event: status\ndata: {"runId":"run-1","status":"RUNNING"}\n\n`)
    first.push(`id: 7-0\nevent: assistant\ndata: {"text":"Half"}\n\n`)
    await until(() => opened.session.turn().activityText === "Half", "the first read's text")
    first.fail(new Error("connection reset"))

    await until(
      () => opened.calls.filter((call) => call.url.endsWith("/stream")).length === 2,
      "the resumed read"
    )
    const resume = opened.calls.filter((call) => call.url.endsWith("/stream"))[1]!
    expect(resume.headers["last-event-id"]).toBe("7-0")

    second.push(`id: 7-1\nevent: assistant\ndata: {"text":" done."}\n\n`)
    second.push(`id: 7-2\nevent: result\ndata: {"runId":"run-1","status":"FINISHED","text":"Half done."}\n\n`)
    second.push(`id: 7-3\nevent: done\ndata: {}\n\n`)
    second.close()
    await sending

    expect(said(opened.session.steps())).toEqual(["user:Restyle it", "assistant:Half done."])
    expect(opened.session.state()).toBe("idle")
    await opened.close()
  })

  test("a stream that gives up before any content is read again from the top, and the run streams whole", async () => {
    // Seen live on 2026-09-13 on an agent with a long history: Cursor answers 200, says
    // CREATING then RUNNING, then `stream_unavailable` and done, 1.4 s in. The same
    // request 4 s later streams the whole run. Nothing was applied, so a replay from the
    // top doubles nothing and no notice is due.
    let streams = 0
    const opened = await open({
      script: {
        stream: () => {
          streams += 1
          return streams === 1
            ? sse(
                [
                  `event: status\ndata: {"runId":"run-1","status":"CREATING"}\n\n`,
                  `event: status\ndata: {"runId":"run-1","status":"RUNNING"}\n\n`,
                  `event: error\ndata: {"code":"stream_unavailable","message":"Run stream is no longer available"}\n\n`,
                  `event: done\ndata: {}\n\n`
                ].join("")
              )
            : sse(
                [
                  `event: status\ndata: {"runId":"run-1","status":"RUNNING"}\n\n`,
                  `id: 1\nevent: assistant\ndata: {"text":"Whole answer."}\n\n`,
                  `id: 2\nevent: result\ndata: {"runId":"run-1","status":"FINISHED","text":"Whole answer."}\n\n`,
                  `id: 3\nevent: done\ndata: {}\n\n`
                ].join("")
              )
        },
        getRun: () => json(200, { id: "run-1", status: "RUNNING" })
      }
    })
    await opened.session.send("Restyle it")

    expect(said(opened.session.steps())).toEqual(["user:Restyle it", "assistant:Whole answer."])
    expect(opened.session.turn().phase).toBe("complete")
    const reads = opened.calls.filter((call) => call.url.endsWith("/stream"))
    expect(reads).toHaveLength(2)
    expect(reads[1]!.headers["last-event-id"]).toBeUndefined()
    await opened.close()
  })

  test("a live run whose stream stays broken is followed with its tool gate open, and Stop still cancels it", async () => {
    // Seen live on 2026-09-13: the read gave up, the gate closed, and the agent's three
    // commit calls came back "tool calls are not accepted outside an open run".
    const opened = await open({
      script: {
        stream: () =>
          json(410, { error: { code: "stream_expired", message: "Run stream is no longer available" } }),
        getRun: () => json(200, { id: "run-1", status: "RUNNING" })
      }
    })
    const sending = opened.session.send("Restyle it")
    await until(() => opened.session.steps().some((step) => step.kind === "error"), "the lost-stream notice")
    expect(said(opened.session.steps()).slice(-1)).toEqual([`error:${streamUnreadable("Run stream is no longer available")}`])
    expect(opened.session.state()).toBe("working")

    // The agent is still working at Cursor, so its tool calls must still land.
    await until(() => opened.bridges.length > 0, "the relay bridge")
    await Effect.runPromise(
      Queue.offer(opened.bridges[0]!.incoming, {
        type: "request",
        id: "call-1",
        method: "tools/call",
        params: { name: "apply_styles", arguments: { css: "body{color:red}" } }
      })
    )
    await until(
      () => opened.session.steps().some((step) => step.kind === "tool" && step.result !== undefined),
      "the accepted tool call"
    )
    await until(() => opened.calls.filter((call) => call.url.endsWith("/runs/run-1")).length > 1, "a second look at the record")

    await opened.session.stop()
    await sending
    expect(opened.calls.some((call) => call.url.endsWith("/runs/run-1/cancel"))).toBe(true)
    expect(opened.session.turn().phase).toBe("stopped")
    // The style the agent applied through the open gate is on the page.
    expect(opened.session.state()).toBe("applied")
    await opened.close()
  })

  test("a followed run settles from its record with the run's own result", async () => {
    let looks = 0
    const opened = await open({
      script: {
        stream: () =>
          json(410, { error: { code: "stream_expired", message: "Run stream is no longer available" } }),
        getRun: () => {
          looks += 1
          return looks < 3
            ? json(200, { id: "run-1", status: "RUNNING" })
            : json(200, { id: "run-1", status: "FINISHED", result: "Committed the look." })
        }
      }
    })
    await opened.session.send("Commit it")

    expect(said(opened.session.steps())).toEqual([
      "user:Commit it",
      `error:${streamUnreadable("Run stream is no longer available")}`,
      "assistant:Committed the look."
    ])
    expect(opened.session.turn().phase).toBe("complete")
    expect(opened.session.state()).toBe("idle")
    expect(looks).toBe(3)
    await opened.close()
  })

  test("a followed run whose record Cursor stops giving is kept for Stop after a few tries", async () => {
    let looks = 0
    const opened = await open({
      script: {
        stream: () =>
          json(410, { error: { code: "stream_expired", message: "Run stream is no longer available" } }),
        getRun: () => {
          looks += 1
          // One look per broken read: the first, and the one read again from the top.
          return looks <= 2
            ? json(200, { id: "run-1", status: "RUNNING" })
            : json(503, { error: { code: "unavailable", message: "Cursor is unavailable." } })
        }
      }
    })
    await opened.session.send("Restyle it")

    expect(said(opened.session.steps()).slice(-1)).toEqual(["error:Cursor is unavailable."])
    expect(looks).toBe(7)
    expect(opened.session.state()).toBe("working")
    await opened.session.stop()
    expect(opened.calls.some((call) => call.url.endsWith("/runs/run-1/cancel"))).toBe(true)
    await opened.close()
  })

  test("a run whose agent is gone fails the turn, and the next send starts a fresh agent", async () => {
    let agents = 0
    let streams = 0
    const opened = await open({
      script: {
        createAgent: () => {
          agents += 1
          return json(200, { agent: { id: `bc-${agents}` }, run: { id: "run-1", status: "CREATING" } })
        },
        stream: (signal) => {
          streams += 1
          if (streams === 1) {
            return json(410, { error: { code: "stream_expired", message: "Run stream is no longer available" } })
          }
          return done("FINISHED", "Done.")
        },
        getRun: () => json(404, { error: { code: "agent_not_found", message: "Agent not found." } })
      }
    })
    await opened.session.send("one")

    expect(said(opened.session.steps()).slice(-1)).toEqual([`error:${CURSOR_AGENT_GONE}`])
    expect(opened.session.state()).toBe("idle")

    await opened.session.send("two")
    expect(agents).toBe(2)
    expect(said(opened.session.steps()).slice(-2)).toEqual(["user:two", "assistant:Done."])
    await opened.close()
  })

  test("a stream error event on a run Cursor says failed is one error step with Cursor's reason", async () => {
    const opened = await open({
      script: {
        stream: () =>
          sse(`event: error\ndata: {"code":"upstream_error","message":"The worker went away."}\n\n`),
        getRun: () => json(200, { id: "run-1", status: "ERROR" })
      }
    })
    await opened.session.send("Restyle it")

    expect(said(opened.session.steps())).toEqual(["user:Restyle it", "error:The worker went away."])
    expect(opened.session.turn().phase).toBe("failed")
    expect(opened.session.state()).toBe("idle")
    await opened.close()
  })

  test("a busy answer with no local run adopts the run Cursor is holding", async () => {
    const live = liveStream()
    let streams = 0
    const opened = await open({
      script: {
        createRun: () =>
          json(409, { error: { code: "agent_busy", message: "Agent already has an active run" } }),
        getAgent: () => json(200, { id: "bc-1", status: "ACTIVE", latestRunId: "run-9" }),
        stream: (signal) => {
          streams += 1
          return streams === 1 ? done("FINISHED", "Done.") : live.respond(signal)
        }
      }
    })
    await opened.session.send("one")

    const sending = opened.session.send("two")
    await until(
      () => opened.calls.some((call) => call.url.endsWith("/runs/run-9/stream")),
      "the adopted run's stream"
    )
    expect(said(opened.session.steps()).slice(-1)).toEqual([`error:${RUN_BUSY_NOT_SENT}`])
    expect(opened.session.state()).toBe("working")

    live.push(`id: 1\nevent: result\ndata: {"runId":"run-9","status":"FINISHED","text":"Caught up."}\n\n`)
    live.push(`id: 2\nevent: done\ndata: {}\n\n`)
    live.close()
    await sending

    expect(said(opened.session.steps())).toEqual([
      "user:one",
      "assistant:Done.",
      "user:two",
      `error:${RUN_BUSY_NOT_SENT}`,
      "assistant:Caught up."
    ])
    expect(opened.session.state()).toBe("idle")
    await opened.close()
  })

  test("a steer whose cancel Cursor has not settled yet retries the create instead of adopting the cancelled run", async () => {
    // Seen live on 2026-09-13: Stop cancels run A, the next send gets 409 agent_busy a few
    // hundred ms later, and Morph adopted the run it had just cancelled. The steer text was lost.
    const live = liveStream()
    let creates = 0
    let streams = 0
    const opened = await open({
      script: {
        createRun: () => {
          creates += 1
          // The first follow-up run is the one the steer stops; its create succeeds.
          if (creates === 1) return json(200, { run: { id: "run-2", status: "CREATING" } })
          // Right after the cancel, Cursor still says busy once, then takes the new run.
          if (creates === 2) return json(409, { error: { code: "agent_busy", message: "This agent already has an active run." } })
          return json(200, { run: { id: "run-3", status: "CREATING" } })
        },
        getAgent: () => json(200, { id: "bc-1", status: "ACTIVE", latestRunId: "run-2" }),
        getRun: () => json(200, { id: "run-2", status: "CANCELLED" }),
        stream: (signal) => {
          streams += 1
          if (streams === 1) return done("FINISHED", "Done.")
          if (streams === 2) return live.respond(signal)
          return done("FINISHED", "Steered.")
        }
      }
    })
    await opened.session.send("one")
    const second = opened.session.send("two")
    await until(() => opened.calls.some((call) => call.url.endsWith("/runs/run-2/stream")), "run-2's stream")

    await opened.session.stop()
    await second
    await opened.session.send("three")

    expect(creates).toBe(3)
    expect(opened.calls.some((call) => call.url.endsWith("/runs/run-3/stream"))).toBe(true)
    expect(said(opened.session.steps())).toEqual(["user:one", "assistant:Done.", "user:two", "user:three", "assistant:Steered."])
    expect(opened.session.state()).toBe("idle")
    await opened.close()
  })

  test("Stop during a broken stream's recovery still clears the run", async () => {
    const opened = await open({
      script: {
        stream: () =>
          json(410, { error: { code: "stream_expired", message: "Run stream is no longer available" } }),
        getRun: (signal) =>
          new Promise<Response>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
          })
      }
    })
    const sending = opened.session.send("one")
    await until(
      () => opened.calls.some((call) => call.url.endsWith("/runs/run-1") && call.method === "GET"),
      "the recovery lookup"
    )

    await opened.session.stop()
    await sending

    expect(kinds(opened.session.steps())).toEqual(["user"])
    expect(opened.session.state()).toBe("idle")
    await opened.close()
  })

  test("a run whose record is gone settles without costing the thread its agent", async () => {
    let agents = 0
    const opened = await open({
      script: {
        createAgent: () => {
          agents += 1
          return json(200, { agent: { id: "bc-1" }, run: { id: "run-1", status: "CREATING" } })
        },
        stream: () =>
          json(410, { error: { code: "stream_expired", message: "Run stream is no longer available" } }),
        getRun: () => json(404, { error: { code: "run_not_found", message: "Run not found." } })
      }
    })
    await opened.session.send("one")

    expect(said(opened.session.steps()).slice(-1)).toEqual([`error:${CURSOR_RUN_GONE}`])
    expect(opened.session.state()).toBe("idle")

    // The agent survived the run's loss: the next send creates a run on it, not an agent.
    await opened.session.send("two")
    expect(agents).toBe(1)
    expect(opened.calls.some((call) => call.url.endsWith("/v1/agents/bc-1/runs"))).toBe(true)
    await opened.close()
  })

  test("a break before any event id does not resume into a doubled transcript", async () => {
    const first = liveStream()
    const opened = await open({
      script: {
        stream: (signal) => first.respond(signal),
        getRun: () => json(200, { id: "run-1", status: "RUNNING" })
      }
    })
    const sending = opened.session.send("one")
    await until(() => opened.session.state() === "working", "the working state")
    // A content event with no id: nothing to resume from, so a replay would double it.
    first.push(`event: assistant\ndata: {"text":"Half"}\n\n`)
    await until(() => opened.session.turn().activityText === "Half", "the id-less text")
    first.fail(new Error("connection reset"))
    await until(() => opened.session.steps().some((step) => step.kind === "error"), "the lost-stream notice")

    expect(opened.calls.filter((call) => call.url.endsWith("/stream"))).toHaveLength(1)
    expect(said(opened.session.steps()).slice(-1)).toEqual([`error:${streamUnreadable("The Cursor run stream stopped.")}`])
    expect(opened.session.state()).toBe("working")
    await opened.session.stop()
    await sending
    await opened.close()
  })

  test("a send on a run whose reader broke reattaches instead of asking Cursor for a parallel run", async () => {
    const live = liveStream()
    let streams = 0
    const opened = await open({
      script: {
        stream: (signal) => {
          streams += 1
          return streams === 1
            ? json(410, { error: { code: "stream_expired", message: "Run stream is no longer available" } })
            : live.respond(signal)
        },
        // Cursor cannot say what the run did, so the reader gives up and keeps the run stored.
        getRun: () => json(503, { error: { code: "unavailable", message: "Cursor is unavailable." } })
      }
    })
    await opened.session.send("one")
    expect(said(opened.session.steps()).slice(-1)).toEqual(["error:Run stream is no longer available"])
    expect(opened.session.state()).toBe("working")

    const sending = opened.session.send("two")
    await until(
      () => opened.calls.filter((call) => call.url.endsWith("/stream")).length === 2,
      "the reattached read"
    )
    expect(opened.calls.some((call) => call.method === "POST" && call.url.endsWith("/runs"))).toBe(false)
    expect(said(opened.session.steps()).slice(-1)).toEqual([`error:${RUN_BUSY_NOT_SENT}`])

    live.push(`id: 1\nevent: result\ndata: {"runId":"run-1","status":"FINISHED","text":"Kept going."}\n\n`)
    live.push(`id: 2\nevent: done\ndata: {}\n\n`)
    live.close()
    await sending

    expect(said(opened.session.steps())).toEqual([
      "user:one",
      "error:Run stream is no longer available",
      "user:two",
      `error:${RUN_BUSY_NOT_SENT}`,
      "assistant:Kept going."
    ])
    expect(opened.session.state()).toBe("idle")
    await opened.close()
  })

  test("a reopened thread folds the answer a finished run gave while away", async () => {
    const storage = memoryCursorStorage({
      "thread-1": {
        version: CURSOR_RECORD_VERSION,
        agentId: "bc-1",
        activeRun: { agentId: "bc-1", runId: "run-1", startedAt: 1 }
      }
    })
    const opened = await open({
      storage,
      script: {
        stream: () =>
          json(410, { error: { code: "stream_expired", message: "Run stream is no longer available" } }),
        getRun: () => json(200, { id: "run-1", status: "FINISHED", result: "Done while away." })
      }
    })

    await until(
      () => opened.session.steps().some((step) => step.kind === "assistant"),
      "the folded answer"
    )
    expect(said(opened.session.steps())).toEqual(["assistant:Done while away."])
    expect(opened.session.state()).toBe("idle")
    await opened.close()
  })

  test("a reopened thread whose stored run is live but unreadable says so, even quietly", async () => {
    const storage = memoryCursorStorage({
      "thread-1": {
        version: CURSOR_RECORD_VERSION,
        agentId: "bc-1",
        activeRun: { agentId: "bc-1", runId: "run-1", startedAt: 1 }
      }
    })
    const opened = await open({
      storage,
      script: {
        stream: () =>
          json(410, { error: { code: "stream_expired", message: "Run stream is no longer available" } }),
        getRun: () => json(200, { id: "run-1", status: "RUNNING" })
      }
    })

    await until(
      () => opened.session.steps().some((step) => step.kind === "error"),
      "the unreadable-run notice"
    )
    expect(said(opened.session.steps())).toEqual([`error:${streamUnreadable("Run stream is no longer available")}`])
    expect(opened.session.state()).toBe("working")

    await opened.session.stop()
    expect(opened.calls.some((call) => call.url.endsWith("/runs/run-1/cancel"))).toBe(true)
    expect(opened.session.state()).toBe("idle")
    await opened.close()
  })

  test("non-success terminal statuses never become completed answers", async () => {
    for (const [status, phase] of [
      ["CANCELLED", "stopped"],
      ["ERROR", "failed"],
      ["EXPIRED", "failed"]
    ] as const) {
      const opened = await open({ script: { stream: () => done(status, "Partial.") } })
      await opened.session.send(status)

      expect(opened.session.turn().phase).toBe(phase)
      expect(opened.session.steps().some((step) => step.kind === "assistant")).toBe(false)
      await opened.close()
    }
  })

  test("a reopened thread shows its persisted steps and continues the same agent", async () => {
    const storage = memoryCursorStorage()
    const first = await open({ storage })
    await first.session.send("one")
    await first.close()

    const second = await open({ storage })
    expect(said(second.session.steps())).toEqual(["user:one", "assistant:Done."])
    await second.session.send("two")

    expect(second.calls.filter((call) => call.url === "https://api.cursor.com/v1/agents")).toHaveLength(0)
    expect(second.calls.some((call) => call.url === "https://api.cursor.com/v1/agents/bc-1/runs")).toBe(true)
    await second.close()
  })

  test("clear drops the thread's Cursor steps and archives its agent", async () => {
    const storage = memoryCursorStorage()
    const opened = await open({ storage })
    await opened.session.send("one")
    await opened.session.clear()

    expect(opened.session.steps()).toEqual([])
    expect(opened.session.state()).toBe("idle")
    expect(opened.calls.some((call) => call.url.endsWith("/v1/agents/bc-1/archive"))).toBe(true)
    await opened.close()

    const reopened = await open({ storage })
    expect(reopened.session.steps()).toEqual([])
    await reopened.session.send("two")
    expect(reopened.calls.some((call) => call.url === "https://api.cursor.com/v1/agents")).toBe(true)
    await reopened.close()
  })

  test("an archive Cursor refuses never reaches the reader as an error step", async () => {
    const opened = await open({
      script: { archive: () => json(500, { error: { code: "internal_error", message: "boom" } }) }
    })
    await opened.session.send("one")
    await opened.session.reset()

    expect(opened.session.steps()).toEqual([])
    expect(opened.session.state()).toBe("idle")
    await opened.close()
  })

  test("a relay that registers again with a new identity sends the new bridge to the next run", async () => {
    const relay: RelayControl = { identities: [IDENTITY, NEXT_IDENTITY], unknownBridge: true }
    const bridges: Array<Bridge> = []
    const opened = await open({ relay, bridges })
    await opened.session.send("one")

    // The relay restarted: the socket drops, the reconnect is refused, a register follows.
    bridges[0]!.drop()
    await until(() => bridges.length >= 3, "a re-registered relay bridge")
    await until(
      () => bridges[2]!.sent.some((message) => message.type === "register"),
      "the fresh registration"
    )
    await opened.session.send("two")

    const follow = opened.calls.find((call) => call.url.endsWith("/v1/agents/bc-1/runs"))!
    const body = follow.body as {
      mcpServers: ReadonlyArray<{ url: string; headers: Record<string, string> }>
    }
    expect(body.mcpServers[0]?.url).toBe(NEXT_IDENTITY.mcpUrl)
    expect(body.mcpServers[0]?.headers.Authorization).toBe(`Bearer ${NEXT_IDENTITY.token}`)
    await opened.close()
  })

  test("a send while the relay is disconnected fails at once, before any Cursor request", async () => {
    const relay: RelayControl = {}
    const bridges: Array<Bridge> = []
    const opened = await open({ relay, bridges, relayReadyMs: 2_000 })
    await opened.session.send("one")

    relay.fails = true
    const attempts = relay.attempts ?? 0
    bridges[0]!.drop()
    await until(() => (relay.attempts ?? 0) > attempts, "a refused reconnect")

    const before = opened.calls.length
    const started = Date.now()
    await opened.session.send("two")

    expect(Date.now() - started).toBeLessThan(1_000)
    expect(opened.calls.length).toBe(before)
    expect(said(opened.session.steps()).slice(-2)).toEqual(["user:two", `error:${RELAY_UNREACHABLE}`])
    expect(opened.session.state()).toBe("idle")
    await opened.close()
  })

  test("a busy second send leaves the first run's tools working", async () => {
    const live = liveStream()
    const bridges: Array<Bridge> = []
    const opened = await open({
      bridges,
      script: {
        stream: (signal) => live.respond(signal),
        createRun: () =>
          json(409, { error: { code: "agent_busy", message: "This agent already has an active run." } })
      }
    })
    const sending = opened.session.send("one")
    await until(() => opened.session.state() === "working", "the working state")
    await until(() => bridges.length > 0, "the relay bridge")
    const bridge = bridges[0]!

    await opened.session.send("two")
    expect(said(opened.session.steps()).slice(-2)).toEqual([
      "user:two",
      "error:This agent already has an active run."
    ])

    // The first run still owns the tool gate, so its later calls still run.
    await Effect.runPromise(
      Queue.offer(bridge.incoming, {
        type: "request",
        id: "call-1",
        method: "tools/call",
        params: { name: "apply_styles", arguments: { css: "body{color:red}" } }
      })
    )
    await until(
      () => opened.session.steps().some((step) => step.kind === "tool"),
      "the tool step of the first run"
    )
    const answer = bridge.sent.find(
      (message) => message.type === "response" && message.id === "call-1"
    )!
    expect("error" in answer).toBe(false)
    expect(JSON.stringify(answer)).not.toContain("outside an open run")

    live.push(`id: 1\nevent: result\ndata: {"runId":"run-1","status":"FINISHED","text":"Done."}\n\n`)
    live.close()
    await sending
    expect(opened.session.state()).toBe("applied")
    await opened.close()
  })

  test("two sends that start together create one agent and one run", async () => {
    const live = liveStream()
    const opened = await open({
      script: {
        stream: (signal) => live.respond(signal),
        createRun: () =>
          json(409, { error: { code: "agent_busy", message: "This agent already has an active run." } })
      }
    })
    const first = opened.session.send("one")
    const second = opened.session.send("two")
    await within(second, "the second send")

    expect(opened.calls.filter((call) => call.url === "https://api.cursor.com/v1/agents")).toHaveLength(1)
    expect(said(opened.session.steps()).slice(-1)).toEqual([
      "error:This agent already has an active run."
    ])

    live.push(`id: 1\nevent: result\ndata: {"runId":"run-1","status":"FINISHED","text":"Done."}\n\n`)
    live.close()
    await within(first, "the first run")
    await opened.close()
  })

  test("a run that settles while the next run starts never ends the next run", async () => {
    const first = liveStream()
    const second = liveStream()
    const bridges: Array<Bridge> = []
    let streams = 0
    const opened = await open({
      bridges,
      heartbeatMs: 5,
      script: {
        stream: (signal) => {
          streams += 1
          return streams === 1 ? first.respond(signal) : second.respond(signal)
        },
        createRun: () => {
          // Cursor settles run one between send two's check of the active run and this
          // answer. The frame is on the wire without its closing blank line, so Morph
          // reads it only after run two starts.
          first.push(
            `id: 9\nevent: status\ndata: {"runId":"run-1","status":"FINISHED"}`
          )
          return json(200, { run: { id: "run-2", status: "CREATING" } })
        }
      }
    })
    const sendingFirst = opened.session.send("one")
    await until(() => opened.session.state() === "working", "the first run")
    await until(() => bridges.length > 0, "the relay bridge")
    first.push(`id: 8\nevent: assistant\ndata: {"text":"One done."}\n\n`)
    await until(
      () => opened.session.turn().answerDraft === "One done.",
      "the first run answer draft"
    )

    const sendingSecond = opened.session.send("two")
    await until(
      () => opened.calls.some((call) => call.url.endsWith("/runs/run-2/stream")),
      "the second run reading its stream"
    )
    second.push(
      `id: 10\nevent: assistant\ndata: {"text":"Second run is working."}\n\n`
    )
    await until(
      () => opened.session.turn().activityText === "Second run is working.",
      "the second run activity"
    )

    // Run one ends now, so its finalizer runs after run two took the gate.
    first.push("\n\n")
    first.close()
    await within(sendingFirst, "the first run to end")

    expect(opened.session.state()).toBe("working")
    expect(opened.session.turn().phase).toBe("answering")
    expect(opened.session.turn().activityText).toBe("Second run is working.")
    expect(opened.session.turn().finalAnswer).toBe("")
    expect(said(opened.session.steps()).slice(0, 3)).toEqual([
      "user:one",
      "assistant:One done.",
      "user:two"
    ])

    // The second run still owns the tool gate.
    await Effect.runPromise(
      Queue.offer(bridges[0]!.incoming, {
        type: "request",
        id: "call-2",
        method: "tools/call",
        params: { name: "apply_styles", arguments: { css: "body{color:red}" } }
      })
    )
    await until(
      () => opened.session.steps().some((step) => step.kind === "tool"),
      "the second run's tool step"
    )

    // Its heartbeat still holds the service worker.
    const beats = bridges[0]!.sent.filter((message) => message.type === "ping").length
    await until(
      () => bridges[0]!.sent.filter((message) => message.type === "ping").length > beats,
      "the second run's heartbeat"
    )

    // Stop still targets the second run.
    await opened.session.stop()
    await within(sendingSecond, "the second run to end")
    expect(opened.calls.some((call) => call.url.endsWith("/runs/run-2/cancel"))).toBe(true)
    expect(opened.calls.some((call) => call.url.endsWith("/runs/run-1/cancel"))).toBe(false)
    expect(opened.session.state()).toBe("applied")
    await opened.close()
  })

  test("a run the next run took over from does not outlive the session scope", async () => {
    const first = liveStream()
    const second = liveStream()
    let streams = 0
    const opened = await open({
      script: {
        stream: (signal) => {
          streams += 1
          return streams === 1 ? first.respond(signal) : second.respond(signal)
        },
        createRun: () => json(200, { run: { id: "run-2", status: "CREATING" } })
      }
    })
    const sendingFirst = opened.session.send("one")
    await until(() => opened.session.state() === "working", "the first run")
    const sendingSecond = opened.session.send("two")
    await until(
      () => opened.calls.some((call) => call.url.endsWith("/runs/run-2/stream")),
      "the second run reading its stream"
    )

    // The reader closed the thread. Nothing may be left reading a Cursor stream.
    await within(opened.close(), "the session scope to close")
    await within(sendingFirst, "the first run to end")
    await within(sendingSecond, "the second run to end")
  })

  test("stop on a transport that aborts its read adds no stream error step", async () => {
    const live = liveStream()
    const opened = await open({ script: { stream: (signal) => live.respond(signal) } })
    const sending = opened.session.send("Restyle it")
    await until(() => opened.session.state() === "working", "the working state")
    live.push(`id: 1\nevent: assistant\ndata: {"text":"Half done."}\n\n`)
    await until(
      () => opened.session.turn().answerDraft === "Half done.",
      "the streamed text"
    )

    await opened.session.stop()
    await sending

    expect(kinds(opened.session.steps())).toEqual(["user", "thinking"])
    expect(opened.session.state()).toBe("idle")
    await opened.close()
  })

  test("closing the session scope ends a live run, with no stop call at all", async () => {
    const live = liveStream()
    const opened = await open({ script: { stream: (signal) => live.respond(signal) } })
    const sending = opened.session.send("Restyle it")
    await until(() => opened.session.state() === "working", "the working state")

    await within(opened.close(), "the session scope to close")
    await within(sending, "the run to end")
  })

  test("the steps snapshot is stable while nothing changed", async () => {
    const opened = await open()
    const before = opened.session.steps()
    expect(opened.session.steps()).toBe(before)
    await opened.session.send("one")
    const after = opened.session.steps()
    expect(after).not.toBe(before)
    expect(opened.session.steps()).toBe(after)
    await opened.close()
  })
})
