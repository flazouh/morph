import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { memoryLog } from "../agent/log"
import { memoryDesigns } from "../agent/designs"
import { Compiler } from "../skin/service"
import { memoryWeb } from "../agent/web"
import { Page } from "../agent/page"
import { createCrew, createCrewRuntime, createWork } from "../agent/crew"
import type { CrewToolContext } from "../agent/tools"
import type { Skill } from "../skills/contract"
import { DEFAULT_SETTINGS } from "./contract"
import { realSession } from "./real"

/**
 * The session over a run whose model binding is a scripted `fetch`. The seam under test
 * is the one between the run and the panel: what the panel sees when a turn dies outside
 * the log, when the key is missing, and when the panel comes back after a turn.
 */

const world = Layer.mergeAll(
  Layer.succeed(Page, {
    read: () => Effect.succeed({ url: "https://x.test/", title: "x", viewport: { width: 1, height: 1 }, stylesheets: [], outline: "body", nodes: 1, truncated: false }),
    styles: () => Effect.succeed([]),
    text: () => Effect.succeed([]),
    tokens: () => Effect.succeed({ theme: null, tokens: {} }),
    style: () => Effect.void,
    design: () => Effect.void,
    run: () => Effect.succeed(null),
    skin: () => Effect.void,
    kit: () => Effect.void,
    look: () => Effect.succeed("data:image/jpeg;base64,"),
    forget: () => Effect.void,
    forgetSite: () => Effect.void
  }),
  memoryDesigns(),
  Layer.succeed(Compiler, { compile: () => Effect.succeed({ js: "", css: "", icons: {} }) }),
  memoryWeb()
)

const sse = (chunks: ReadonlyArray<unknown>) =>
  new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { status: 200, headers: { "Content-Type": "text/event-stream" } })

