import { describe, expect, test } from "bun:test"
import { Deferred, Effect } from "effect"
import { imageContent, makeExtensionToolServer } from "./extension"
import { askUserCallId, CURSOR_TOOL_NAMES, fakeWorld, type CursorToolName } from "./testing"

describe("extension relay tool server", () => {
  test("lists the canonical tools and returns a text answer from the world", async () => {
    const steps: unknown[] = []
    const server = await Effect.runPromise(
      makeExtensionToolServer({
        url: "https://example.com/products",
        world: fakeWorld(),
        onStep: (step) => Effect.sync(() => steps.push(step))
      })
    )

    await Effect.runPromise(server.openRun())
    expect(await Effect.runPromise(server.list())).toEqual(
      (await import("../agent/tools")).toolsFor({ url: "https://example.com/products" }).map((tool) => tool.spec)
    )
    expect(
      await Effect.runPromise(
        server.call("call-1", {
          name: "read_page",
          arguments: { selector: "main" }
        })
      )
    ).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            url: "https://example.com/products",
            title: "Products",
            viewport: { width: 1200, height: 800 },
            stylesheets: [],
            outline: "body\n  main Products",
            nodes: 2,
            truncated: false
          })
        }
      ]
    })
    expect(steps).toEqual([
      {
        kind: "tool",
        callId: expect.any(String),
        name: "read_page",
        input: { selector: "main" },
        result: {
          url: "https://example.com/products",
          title: "Products",
          viewport: { width: 1200, height: 800 },
          stylesheets: [],
          outline: "body\n  main Products",
          nodes: 2,
          truncated: false
        },
        at: expect.any(Number)
      }
    ])
  })

  test("returns look as image content and keeps image bytes out of the emitted step", async () => {
    const steps: unknown[] = []
    const server = await Effect.runPromise(
      makeExtensionToolServer({
        url: "https://example.com/products",
        world: fakeWorld(),
        onStep: (step) => Effect.sync(() => steps.push(step))
      })
    )
    await Effect.runPromise(server.openRun())

    expect(
      await Effect.runPromise(server.call("look-1", { name: "look", arguments: {} }))
    ).toEqual({
      content: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/jpeg" }]
    })
    expect(steps).toEqual([
      {
        kind: "tool",
        callId: expect.any(String),
        name: "look",
        input: {},
        result: { ok: true, image: "the screenshot follows as an image" },
        at: expect.any(Number)
      }
    ])
  })

  test("a look the page hands back in another form is read by the same rule", () => {
    expect(imageContent("data:image/png;base64,QUJD")).toEqual({
      content: [{ type: "image", data: "QUJD", mimeType: "image/png" }]
    })
    // Chrome writes the charset on some captures. The type is still the type.
    expect(imageContent("data:image/webp;charset=utf-8;base64,QUJD")).toEqual({
      content: [{ type: "image", data: "QUJD", mimeType: "image/webp" }]
    })
    // No type given is `text/plain` by the data URL rule, and no image at all.
    expect(imageContent("data:;base64,QUJD")).toMatchObject({ isError: true })
    // Not a data URL. Sending its whole text as image bytes is how a page's own string
    // would have reached the agent dressed as a screenshot.
    expect(imageContent("https://example.com/shot.png")).toMatchObject({ isError: true })
    expect(imageContent("data:image/png,QUJD")).toMatchObject({ isError: true })
  })

  test("runs every canonical tool through the shared dispatcher", async () => {
    const steps: Array<{ readonly name: string }> = []
    const question = askUserCallId()
    const server = await Effect.runPromise(
      makeExtensionToolServer({
        url: "https://example.com/products",
        world: fakeWorld(),
        onToolStart: question.onToolStart,
        onStep: (step) => Effect.sync(() => steps.push(step))
      })
    )
    await Effect.runPromise(server.openRun())

    const inputs: Record<CursorToolName, unknown> = {
      // A question controller answers now, so ask_user parks until this test answers it.
      ask_user: {
        question: "Cards or rows?",
        options: [
          { id: "cards", label: "Cards" },
          { id: "rows", label: "Rows" }
        ]
      },
      write_todos: {
        todos: [{ id: "1", title: "Read", status: "completed" }]
      },
      read_page: {},
      read_styles: { selector: "body" },
      read_text: { selector: "body" },
      fetch_url: { url: "https://example.com/data.json", accept: "json" },
      read_design: {},
      write_design: { tokens: {} },
      apply_styles: { css: "body { color: black; }" },
      run_script: { js: "return 1" },
      write_skin: {
        files: [{ path: "page.tsx", content: "export default function Page(){}" }]
      },
      load_kit: {},
      look: {}
    }

    const answers = []
    for (const name of CURSOR_TOOL_NAMES) {
      const pending = Effect.runPromise(
        server.call(`all-${name}`, { name, arguments: inputs[name] })
      )
      if (name === "ask_user") {
        // The call is parked on the question; answer it so the walk goes on.
        expect(server.answerQuestion(await question.callId, ["cards"])).toBe(true)
      }
      answers.push(await pending)
    }

    expect(steps.map((step) => step.name)).toEqual([...CURSOR_TOOL_NAMES])
    expect(answers).toHaveLength(CURSOR_TOOL_NAMES.length)
    expect(answers.every((answer) => answer.isError !== true)).toBe(true)
  })

  test("an ask_user call waits for the reader's answer and returns the selected option", async () => {
    const question = askUserCallId()
    const finished: Array<{ readonly name: string; readonly result?: unknown }> = []
    const server = await Effect.runPromise(
      makeExtensionToolServer({
        url: "https://example.com/products",
        world: fakeWorld(),
        onToolStart: question.onToolStart,
        onStep: (step) => Effect.sync(() => finished.push(step))
      })
    )
    await Effect.runPromise(server.openRun())

    const pending = Effect.runPromise(
      server.call("q-1", {
        name: "ask_user",
        arguments: {
          question: "Which layout?",
          options: [
            { id: "grid", label: "Grid" },
            { id: "list", label: "List" }
          ]
        }
      })
    )
    // The call is parked on the question. The panel's click is what resolves it.
    expect(server.answerQuestion(await question.callId, ["list"])).toBe(true)
    const result = await pending
    const callId = await question.callId
    // The answer names its own call, since the model over MCP never sees the id otherwise
    // and publish_morph asks for it back.
    expect(result).toEqual({
      content: [{ type: "text", text: JSON.stringify({ callId, selected: [{ id: "list", label: "List" }] }) }]
    })
    expect(finished.find((step) => step.name === "ask_user")?.result).toEqual({
      callId,
      selected: [{ id: "list", label: "List" }]
    })
  })

  test("a stale ask_user answer is false and leaves the call parked", async () => {
    const server = await Effect.runPromise(
      makeExtensionToolServer({
        url: "https://example.com/products",
        world: fakeWorld(),
        onStep: () => Effect.void
      })
    )
    await Effect.runPromise(server.openRun())
    const pending = Effect.runPromise(
      server.call("q-2", {
        name: "ask_user",
        arguments: { question: "Which?", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }
      })
    )
    expect(server.answerQuestion("no-such-call", ["a"])).toBe(false)
    await Effect.runPromise(server.closeRun())
    const result = await pending
    // A cancelled question is a tool error the model reads, not a thrown call.
    expect(JSON.stringify(result)).toContain("cancelled")
  })

  test("closing the run cancels a pending ask_user", async () => {
    const server = await Effect.runPromise(
      makeExtensionToolServer({
        url: "https://example.com/products",
        world: fakeWorld(),
        onStep: () => Effect.void
      })
    )
    await Effect.runPromise(server.openRun())
    const pending = Effect.runPromise(
      server.call("q-3", {
        name: "ask_user",
        arguments: { question: "Which?", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }
      })
    )
    await Effect.runPromise(server.closeRun())
    const result = await pending
    expect(JSON.stringify(result)).toContain("cancelled")
  })

  test("returns the existing background-tab look error as MCP text", async () => {
    const error =
      "the page is not the visible tab; the reader has to have it in front to be looked at"
    const server = await Effect.runPromise(
      makeExtensionToolServer({
        url: "https://example.com/products",
        world: fakeWorld([], { lookError: error }),
        onStep: () => Effect.void
      })
    )
    await Effect.runPromise(server.openRun())

    expect(
      await Effect.runPromise(server.call("look-2", { name: "look", arguments: {} }))
    ).toEqual({
      content: [{ type: "text", text: JSON.stringify({ error }) }]
    })
  })

  test("rejects unknown and out-of-window calls without throwing", async () => {
    const server = await Effect.runPromise(
      makeExtensionToolServer({
        url: "https://example.com/products",
        world: fakeWorld(),
        onStep: () => Effect.void
      })
    )

    expect(
      await Effect.runPromise(
        server.call("closed", { name: "read_page", arguments: {} })
      )
    ).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: "tool calls are not accepted outside an open run"
          })
        }
      ],
      isError: true
    })
    await Effect.runPromise(server.openRun())
    expect(
      await Effect.runPromise(server.call("unknown", { name: "missing", arguments: {} }))
    ).toEqual({
      content: [
        { type: "text", text: JSON.stringify({ error: "unknown tool: missing" }) }
      ],
      isError: true
    })
    await Effect.runPromise(server.closeRun())
    expect(
      await Effect.runPromise(
        server.call("closed-again", { name: "read_page", arguments: {} })
      )
    ).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: "tool calls are not accepted outside an open run"
          })
        }
      ],
      isError: true
    })
  })

  test("serializes calls and lets one run keep probing the page", async () => {
    const gate = Effect.runSync(Deferred.make<void>())
    const events: string[] = []
    const server = await Effect.runPromise(
      makeExtensionToolServer({
        url: "https://example.com/products",
        world: fakeWorld(events, { readGate: gate }),
        onStep: () => Effect.void
      })
    )
    await Effect.runPromise(server.openRun())

    const first = Effect.runPromise(
      server.call("first", { name: "read_page", arguments: { selector: "first" } })
    )
    const second = Effect.runPromise(
      server.call("second", { name: "read_page", arguments: { selector: "second" } })
    )
    await Bun.sleep(5)
    expect(events).toEqual([])
    Effect.runFork(Deferred.succeed(gate, undefined))
    await Promise.all([first, second])
    expect(events).toEqual(["read:first", "read:second"])

    // No per-turn cap, the same as an OpenRouter run: a long probing turn keeps answering.
    for (let index = 2; index < 40; index += 1) {
      expect(
        await Effect.runPromise(
          server.call(`probe-${index}`, { name: "read_text", arguments: {} })
        )
      ).toEqual({
        content: [{ type: "text", text: JSON.stringify(["Products"]) }]
      })
    }
  })

  test("reports a tool before it runs and reports the result after it finishes", async () => {
    const gate = Effect.runSync(Deferred.make<void>())
    const started = Effect.runSync(Deferred.make<void>())
    const events: string[] = []
    const server = await Effect.runPromise(
      makeExtensionToolServer({
        url: "https://example.com/products",
        world: fakeWorld([], { readGate: gate }),
        onToolStart: (step) =>
          Effect.sync(() => {
            events.push(`start:${step.name}:${String(step.result)}`)
          }).pipe(Effect.andThen(Deferred.succeed(started, undefined))),
        onStep: (step) =>
          Effect.sync(() => {
            events.push(`finish:${step.name}:${String(step.result !== undefined)}`)
          })
      })
    )
    await Effect.runPromise(server.openRun())

    const running = Effect.runPromise(
      server.call("call-1", { name: "read_page", arguments: {} })
    )
    await Effect.runPromise(Deferred.await(started))
    expect(events).toEqual(["start:read_page:undefined"])

    await Effect.runPromise(Deferred.succeed(gate, undefined))
    await running
    expect(events).toEqual([
      "start:read_page:undefined",
      "finish:read_page:true"
    ])
  })

  test("preserves a close while a serialized call is in flight", async () => {
    const gate = Effect.runSync(Deferred.make<void>())
    const server = await Effect.runPromise(
      makeExtensionToolServer({
        url: "https://example.com/products",
        world: fakeWorld([], { readGate: gate }),
        onStep: () => Effect.void
      })
    )
    await Effect.runPromise(server.openRun())

    const first = Effect.runPromise(
      server.call("running", { name: "read_page", arguments: {} })
    )
    await Bun.sleep(1)
    const queued = Effect.runPromise(
      server.call("queued", { name: "read_page", arguments: {} })
    )
    await Effect.runPromise(server.closeRun())
    Effect.runFork(Deferred.succeed(gate, undefined))
    await first

    expect(await queued).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: "tool calls are not accepted outside an open run"
          })
        }
      ],
      isError: true
    })
  })
})
