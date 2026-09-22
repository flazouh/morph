import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import type { PageOutline } from "../bridge/messages"
import type { Design } from "./design"
import { memoryDesigns } from "./designs"
import { memoryWeb } from "./web"
import { Page, PageFailure } from "./page"
import { createRun, stepsOf } from "./run"
import { CompileFailure, Compiler } from "../skin/service"
import {
  CREW_TOOL_NAMES,
  MORPH_TOOL_NAMES,
  TOOL_NAMES
} from "./tool-names"

/**
 * The whole turn, with a scripted model: the harness in the browser bundle's exact
 * composition, driven by an OpenAI-compatible stream we control. What is proved: a
 * message becomes tool calls that reach our Page, their answers go back to the
 * model, the final text lands, and the log projects to the steps the panel draws.
 */

type Scripted =
  | { readonly text: string }
  | { readonly call: { readonly name: string; readonly args: unknown } }

const sse = (chunks: ReadonlyArray<unknown>): Response => {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n"
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } })
}

const chunk = (delta: unknown, finish: string | null) => ({
  id: "chatcmpl-x",
  object: "chat.completion.chunk",
  created: 1,
  model: "fake",
  choices: [{ index: 0, delta, finish_reason: finish }]
})

/** A model that answers each request with the next scripted move, and records what it was asked. */
const scriptedModel = (script: ReadonlyArray<Scripted>) => {
  const requests: Array<{ readonly tools: ReadonlyArray<string>; readonly messages: ReadonlyArray<{ role: string; content?: unknown; tool_calls?: unknown }> }> = []
  let n = 0
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { tools?: Array<{ function: { name: string } }>; messages: Array<{ role: string }> }
    requests.push({ tools: (body.tools ?? []).map((t) => t.function.name), messages: body.messages })
    const move = script[n]
    n += 1
    if (move === undefined) return sse([chunk({ role: "assistant", content: "I have nothing left to say." }, "stop"), { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }])
    if ("text" in move) {
      return sse([chunk({ role: "assistant", content: move.text }, null), chunk({}, "stop"), { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }])
    }
    return sse([
      chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${n}`, type: "function", function: { name: move.call.name, arguments: "" } }] }, null),
      chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(move.call.args) } }] }, null),
      chunk({}, "tool_calls"),
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }
    ])
  }) as typeof fetch
  return { requests, fetch: fetchImpl }
}

/** A page that remembers what was done to it, and a site that may already have a design. */
const fakeWorld = (
  designs: Record<string, Design> = {},
  read?: (selector: string | undefined) => Effect.Effect<PageOutline, PageFailure>
) => {
  const done: Array<string> = []
  const page = Layer.succeed(Page, {
    read: (selector) =>
      read?.(selector) ??
      Effect.sync(() => {
        done.push(`read ${selector ?? "body"}`)
        return { url: "https://github.com/acme/app/pulls", title: "Pulls", viewport: { width: 1200, height: 800 }, stylesheets: [], outline: 'body\n  main "Pull requests"', nodes: 2, truncated: false }
      }),
    styles: () => Effect.succeed([]),
    text: () => Effect.succeed([]),
    tokens: () => Effect.succeed({ theme: "light", tokens: { "--primary": "#171717" } }),
    style: (css, persist) => Effect.sync(() => {
      done.push(`style ${css} persist=${persist}`)
    }),
    design: (css, persist) => (css.includes("boom") ? Effect.fail(new PageFailure("chrome.userScripts is off", "userScriptsOff")) : Effect.sync(() => {
      done.push(`design ${css.replace(/\s+/g, " ").trim()} persist=${persist}`)
    })),
    run: (js) => (js.includes("throw") ? Effect.fail(new PageFailure("boom")) : Effect.sync(() => {
      done.push(`run ${js}`)
      return 42
    })),
    skin: (js) => Effect.sync(() => {
      done.push(`skin ${js}`)
    }),
    kit: () => Effect.sync(() => {
      done.push("kit")
    }),
    forget: () => Effect.void,
    forgetSite: () => Effect.void,
    look: () => Effect.sync(() => {
      done.push("look")
      return `data:image/jpeg;base64,${"A".repeat(20_000)}`
    })
  })
  // A compiler that stands in: a page saying "bad" fails to compile; any other becomes a marked body and one rule.
  const compiler = Layer.succeed(Compiler, {
    compile: (files) => {
      const page = files["page.tsx"] ?? ""
      return page.includes("bad") ? Effect.fail(new CompileFailure("page.tsx does not compile: (1:9)")) : Effect.succeed({ js: `/*compiled*/${page}`, css: ".p-4{padding:1rem}", icons: {} })
    }
  })
  const web: Record<string, string> = { "https://api.example.com/film/1": '{"rating":8.1}' }
  return { done, designs, world: Layer.mergeAll(page, memoryDesigns(designs), compiler, memoryWeb(web)) }
}

const runWith = (script: ReadonlyArray<Scripted>, design?: Design) => {
  const model = scriptedModel(script)
  const fake = fakeWorld(design === undefined ? {} : { "https://github.com": design })
  const run = createRun({
    url: "https://github.com/acme/app/pulls",
    model: { baseUrl: "https://fake.local/v1", apiKey: "k", model: "fake" },
    world: fake.world,
    design,
    seed: [],
    fetch: model.fetch
  })
  return { model, fake, run }
}

const until = async (ready: () => boolean, ms = 2_000): Promise<void> => {
  const started = Date.now()
  while (!ready()) {
    if (Date.now() - started > ms) throw new Error("timed out waiting for the run")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe("a turn through the harness", () => {
  test("read, restyle, answer: tools reach the page, and the log draws as steps", async () => {
    const { model, fake, run } = runWith([
      { call: { name: "read_page", args: { selector: "main" } } },
      { call: { name: "apply_styles", args: { css: ":root{--bg:#111}" } } },
      { text: "Applied a dark canvas." }
    ])
    await run.turn("make it dark")

    expect(fake.done).toEqual(["read main", "style :root{--bg:#111} persist=true"])
    expect(run.applied()).toEqual({ ["/acme/app/pulls"]: { css: ":root{--bg:#111}" } })

    const steps = stepsOf(run.log())
    expect(steps.map((s) => (s.kind === "tool" ? `tool:${s.name}` : s.kind))).toEqual(["user", "tool:read_page", "tool:apply_styles", "assistant"])
    const styled = steps.find((s) => s.kind === "tool" && s.name === "apply_styles")
    expect(styled?.kind === "tool" && styled.result).toMatchObject({ ok: true, applied: { css: ":root{--bg:#111}" } })
    expect(steps.at(-1)).toMatchObject({ kind: "assistant", text: "Applied a dark canvas." })

    // The model was offered our tools on every attempt, and saw the read's answer before choosing the restyle.
    const unavailable = new Set<string>([...CREW_TOOL_NAMES, ...MORPH_TOOL_NAMES])
    expect(model.requests[0]?.tools).toEqual(
      TOOL_NAMES.filter((name) => !unavailable.has(name))
    )
    expect(String(model.requests[0]?.messages[0]?.content)).toContain("__beui.mount(")
    const toolAnswers = model.requests[1]?.messages.filter((m) => m.role === "tool") ?? []
    expect(toolAnswers).toHaveLength(1)
    expect(String(toolAnswers[0]?.content)).toContain("Pull requests")
  })

  test("a tool that fails answers the model with an error and the turn goes on", async () => {
    const { model, fake, run } = runWith([{ call: { name: "run_script", args: { js: "throw 1" } } }, { text: "The script failed, trying CSS instead." }])
    await run.turn("restructure")
    expect(fake.done).toEqual([])
    const steps = stepsOf(run.log())
    const call = steps.find((s) => s.kind === "tool")
    expect(call?.kind === "tool" && call.result).toEqual({ error: "boom" })
    expect(steps.at(-1)?.kind).toBe("assistant")
    expect(steps.some((s) => s.kind === "error")).toBe(false)
  })

  test("ask_user pauses the turn until the reader chooses an option", async () => {
    const { run } = runWith([
      {
        call: {
          name: "ask_user",
          args: {
            title: "Choose a layout",
            description: "Pick the structure for the redesign.",
            asciiPreview: "[A] Grid\n[B] List",
            question: "Which layout should I use?",
            options: [
              { id: "grid", label: "Grid" },
              { id: "list", label: "List" }
            ]
          }
        }
      },
      { text: "I will use the grid layout." }
    ])

    const turn = run.turn("redesign this page")
    await until(() => stepsOf(run.log()).some((step) => step.kind === "tool" && step.name === "ask_user"))
    const question = stepsOf(run.log()).find((step) => step.kind === "tool" && step.name === "ask_user")
    expect(question?.kind === "tool" && question.result).toBeUndefined()

    expect(run.answerQuestion(question?.kind === "tool" ? question.callId : "", ["grid"])).toBe(true)
    await turn

    const answered = stepsOf(run.log()).find((step) => step.kind === "tool" && step.name === "ask_user")
    // The answer carries its own call id: publish_morph takes it as the confirmation.
    expect(answered?.kind === "tool" && answered.result).toEqual({
      callId: answered?.kind === "tool" ? answered.callId : "",
      selected: [{ id: "grid", label: "Grid" }]
    })
    expect(stepsOf(run.log()).at(-1)).toMatchObject({ kind: "assistant", text: "I will use the grid layout." })
  })

  test("stop cancels a pending ask_user call and settles the turn", async () => {
    const { run } = runWith([
      {
        call: {
          name: "ask_user",
          args: {
            question: "Which layout?",
            options: [
              { id: "grid", label: "Grid" },
              { id: "list", label: "List" }
            ]
          }
        }
      }
    ])

    const turn = run.turn("redesign this page")
    await until(() => stepsOf(run.log()).some((step) => step.kind === "tool" && step.name === "ask_user"))
    await run.stop()
    await turn

    const question = stepsOf(run.log()).find((step) => step.kind === "tool" && step.name === "ask_user")
    expect(question?.kind === "tool" && question.result).toEqual({ error: "question cancelled" })
  })

  test("write_skin: the kit loads, the compiled skin runs and persists, and the log keeps every file", async () => {
    const tsx = "import { Story } from './components/Story'\nexport default function Skin() { return <main className='p-4'><Story /></main> }"
    const story = "export const Story = () => <article />"
    const { fake, run } = runWith([
      { call: { name: "write_skin", args: { files: [{ path: "./page.tsx", content: tsx }, { path: "components/Story.tsx", content: story }] } } },
      { text: "Done." }
    ])
    await run.turn("rebuild it")
    expect(fake.done[0]).toStartWith("skin window.__beui.skin(function (require, exports, module) {\n/*compiled*/")
    expect(fake.done[0]).toEndWith(`}, ".p-4{padding:1rem}", {})`)
    expect(run.applied()).toEqual({ ["/acme/app/pulls"]: { skin: { "page.tsx": tsx, "components/Story.tsx": story } } })
  })

  test("fetch_url reads an address through the extension's web, not the page's, and hands the model the document", async () => {
    const { run } = runWith([{ call: { name: "fetch_url", args: { url: "https://api.example.com/film/1", accept: "json" } } }, { text: "8.1 on IMDb." }])
    await run.turn("what does the API say?")
    const call = stepsOf(run.log()).find((s) => s.kind === "tool")
    expect(call?.kind === "tool" && call.result).toEqual({
      url: "https://api.example.com/film/1",
      status: 200,
      contentType: "application/json",
      body: '{"rating":8.1}',
      truncated: false
    })
    expect(run.applied()).toEqual({})
  })

  test("fetch_url on a dead host answers the model with the failure, not a thrown run", async () => {
    const { run } = runWith([{ call: { name: "fetch_url", args: { url: "https://nowhere.example/" } } }, { text: "Unreachable." }])
    await run.turn("try it")
    const call = stepsOf(run.log()).find((s) => s.kind === "tool")
    expect(call?.kind === "tool" && call.result).toEqual({ error: "the request failed" })
  })

  test("a skin that does not compile answers the model with the compiler's message and touches nothing", async () => {
    const { fake, run } = runWith([{ call: { name: "write_skin", args: { files: [{ path: "page.tsx", content: "bad" }] } } }, { text: "Fixing the syntax." }])
    await run.turn("rebuild it")
    expect(fake.done).toEqual([])
    const call = stepsOf(run.log()).find((s) => s.kind === "tool")
    expect(call?.kind === "tool" && call.result).toEqual({ error: "page.tsx does not compile: (1:9)" })
    expect(run.applied()).toEqual({})
  })

  test("a persisted run_script after a skin keeps the skin: the two are separate slots", async () => {
    const { run } = runWith([
      { call: { name: "write_skin", args: { files: [{ path: "page.tsx", content: "export default () => null" }] } } },
      { call: { name: "run_script", args: { js: "1", persist: true } } },
      { text: "Done." }
    ])
    await run.turn("go")
    expect(run.applied()).toEqual({ ["/acme/app/pulls"]: { skin: { "page.tsx": "export default () => null" }, script: "1" } })
  })

  test("one turn can execute more than 24 tool calls", async () => {
    const probes = Array.from({ length: 30 }, () => ({ call: { name: "read_text", args: { selector: "p" } } }))
    const { run } = runWith([...probes, { text: "Finished probing." }])
    await run.turn("look around")
    const results = stepsOf(run.log()).flatMap((s) => (s.kind === "tool" ? [s.result] : []))
    expect(results).toHaveLength(30)
    expect(results.every((result) => Array.isArray(result))).toBe(true)
  })

  test("a second message while a turn runs is refused, and the running turn is unharmed", async () => {
    const { run } = runWith([{ text: "First." }])
    const first = run.turn("one")
    await expect(run.turn("two")).rejects.toThrow("a turn is already running")
    await first
    expect(stepsOf(run.log()).map((s) => s.kind)).toEqual(["user", "assistant"])
    // Once it rests, the next message goes through.
    const { run: fresh } = runWith([{ text: "A." }, { text: "B." }])
    await fresh.turn("a")
    await fresh.turn("b")
    expect(stepsOf(fresh.log()).map((s) => s.kind)).toEqual(["user", "assistant", "user", "assistant"])
  })

  test("stop aborts the active model request and settles the turn without an error", async () => {
    let markStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    let aborted = false
    let requests = 0
    const messages: Array<ReadonlyArray<{ role: string; content?: unknown }>> = []
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests += 1
      messages.push((JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content?: unknown }> }).messages)
      if (requests > 1) {
        return sse([chunk({ role: "assistant", content: "Next turn worked." }, "stop")])
      }
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
    }) as typeof fetch
    const fake = fakeWorld()
    const run = createRun({
      url: "https://github.com/acme/app/pulls",
      model: { baseUrl: "https://fake.local/v1", apiKey: "k", model: "fake" },
      world: fake.world,
      design: undefined,
      seed: [],
      fetch: fetchImpl
    })

    const turn = run.turn("stop this")
    await started
    await run.stop()
    await turn

    expect(aborted).toBe(true)
    expect(stepsOf(run.log()).map((step) => step.kind)).toEqual(["user"])

    await run.turn("continue")
    expect(stepsOf(run.log()).map((step) => step.kind)).toEqual(["user", "user", "assistant"])
    expect(messages[1]).toContainEqual({ role: "assistant", content: "Stopped by the reader." })
  })

  test("stop waits for an active page tool and records its result", async () => {
    let markToolStarted: (() => void) | undefined
    let finishTool: ((outline: PageOutline) => void) | undefined
    const toolStarted = new Promise<void>((resolve) => {
      markToolStarted = resolve
    })
    let reads = 0
    const model = scriptedModel([{ call: { name: "read_page", args: { selector: "main" } } }])
    const fake = fakeWorld({}, () => {
      reads += 1
      return Effect.promise(
        () =>
          new Promise<PageOutline>((resolve) => {
            finishTool = resolve
            markToolStarted?.()
          })
      )
    })
    const run = createRun({
      url: "https://github.com/acme/app/pulls",
      model: { baseUrl: "https://fake.local/v1", apiKey: "k", model: "fake" },
      world: fake.world,
      design: undefined,
      seed: [],
      fetch: model.fetch
    })

    const turn = run.turn("stop the tool")
    await toolStarted
    let stopped = false
    const stopping = run.stop().then(() => {
      stopped = true
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(stopped).toBe(false)
    finishTool?.({
      url: "https://github.com/acme/app/pulls",
      title: "Pulls",
      viewport: { width: 1200, height: 800 },
      stylesheets: [],
      outline: 'body\n  main "Pull requests"',
      nodes: 2,
      truncated: false
    })
    await stopping
    await turn

    expect(stopped).toBe(true)
    expect(stepsOf(run.log()).map((step) => step.kind)).toEqual(["user", "tool"])
    expect(stepsOf(run.log()).find((step) => step.kind === "tool")?.result).toMatchObject({ nodes: 2 })

    await run.turn("continue")
    expect(reads).toBe(1)
    expect(stepsOf(run.log()).map((step) => step.kind)).toEqual(["user", "tool", "user", "assistant"])
  })

  test("a second turn on the same run sees the first turn's history", async () => {
    const { model, run } = runWith([{ text: "First." }, { text: "Second." }])
    await run.turn("one")
    await run.turn("two")
    const kinds = stepsOf(run.log()).map((s) => `${s.kind}:${"text" in s ? s.text : ""}`)
    expect(kinds).toEqual(["user:one", "assistant:First.", "user:two", "assistant:Second."])
    const secondAsk = model.requests[1]?.messages.map((m) => m.role)
    expect(secondAsk).toEqual(["system", "user", "assistant", "user"])
  })
})

describe("the kit through the harness", () => {
  test("load_kit reaches the page and answers ok", async () => {
    const { fake, run } = runWith([{ call: { name: "load_kit", args: {} } }, { text: "Kit ready." }])
    await run.turn("use beui")
    expect(fake.done).toEqual(["kit"])
    const call = stepsOf(run.log()).find((s) => s.kind === "tool")
    expect(call?.kind === "tool" && call.result).toEqual({ ok: true })
  })
})

describe("the design through the harness", () => {
  test("look: the picture reaches the model as an image message and never enters the log; an older look is a line of text", async () => {
    const { model, fake, run } = runWith([
      { call: { name: "look", args: {} } },
      { call: { name: "look", args: {} } },
      { text: "The header overlaps the list; fixing." }
    ])
    await run.turn("check the layout")
    expect(fake.done).toEqual(["look", "look"])

    // The log holds the note, not the bytes: a reloaded panel keeps a small log.
    const results = stepsOf(run.log()).flatMap((s) => (s.kind === "tool" ? [s.result] : []))
    expect(results).toEqual([{ ok: true, image: "the screenshot follows as an image" }, { ok: true, image: "the screenshot follows as an image" }])
    expect(JSON.stringify(run.log()).length).toBeLessThan(5_000)

    // On the wire, the latest look is a picture after its tool message; the earlier one is a line.
    const third = model.requests[2]?.messages ?? []
    const roles = third.map((m) => m.role)
    expect(roles).toEqual(["system", "user", "assistant", "tool", "user", "assistant", "tool", "user"])
    expect(third[4]?.content).toBe("(an earlier screenshot, no longer shown; the latest one is below)")
    const picture = third[7]?.content as ReadonlyArray<{ type: string; image_url?: { url: string } }>
    expect(picture[1]?.type).toBe("image_url")
    expect(picture[1]?.image_url?.url).toStartWith("data:image/jpeg;base64,AAAA")
    // The first request had no look yet, so nothing was attached.
    expect(model.requests[0]?.messages.map((m) => m.role)).toEqual(["system", "user"])
  })

  test("write_design wears the tokens and stores them for the site; malformed input is refused", async () => {
    const { fake, run } = runWith([
      { call: { name: "write_design", args: { tokens: { primary: "oklch(0.6 0.2 250)", radius: "0.75rem" }, dark: { primary: "oklch(0.8 0.15 250)" } } } },
      { call: { name: "write_design", args: { tokens: { colour: "red" } } } },
      { text: "Done." }
    ])
    await run.turn("make it blue")
    expect(fake.done).toEqual([
      'design :root, :root[data-beui-theme="light"], :root[data-beui-theme="dark"] { --primary: oklch(0.6 0.2 250); --radius: 0.75rem; } :root[data-beui-theme="dark"] { --primary: oklch(0.8 0.15 250); } persist=true'
    ])
    const tools = stepsOf(run.log()).filter((s) => s.kind === "tool")
    expect(tools[1]?.kind === "tool" && tools[1].result).toEqual({ error: expect.stringContaining('tokens: "colour" is not a token; the tokens are background') })
    expect(fake.designs["https://github.com"]).toEqual({ tokens: { "--primary": "oklch(0.6 0.2 250)", "--radius": "0.75rem" }, dark: { "--primary": "oklch(0.8 0.15 250)" } })
  })

  test("a returning visit: the model is told the site's design", async () => {
    const design: Design = { tokens: { "--primary": "hotpink" } }
    const { model, run } = runWith([{ text: "Still pink." }], design)
    await run.turn("what do we have")
    expect(String(model.requests[0]?.messages[0]?.content)).toContain('This site\'s design, from an earlier visit (write_design replaces it whole): {"tokens":{"--primary":"hotpink"}}')
  })

  test("a design the page could not wear is not stored", async () => {
    const { fake, run } = runWith([{ call: { name: "write_design", args: { tokens: { primary: "boom" } } } }, { text: "Could not." }], { tokens: { "--primary": "hotpink" } })
    await run.turn("make it boom")
    expect(fake.designs["https://github.com"]).toEqual({ tokens: { "--primary": "hotpink" } })
    const call = stepsOf(run.log()).find((s) => s.kind === "tool")
    // The failure's code rides along with the prose, so the panel keys on the code.
    expect(call?.kind === "tool" && call.result).toEqual({ error: "chrome.userScripts is off", code: "userScriptsOff" })
  })

  test("an empty write_design returns the site to the kit defaults and forgets the stored design", async () => {
    const { fake, run } = runWith([{ call: { name: "write_design", args: { tokens: {} } } }, { text: "Back to defaults." }], { tokens: { "--primary": "hotpink" } })
    await run.turn("undo the pink")
    expect(fake.done).toEqual(["design  persist=true"])
    expect(fake.designs["https://github.com"]).toBeUndefined()
    const call = stepsOf(run.log()).find((s) => s.kind === "tool")
    expect(call?.kind === "tool" && call.result).toEqual({ ok: true, default: true })
  })
})