const saying = (text: string) =>
  sse([
    { id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
    { id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }
  ])

const until = async (ready: () => boolean, ms = 2_000): Promise<void> => {
  const start = Date.now()
  while (!ready()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting for the session view")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** A session whose model answers are scripted: `answer` is called once per model request. */
const open = (
  answer: (input?: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  logs = memoryLog(),
  key = "k",
  crew?: CrewToolContext
) =>
  realSession({
    url: "https://x.test/page",
    settings: async () => ({ ...DEFAULT_SETTINGS, openRouterKey: key }),
    world,
    logs,
    forget: async () => {},
    forgetSite: async () => {},
    fetch: answer as unknown as typeof fetch,
    ...(crew === undefined ? {} : { crew })
  })

describe("realSession", () => {
  test("an orphaned bot chat settles after a priced turn", async () => {
    const coordinator = createCrew()
    coordinator.spawnAgent("root", null)
    const runtime = createCrewRuntime(coordinator, () => "child", async () => {
      throw new Error("not used")
    })
    const crew: CrewToolContext = {
      agentId: "missing-child",
      parentId: "root",
      runtime: {
        ...runtime,
        recordSpend: () => {
          throw new Error("agent not found")
        }
      },
      work: createWork(coordinator),
      setTarget: () => {}
    }
    const session = await open(
      async () =>
        sse([
          { id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }] },
          { id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.01 } }
        ]),
      memoryLog(),
      "k",
      crew
    )

    await session.send("hello")

    expect(session.state()).toBe("idle")
    expect(session.steps().at(-1)).toMatchObject({ kind: "assistant", text: "done" })
  })

  test("a model binding that dies shows an error step, and the state settles instead of staying working", async () => {
    const session = await open(async () => {
      throw new Error("model stream idle beyond bound")
    })
    const seen: Array<string> = []
    session.subscribe(() => seen.push(session.state()))
    await session.send("hello")

    const steps = session.steps()
    expect(steps[0]).toMatchObject({ kind: "user", text: "hello" })
    expect(steps.at(-1)?.kind).toBe("error")
    expect(session.state()).toBe("idle")
    expect(seen).toContain("working")
    expect(seen.at(-1)).toBe("idle")
  })

  test("stop settles the active turn without adding an error", async () => {
    let markStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    let aborted = false
    const session = await open(async (_input, init) => {
      markStarted?.()
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            aborted = true
            reject(new DOMException("The operation was aborted.", "AbortError"))
          },
          { once: true }
        )
      })
    })

    const sending = session.send("stop this")
    await started
    await session.stop()

    expect(aborted).toBe(true)
    expect(session.state()).toBe("idle")
    expect(session.steps().map((step) => step.kind)).toEqual(["user"])
    await sending
  })

  test("stop settles even when saving the stopped turn fails", async () => {
    let markStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const logs = {
      ...memoryLog(),
      save: async () => {
        throw new Error("storage failed")
      }
    }
    const session = await open(async (_input, init) => {
      markStarted?.()
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true })
      })
    }, logs)

    const sending = session.send("stop this")
    await started
    await session.stop()

    expect(session.state()).toBe("idle")
    await sending
  })

  test("a missing key is one error step and no request", async () => {
    let requests = 0
    const session = await open(
      async () => {
        requests += 1
        return saying("nope")
      },
      memoryLog(),
      ""
    )
    await session.send("hello")
    expect(session.steps().map((s) => s.kind)).toEqual(["user", "error"])
    expect(session.steps().at(-1)).toMatchObject({ text: "Add your OpenRouter key in settings first." })
    expect(requests).toBe(0)
    expect(session.state()).toBe("idle")
  })

  test("answer tokens stay in the live turn, then settle as one reply", async () => {
    let push: ((chunk: string) => void) | undefined
    let close: (() => void) | undefined
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder()
        push = (chunk) => controller.enqueue(encoder.encode(chunk))
        close = () => controller.close()
      }
    })
    const session = await open(async () => new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } }))
    const sending = session.send("hello")
    await until(() => session.state() === "working")
    expect(session.steps().some((step) => step.kind === "assistant")).toBe(false)

    push?.(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { content: "Ap" } }] })}\n\n`)
    await until(() => session.turn().answerDraft === "Ap")
    expect(session.steps().some((step) => step.kind === "assistant")).toBe(false)
    expect(session.state()).toBe("working")

    push?.(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { content: "plied." } }] })}\n\n`)
    await until(() => session.turn().answerDraft === "Applied.")

    push?.(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`)
    push?.(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`)
    push?.("data: [DONE]\n\n")
    close?.()
    await sending
    expect(session.steps().map((step) => `${step.kind}:${"text" in step ? step.text : ""}`)).toEqual(["user:hello", "assistant:Applied."])
    expect(session.state()).toBe("idle")
  })

  test("thinking tokens from the stream stay on the turn after it settles", async () => {
    const session = await open(async () =>
      sse([
        { id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "I will restyle the list." } }] },
        { id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { content: "Done." }, finish_reason: null }] },
        { id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }
      ])
    )
    await session.send("dark")
    expect(session.steps().map((s) => `${s.kind}:${"text" in s ? s.text : ""}`)).toEqual([
      "user:dark",
      "thinking:I will restyle the list.",
      "assistant:Done."
    ])
  })

  test("a finished turn is drawn once: no duplicate of the reader's words, the answer last", async () => {
    const session = await open(async () => saying("Done."))
    await session.send("hello")
    expect(session.steps().map((s) => `${s.kind}:${"text" in s ? s.text : ""}`)).toEqual(["user:hello", "assistant:Done."])
    expect(session.state()).toBe("idle")
  })

  test("a later turn uses the model from the current settings", async () => {
    let current = { ...DEFAULT_SETTINGS, openRouterKey: "k", model: "first" }
    const seen: string[] = []
    const session = await realSession({
      url: "https://x.test/page",
      settings: async () => current,
      world,
      logs: memoryLog(),
      forget: async () => {},
      forgetSite: async () => {},
      fetch: (async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string }
        if (typeof body.model === "string") seen.push(body.model)
        return saying("ok")
      }) as unknown as typeof fetch
    })
    await session.send("one")
    current = { ...current, model: "second" }
    await session.send("two")
    expect(seen).toEqual(["first", "second"])
  })

  test("a later turn rebuilds the run with the current enabled skills", async () => {
    const makeSkill = (content: string): Skill => ({
      id: "custom",
      title: "Custom",
      summary: "Test guidance",
      content,
      kind: "custom",
      enabled: true,
      version: 1,
      updatedAt: "now"
    })
    let skills: ReadonlyArray<Skill> = [makeSkill("Use square corners.")]
    const systemPrompts: string[] = []
    const session = await realSession({
      url: "https://x.test/page",
      settings: async () => ({ ...DEFAULT_SETTINGS, openRouterKey: "k" }),
      skills: Effect.sync(() => skills),
      world,
      logs: memoryLog(),
      forget: async () => {},
      forgetSite: async () => {},
      fetch: (async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          messages?: ReadonlyArray<{ readonly role?: string; readonly content?: string }>
        }
        const system = body.messages?.find((message) => message.role === "system")?.content
        if (system !== undefined) systemPrompts.push(system)
        return saying("ok")
      }) as unknown as typeof fetch
    })

    await session.send("one")
    skills = [makeSkill("Use soft corners.")]
    await session.send("two")

    expect(systemPrompts).toHaveLength(2)
    expect(systemPrompts[0]).toContain("Use square corners.")
    expect(systemPrompts[1]).toContain("Use soft corners.")
    expect(systemPrompts[1]).not.toContain("Use square corners.")
  })

  test("the log survives the panel closing: a new session on the same store sees the old turn", async () => {
    const logs = memoryLog()
    const first = await open(async () => saying("First."), logs)
    await first.send("one")
    const second = await open(async () => saying("Second."), logs)
    expect(second.steps().map((s) => `${s.kind}:${"text" in s ? s.text : ""}`)).toEqual(["user:one", "assistant:First."])
    await second.send("two")
    expect(second.steps().map((s) => s.kind)).toEqual(["user", "assistant", "user", "assistant"])
  })

  test("one explicit thread keeps its history when the active page changes", async () => {
    const logs = memoryLog()
    const options = {
      settings: async () => ({ ...DEFAULT_SETTINGS, openRouterKey: "k" }),
      world,
      logs,
      forget: async () => {},
      forgetSite: async () => {},
      fetch: (async () => saying("Done.")) as unknown as typeof fetch,
      threadId: "thread-one"
    }
    const first = await realSession({ ...options, url: "https://x.test/products" })
    await first.send("Restyle the products")
    const second = await realSession({ ...options, url: "https://x.test/checkout" })

    expect(second.threadId).toBe("thread-one")
    expect(second.steps().map((step) => ("text" in step ? step.text : step.kind))).toEqual(["Restyle the products", "Done."])
  })

  test("reset empties the store and the view", async () => {
    const logs = memoryLog()
    const session = await open(async () => saying("Hi."), logs)
    await session.send("one")
    await session.reset()
    expect(session.steps()).toEqual([])
    expect(session.state()).toBe("idle")
    expect(await logs.load("https://x.test/page")).toEqual([])
  })

  test("clear drops the chat and leaves the page look", async () => {
    const logs = memoryLog()
    let forgot = 0
    const session = await realSession({
      url: "https://x.test/page",
      settings: async () => ({ ...DEFAULT_SETTINGS, openRouterKey: "k" }),
      world,
      logs,
      forget: async () => {
        forgot += 1
      },
      forgetSite: async () => {},
      fetch: (async () => saying("Hi.")) as unknown as typeof fetch
    })
    await session.send("one")
    await session.clear()
    expect(session.steps()).toEqual([])
    expect(forgot).toBe(0)
    expect(await logs.load("https://x.test/page")).toEqual([])
  })

  test("forgetPage and forgetSite call their own undos", async () => {
    let page = 0
    let site = 0
    const session = await realSession({
      url: "https://x.test/page",
      settings: async () => ({ ...DEFAULT_SETTINGS, openRouterKey: "k" }),
      world,
      logs: memoryLog(),
      forget: async () => {
        page += 1
      },
      forgetSite: async () => {
        site += 1
      },
      fetch: (async () => saying("Hi.")) as unknown as typeof fetch
    })
    await session.forgetPage()
    await session.forgetSite()
    expect(page).toBe(1)
    expect(site).toBe(1)
  })
})

describe("realSession as an external store", () => {
  test("steps() is the same array while nothing changed, and a new one after a change", async () => {
    const session = await open(async () => saying("Hi."))
    const before = session.steps()
    expect(session.steps()).toBe(before)
    await session.send("one")
    const after = session.steps()
    expect(after).not.toBe(before)
    expect(session.steps()).toBe(after)
  })

  test("turn() keeps one snapshot while repeated ticks change nothing", async () => {
    let push: ((chunk: string) => void) | undefined
    let close: (() => void) | undefined
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder()
        push = (chunk) => controller.enqueue(encoder.encode(chunk))
        close = () => controller.close()
      }
    })
    const session = await open(async () =>
      new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } })
    )
    let changes = 0
    session.subscribe(() => {
      changes += 1
    })
    const sending = session.send("hello")
    await until(() => changes >= 1 && session.state() === "working")
    const before = session.turn()
    await until(() => changes >= 3)

    expect(session.turn()).toBe(before)

    push?.(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { content: "Done." }, finish_reason: "stop" }] })}\n\n`)
    push?.("data: [DONE]\n\n")
    close?.()
    await sending
  })
})
