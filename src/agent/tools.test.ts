import { describe, expect, test } from "bun:test"
import {
  CREW_TOOL_NAMES,
  MORPH_TOOL_NAMES,
  TOOL_NAMES
} from "./tool-names"
import { appliedFrom, SYSTEM, toolsFor } from "./tools"
import type { ForkToolContext } from "./tools"
import { Effect, Layer } from "effect"
import { createCrew, createCrewRuntime, createWork } from "./crew"
import { briefFor, roleOf } from "./crew/roles"
import type { World } from "./world"
import type { ForkDraft } from "../marketplace/forks/model"
import { Page } from "./page"
import { createQuestionController, questionOf } from "./question"
import type { Step } from "../session/contract"

const baseDraft = {
  id: "draft-1",
  parent: { slug: "alex/quiet", version: "1.0.0", commit: "abc123" },
  currentRevision: "revision-1",
  revisions: [
    {
      id: "revision-1",
      permissions: { added: [], removed: [] }
    }
  ]
} as unknown as ForkDraft

const fork = {
  parent: {
    slug: "alex/quiet",
    version: "1.0.0",
    commit: "abc123"
  },
  drafts: {
    list: async () => [baseDraft]
  },
  publisher: {
    publish: async () => {
      throw new Error("publisher must not run")
    }
  }
} as unknown as ForkToolContext

const acceptPublishQuestion = async (
  questions: ReturnType<typeof createQuestionController>,
  callId: string,
  addedPermissions: ReadonlyArray<string>,
  selected = "publish"
): Promise<void> => {
  const pending = Effect.runPromise(
    questions.ask(
      {
        question: "Publish this Morph?",
        description: "Review the release and permission changes.",
        options: [
          { id: "publish", label: "Publish" },
          { id: "cancel", label: "Cancel" }
        ],
        authorization: {
          action: "publish_morph",
          draftId: "draft-1",
          revisionId: "revision-1",
          name: "Quiet",
          slug: "alex/quiet-fork",
          summary: "Quiet fork",
          version: "1.0.0",
          addedPermissions
        }
      },
      callId
    )
  )
  await Promise.resolve()
  expect(questions.answer(callId, [selected])).toBe(true)
  await pending
}

describe("a publish confirmation a model wrote", () => {
  const fields = {
    action: "publish_morph",
    draftId: "7983e3e7",
    revisionId: "08d9ff5c",
    name: "Pink Hacker News",
    slug: "flazouh/pink-hn",
    summary: "Quiet Hacker News with hot pink story titles",
    version: "1.0.0",
    addedPermissions: []
  }
  const asked = (authorization: unknown) => ({
    question: "Publish Pink Hacker News as a new Morph package?",
    options: [
      { id: "publish", label: "Publish" },
      { id: "cancel", label: "Cancel" }
    ],
    authorization
  })

  test("the authorization is read whether the model wrote an object or a string of one", () => {
    const asObject = questionOf(asked(fields))
    const asString = questionOf(asked(JSON.stringify(fields)))
    expect(asObject).toEqual(asString)
    expect("authorization" in asObject ? asObject.authorization?.slug : undefined).toBe("flazouh/pink-hn")
  })

  test("a string that is not an authorization is still refused", () => {
    expect(questionOf(asked("publish it"))).toEqual({ error: "ask_user has an invalid publish authorization" })
    expect(questionOf(asked(JSON.stringify({ ...fields, version: "" })))).toEqual({
      error: "ask_user has an invalid publish authorization"
    })
  })
})

describe("a publish confirmation across turns", () => {
  const authorization = {
    action: "publish_morph" as const,
    draftId: "page",
    revisionId: "sha256:abc",
    name: "Quiet",
    slug: "flazouh/quiet",
    summary: "A calm page.",
    version: "1.0.0",
    addedPermissions: []
  }

  const accept = async (questions: ReturnType<typeof createQuestionController>) => {
    const asking = Effect.runPromise(
      questions.ask(
        { question: "Publish?", options: [{ id: "publish", label: "Publish" }, { id: "cancel", label: "Not now" }], authorization },
        "call-1"
      ) as Effect.Effect<unknown>
    )
    await Promise.resolve()
    expect(questions.answer("call-1", ["publish"])).toBe(true)
    await asking
  }

  test("the reader's yes outlives the turn it was given in, since the publish may land in the next one", async () => {
    const questions = createQuestionController()
    await accept(questions)
    // A Cursor tool call that times out is retried in a new turn: the yes must still stand.
    questions.beginTurn()
    expect(questions.authorizePublish("call-1", authorization)).toBe(true)
    // A publish that failed after the gate may try again on the same yes.
    expect(questions.authorizePublish("call-1", authorization)).toBe(true)
    // Once the release is out, the yes is spent and cannot publish a second one.
    questions.spendPublish("call-1")
    expect(questions.authorizePublish("call-1", authorization)).toBe(false)
  })

  test("stopping the thread takes the yes with it", async () => {
    const questions = createQuestionController()
    await accept(questions)
    questions.cancelAll()
    expect(questions.authorizePublish("call-1", authorization)).toBe(false)
  })

  test("a run ending does not, since the publish it authorized is retried in the next run", async () => {
    const questions = createQuestionController()
    await accept(questions)
    questions.cancelPending()
    expect(questions.authorizePublish("call-1", authorization)).toBe(true)
  })
})

describe("the ask_user contract", () => {
  const spec = () => {
    const tool = toolsFor({ url: "https://example.com/" }, { questions: createQuestionController() }).find((t) => t.spec.name === "ask_user")
    if (tool === undefined) throw new Error("ask_user missing")
    return tool
  }

  test("the authorization a model may send is the authorization the panel accepts", () => {
    const schema = spec().spec.inputSchema as {
      properties: { authorization: { properties: Record<string, unknown>; required: ReadonlyArray<string> } }
    }
    const authorization = schema.properties.authorization
    // publishAuthorizationOf refuses a card without these, so the schema must ask for them all.
    for (const field of ["action", "draftId", "revisionId", "name", "slug", "summary", "version", "addedPermissions"]) {
      expect(Object.keys(authorization.properties)).toContain(field)
      expect(authorization.required).toContain(field)
    }
  })

  test("an answered question tells the model which call was accepted, since publish_morph asks for it", async () => {
    const questions = createQuestionController()
    const tool = toolsFor({ url: "https://example.com/" }, { questions }).find((t) => t.spec.name === "ask_user")
    if (tool === undefined) throw new Error("ask_user missing")
    const asking = Effect.runPromise(
      tool.run({ question: "Publish?", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] }, { callId: "call-7" }) as Effect.Effect<unknown>
    )
    await Promise.resolve()
    expect(questions.answer("call-7", ["yes"])).toBe(true)
    expect(await asking).toEqual({ callId: "call-7", selected: [{ id: "yes", label: "Yes" }] })
  })
})

describe("appliedFrom", () => {
  const step = (name: string, result: unknown): Step => ({ kind: "tool", callId: "call-1", name, input: {}, result, at: 0 })
  const skinStep = (path: string | undefined, files: Record<string, string>): Step =>
    step("write_skin", { ok: true, applied: { ...(path === undefined ? {} : { path }), skin: files } })

  test("two skins on two paths are two pages, not one replacing the other", () => {
    const pages = appliedFrom(
      [skinStep("/", { "page.tsx": "home" }), skinStep("/login", { "page.tsx": "login" })],
      "/login"
    )
    expect(Object.keys(pages).sort()).toEqual(["/", "/login"])
    expect(pages["/"]?.skin).toEqual({ "page.tsx": "home" })
    expect(pages["/login"]?.skin).toEqual({ "page.tsx": "login" })
  })

  test("a later write on the same path replaces that page's slot", () => {
    const pages = appliedFrom([skinStep("/", { "page.tsx": "first" }), skinStep("/", { "page.tsx": "second" })], "/")
    expect(pages["/"]?.skin).toEqual({ "page.tsx": "second" })
  })

  test("slots on one path merge, so a stylesheet and a skin live together", () => {
    const styles = step("apply_styles", { ok: true, applied: { path: "/", css: "body{}" } })
    const pages = appliedFrom([styles, skinStep("/", { "page.tsx": "home" })], "/")
    expect(pages["/"]).toEqual({ css: "body{}", skin: { "page.tsx": "home" } })
  })

  test("a result recorded before paths reads as the page the thread is on", () => {
    const pages = appliedFrom([skinStep(undefined, { "page.tsx": "old" })], "/tiers")
    expect(pages).toEqual({ "/tiers": { skin: { "page.tsx": "old" } } })
  })

  test("a failed tool applies nothing", () => {
    const failed = step("write_skin", { error: "no" })
    expect(appliedFrom([failed], "/")).toEqual({})
  })
})

describe("the agent's tools", () => {
  test("publish confirmation shows the exact authorized release", () => {
    expect(
      questionOf({
        question: "Ignore this model text",
        options: [
          { id: "publish", label: "Publish" },
          { id: "cancel", label: "Cancel" }
        ],
        authorization: {
          action: "publish_morph",
          draftId: "draft-1",
          revisionId: "revision-1",
          name: "Quiet",
          slug: "alex/quiet-fork",
          summary: "Quiet fork",
          version: "1.0.0",
          addedPermissions: ["tabs", "storage"]
        }
      })
    ).toMatchObject({
      question:
        "Publish Quiet (alex/quiet-fork) version 1.0.0 from revision revision-1? Summary: Quiet fork Added permissions: tabs, storage."
    })
  })

  test("normal runs omit crew tools", () => {
    const names = toolsFor({ url: "https://example.com/" }).map((t) => t.spec.name)
    const unavailable = new Set<string>([...CREW_TOOL_NAMES, ...MORPH_TOOL_NAMES])
    expect(names).toEqual(TOOL_NAMES.filter((name) => !unavailable.has(name)))
    expect(names.slice(0, 2)).toEqual(["ask_user", "write_todos"])
  })

  test("crew runs include every shared tool name in order", () => {
    const crew = createCrew()
    crew.spawnAgent("root", null)
    const runtime = createCrewRuntime(crew, () => "child", async () => ({
      completion: new Promise<string>(() => {}),
      stop: async () => {}
    }))
    const names = toolsFor({ url: "https://example.com/" }, { crew: { agentId: "root", runtime, work: createWork(crew) } }).map((tool) => tool.spec.name)

    const morphTools = new Set<string>(MORPH_TOOL_NAMES)
    expect(names).toEqual(TOOL_NAMES.filter((name) => !morphTools.has(name)))
  })

  test("spawn_agent starts a separate crew bot and returns its id", async () => {
    const crew = createCrew()
    crew.spawnAgent("root", null)
    const runtime = createCrewRuntime(crew, () => "child", async () => ({
      completion: new Promise<string>(() => {}),
      stop: async () => {}
    }))
    const tools = toolsFor({ url: "https://example.com/" }, { crew: { agentId: "root", runtime, work: createWork(crew) } })
    const spawn = tools.find((tool) => tool.spec.name === "spawn_agent")
    if (spawn === undefined) throw new Error("spawn_agent missing")

    const result = await Effect.runPromise(
      Effect.provide(
        spawn.run({ brief: "Audit checkout", target: "#checkout" }, { callId: "call" }),
        Layer.empty as Layer.Layer<World>
      )
    )

    expect(result).toMatchObject({ id: "child", parentId: "root", target: "#checkout" })
    expect(crew.state().agents.get("child")?.status).toBe("working")
  })

  test("spawn_agent with a role hands the child the role's instructions ahead of the brief, and the tool lists the roles", async () => {
    const crew = createCrew()
    crew.spawnAgent("root", null)
    const started: Array<{ brief: string; title: string | undefined }> = []
    const runtime = createCrewRuntime(crew, () => "child", async (_child, _parent, brief, title) => {
      started.push({ brief, title })
      return { completion: new Promise<string>(() => {}), stop: async () => {} }
    })
    const tools = toolsFor({ url: "https://example.com/" }, { crew: { agentId: "root", runtime, work: createWork(crew) } })
    const spawn = tools.find((tool) => tool.spec.name === "spawn_agent")!
    expect(JSON.stringify(spawn.spec.inputSchema)).toContain('"region-designer"')

    const result = await Effect.runPromise(
      Effect.provide(spawn.run({ brief: "Report the nav links.", role: "page-reader" }, { callId: "call" }), Layer.empty as Layer.Layer<World>)
    )
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(result).toMatchObject({ id: "child", role: "page-reader" })
    expect(started).toEqual([{ brief: briefFor(roleOf("page-reader"), "Report the nav links."), title: "page-reader: Report the nav links." }])

    const unknown = await Effect.runPromise(
      Effect.provide(spawn.run({ brief: "x", role: "janitor" }, { callId: "call-2" }), Layer.empty as Layer.Layer<World>)
    )
    expect(unknown).toEqual({ error: "role must be one of region-designer, page-reader, reviewer" })
  })

  test("await_agents resolves from a completion notification without polling", async () => {
    const crew = createCrew()
    crew.spawnAgent("root", null)
    crew.spawnAgent("child", "root")
    const runtime = createCrewRuntime(crew, () => "message", async () => ({
      completion: Promise.resolve("unused"),
      stop: async () => {}
    }))
    const tools = toolsFor({ url: "https://example.com/" }, { crew: { agentId: "root", runtime, work: createWork(crew) } })
    const wait = tools.find((tool) => tool.spec.name === "await_agents")
    if (wait === undefined) throw new Error("await_agents missing")
    const waiting = Effect.runPromise(
      Effect.provide(wait.run({ agentIds: ["child"] }, { callId: "call" }), Layer.empty as Layer.Layer<World>)
    )
    crew.writeOutput("child", "Checkout is ready")
    crew.setStatus("child", "done")

    await expect(waiting).resolves.toEqual({ outputs: { child: "Checkout is ready" } })
  })

  test("concurrent crew styles compose from the latest serialized state", async () => {
    const crew = createCrew()
    crew.spawnAgent("a", null)
    crew.spawnAgent("b", null)
    const work = createWork(crew)
    work.claim("a", "css", ".a")
    work.claim("b", "css", ".b")
    const runtime = createCrewRuntime(crew, () => "child", async () => ({
      completion: Promise.resolve("unused"),
      stop: async () => {}
    }))
    const toolFor = (agentId: string) => {
      const tool = toolsFor({ url: "https://example.com/" }, { crew: { agentId, runtime, work } }).find((candidate) => candidate.spec.name === "apply_styles")
      if (tool === undefined) throw new Error("apply_styles missing")
      return tool
    }

    const pageWrites: string[] = []
    let startFirst!: () => void
    const firstStarted = new Promise<void>((resolve) => {
      startFirst = resolve
    })
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const page = Layer.succeed(Page, {
      read: () => Effect.die("unused"),
      styles: () => Effect.die("unused"),
      text: () => Effect.die("unused"),
      tokens: () => Effect.die("unused"),
      style: (css) =>
        Effect.tryPromise(async () => {
          pageWrites.push(css)
          if (pageWrites.length === 1) {
            startFirst()
            await firstGate
          }
        }),
      design: () => Effect.die("unused"),
      run: () => Effect.die("unused"),
      skin: () => Effect.die("unused"),
      kit: () => Effect.die("unused"),
      forget: () => Effect.die("unused"),
      forgetSite: () => Effect.die("unused"),
      look: () => Effect.die("unused")
    })

    const a = toolFor("a").run(
      { css: ".a { color: red; }", selector: ".a" },
      { callId: "a" }
    )
    const b = toolFor("b").run(
      { css: ".b { color: blue; }", selector: ".b" },
      { callId: "b" }
    )
    const run = (effect: typeof a) =>
      Effect.runPromise(Effect.provide(effect, page as Layer.Layer<World>))

    const bWrite = run(b)
    await firstStarted
    const aWrite = run(a)
    releaseFirst()
    await Promise.all([aWrite, bWrite])

    expect(pageWrites.at(-1)).toContain(".a { color: red; }")
    expect(pageWrites.at(-1)).toContain(".b { color: blue; }")
  })

  test("the system prompt makes the model write the plan first", () => {
    const prompt = SYSTEM("https://example.com/", undefined)
    expect(prompt.indexOf("write_todos")).toBeGreaterThan(-1)
    expect(prompt.indexOf("write_todos")).toBeLessThan(prompt.indexOf("read_page once"))
  })

  test("the system prompt resolves ambiguity before any page write", () => {
    const prompt = SYSTEM("https://example.com/", undefined)
    expect(prompt.indexOf("2. Clarify:")).toBeLessThan(prompt.indexOf("4. Design:"))
    expect(prompt.indexOf("2. Clarify:")).toBeLessThan(prompt.indexOf("5. Build:"))
  })

  test("normal system guidance omits crew instructions", () => {
    const prompt = SYSTEM("https://example.com/", undefined)

    expect(prompt).not.toContain("spawn focused bots")
    expect(prompt).not.toContain("claim_work")
    expect(prompt.match(/^\d+\./gm)).toEqual(["1.", "2.", "3.", "4.", "5.", "6.", "7.", "8.", "9."])
  })

  test("crew system guidance includes delegation and claim instructions", () => {
    const prompt = SYSTEM(
      "https://example.com/",
      undefined,
      "You are crew bot root. Use these IDs with send_agent."
    )

    expect(prompt).toContain("spawn focused bots")
    expect(prompt).toContain("claim_work")
    expect(prompt.match(/^\d+\./gm)).toEqual([
      "1.",
      "2.",
      "3.",
      "4.",
      "5.",
      "6.",
      "7.",
      "8.",
      "9.",
      "10.",
      "11."
    ])
  })

  test("the system prompt offers Paper Shaders for focused landing and sign-in backgrounds", () => {
    const prompt = SYSTEM("https://example.com/", undefined)
    expect(prompt).toContain("https://shaders.paper.design/")
    expect(prompt).toContain("MeshGradient")
    expect(prompt).toContain("landing")
    expect(prompt).toContain("sign-in")
    expect(prompt).toContain("prefers reduced motion")
  })

  test("an installed sandbox Morph adds local source tools without exposing a Fork action", () => {
    const names = toolsFor({ url: "https://example.com/" }, { fork: fork }).map((tool) => tool.spec.name)
    expect(names.slice(-6)).toEqual([
      "read_morph_source",
      "write_morph_source",
      "rollback_morph",
      "rename_morph_draft",
      "discard_morph_draft",
      "publish_morph"
    ])

    const prompt = SYSTEM("https://example.com/", undefined, "", { kind: "fork", parent: fork.parent })
    expect(prompt).toContain("A question or explanation is read-only")
    expect(prompt).toContain("first successful write creates a local draft automatically")
    expect(prompt).toContain("Do not ask the reader to fork or sign in")
    expect(prompt).toContain("Ask for GitHub sign-in only when they choose to publish")
  })

  test("publish_morph rejects unknown and non-publish answer evidence", async () => {
    const questions = createQuestionController()
    await acceptPublishQuestion(questions, "earlier-turn", [])
    questions.beginTurn()
    await acceptPublishQuestion(questions, "cancelled-release", [], "cancel")
    const publish = toolsFor({ url: "https://example.com/" }, { fork: fork, questions: questions }).find((tool) => tool.spec.name === "publish_morph")
    if (publish === undefined) throw new Error("publish_morph missing")

    const input = {
      draftId: "draft-1",
      name: "Quiet",
      slug: "alex/quiet-fork",
      summary: "Quiet fork",
      version: "1.0.0"
    }
    const run = (confirmationCallId: string) =>
      Effect.runPromise(
        Effect.provide(
          publish.run({ ...input, confirmationCallId }, { callId: "call" }),
          Layer.empty as Layer.Layer<World>
        )
      )

    await expect(run("unknown")).resolves.toEqual({
      error: "the reader must confirm this exact release before publishing"
    })
    await expect(run("cancelled-release")).resolves.toEqual({
      error: "the reader must confirm this exact release before publishing"
    })
    // A yes given in an earlier turn still stands: a timed-out tool call is retried in the
    // next turn, and the release it names has not changed. This fork's publisher refuses to
    // run, so reaching it at all is the proof that the confirmation was accepted.
    await expect(run("earlier-turn")).resolves.toEqual({ error: "publisher must not run" })
  })

  test("publish_morph rejects cancelled confirmation evidence", async () => {
    const questions = createQuestionController()
    const pending = Effect.runPromise(
      questions.ask(
        {
          question: "Publish this Morph?",
          options: [
            { id: "publish", label: "Publish" },
            { id: "cancel", label: "Cancel" }
          ],
          authorization: {
            action: "publish_morph",
            draftId: "draft-1",
            revisionId: "revision-1",
            name: "Quiet",
            slug: "alex/quiet-fork",
            summary: "Quiet fork",
            version: "1.0.0",
            addedPermissions: []
          }
        },
        "cancelled"
      )
    )
    await Promise.resolve()
    questions.cancelAll()
    await pending
    const publish = toolsFor({ url: "https://example.com/" }, { fork: fork, questions: questions }).find((tool) => tool.spec.name === "publish_morph")
    if (publish === undefined) throw new Error("publish_morph missing")

    const result = await Effect.runPromise(
      Effect.provide(
        publish.run(
          {
            draftId: "draft-1",
            name: "Quiet",
            slug: "alex/quiet-fork",
            summary: "Quiet fork",
            version: "1.0.0",
            confirmationCallId: "cancelled"
          },
          { callId: "call" }
        ),
        Layer.empty as Layer.Layer<World>
      )
    )

    expect(result).toEqual({
      error: "the reader must confirm this exact release before publishing"
    })
  })

  test("publish_morph requires confirmation of the exact added permissions", async () => {
    const draft = {
      id: "draft-1",
      parent: { slug: "alex/quiet", version: "1.0.0", commit: "abc123" },
      currentRevision: "revision-1",
      revisions: [
        {
          id: "revision-1",
          permissions: { added: ["storage"], removed: [] }
        }
      ]
    } as unknown as ForkDraft
    let publishCalls = 0
    const questions = createQuestionController()
    await acceptPublishQuestion(questions, "wrong-permissions", ["network:https://example.com"])
    const permissionFork = {
      ...fork,
      drafts: { ...fork.drafts, list: async () => [draft] },
      publisher: {
        publish: async () => {
          publishCalls += 1
          throw new Error("publisher must not run")
        }
      }
    } as unknown as ForkToolContext
    const publish = toolsFor({ url: "https://example.com/" }, { fork: permissionFork, questions: questions }).find((tool) => tool.spec.name === "publish_morph")
    if (publish === undefined) throw new Error("publish_morph missing")

    const result = await Effect.runPromise(
      Effect.provide(
        publish.run(
          {
            draftId: "draft-1",
            name: "Quiet",
            slug: "alex/quiet-fork",
            summary: "Quiet fork",
            version: "1.0.0",
            confirmationCallId: "wrong-permissions"
          },
          { callId: "call" }
        ),
        Layer.empty as Layer.Layer<World>
      )
    )

    expect(result).toEqual({
      error: "the reader must confirm this exact release before publishing"
    })
    expect(publishCalls).toBe(0)
  })

  test("publish_morph rejects confirmation for a replaced revision", async () => {
    const changedDraft = {
      ...baseDraft,
      currentRevision: "revision-2",
      revisions: [
        ...baseDraft.revisions,
        {
          id: "revision-2",
          permissions: { added: [], removed: [] }
        }
      ]
    } as unknown as ForkDraft
    const questions = createQuestionController()
    await acceptPublishQuestion(questions, "old-revision", [])
    let publishCalls = 0
    const changedFork = {
      ...fork,
      drafts: { ...fork.drafts, list: async () => [changedDraft] },
      publisher: {
        publish: async () => {
          publishCalls += 1
          throw new Error("publisher must not run")
        }
      }
    } as unknown as ForkToolContext
    const publish = toolsFor({ url: "https://example.com/" }, { fork: changedFork, questions: questions }).find((tool) => tool.spec.name === "publish_morph")
    if (publish === undefined) throw new Error("publish_morph missing")

    const result = await Effect.runPromise(
      Effect.provide(
        publish.run(
          {
            draftId: "draft-1",
            name: "Quiet",
            slug: "alex/quiet-fork",
            summary: "Quiet fork",
            version: "1.0.0",
            confirmationCallId: "old-revision"
          },
          { callId: "call" }
        ),
        Layer.empty as Layer.Layer<World>
      )
    )

    expect(result).toEqual({
      error: "the reader must confirm this exact release before publishing"
    })
    expect(publishCalls).toBe(0)
  })

  test("publish_morph uses accepted exact permission evidence", async () => {
    const draft = {
      id: "draft-1",
      parent: { slug: "alex/quiet", version: "1.0.0", commit: "abc123" },
      currentRevision: "revision-1",
      revisions: [
        {
          id: "revision-1",
          permissions: { added: ["storage"], removed: [] }
        }
      ]
    } as unknown as ForkDraft
    const questions = createQuestionController()
    await acceptPublishQuestion(questions, "publish-storage", ["storage"])
    let approval: boolean | undefined
    const permissionFork = {
      ...fork,
      drafts: { ...fork.drafts, list: async () => [draft] },
      publisher: {
        publish: async (
          _draftId: string,
          _revisionId: string,
          input: { approvePermissionWidening: boolean }
        ) => {
          approval = input.approvePermissionWidening
          return {
            id: "release-1",
            state: "completed",
            slug: "alex/quiet-fork",
            version: "1.0.0",
            commit: "def456",
            receipt: "receipt"
          }
        }
      }
    } as unknown as ForkToolContext
    const publish = toolsFor({ url: "https://example.com/" }, { fork: permissionFork, questions: questions }).find((tool) => tool.spec.name === "publish_morph")
    if (publish === undefined) throw new Error("publish_morph missing")

    const publishOnce = () =>
      Effect.runPromise(
        Effect.provide(
          publish.run(
            {
              draftId: "draft-1",
              name: "Quiet",
              slug: "alex/quiet-fork",
              summary: "Quiet fork",
              version: "1.0.0",
              confirmationCallId: "publish-storage"
            },
            { callId: "call" }
          ),
          Layer.empty as Layer.Layer<World>
        )
      )
    const result = await publishOnce()

    expect(result).toMatchObject({ ok: true, releaseId: "release-1" })
    expect(approval).toBe(true)
    await expect(publishOnce()).resolves.toEqual({
      error: "the reader must confirm this exact release before publishing"
    })
  })

  test("write_morph_source returns an error when content does not change", async () => {
    let editCalls = 0
    const noChangeFork = {
      ...fork,
      parent: {
        ...fork.parent,
        source: {
          entry: "index.ts",
          style: "styles.css",
          files: { "index.ts": "export {}", "styles.css": "" }
        },
        capabilities: {
          page: { read: [], navigate: [], traverse: false },
          network: [],
          storage: false,
          context: { viewer: false, theme: false, route: false },
          assets: [],
          secureForms: []
        }
      },
      drafts: {
        list: async () => [],
        edit: async () => {
          editCalls += 1
          throw new Error("edit must not run")
        }
      }
    } as unknown as ForkToolContext
    const write = toolsFor({ url: "https://example.com/" }, { fork: noChangeFork }).find((tool) => tool.spec.name === "write_morph_source")
    if (write === undefined) throw new Error("write_morph_source missing")

    const result = await Effect.runPromise(
      Effect.provide(
        write.run(
          { files: [{ path: "index.ts", content: "export {}" }] },
          { callId: "call" }
        ),
        Layer.empty as Layer.Layer<World>
      )
    )

    expect(result).toEqual({ error: "no source files changed" })
    expect(editCalls).toBe(0)
  })

  test("Morph source reads and writes reject non-canonical leading paths", async () => {
    let editCalls = 0
    const sourceFork = {
      ...fork,
      parent: {
        ...fork.parent,
        source: {
          entry: "index.ts",
          style: "styles.css",
          files: { "index.ts": "export {}", "styles.css": "" }
        },
        capabilities: {
          page: { read: [], navigate: [], traverse: false },
          network: [],
          storage: false,
          context: { viewer: false, theme: false, route: false },
          assets: [],
          secureForms: []
        }
      },
      drafts: {
        list: async () => [],
        edit: async () => {
          editCalls += 1
          throw new Error("edit must not run")
        }
      }
    } as unknown as ForkToolContext
    const morphTools = toolsFor({ url: "https://example.com/" }, { fork: sourceFork })
    const read = morphTools.find((tool) => tool.spec.name === "read_morph_source")
    const write = morphTools.find((tool) => tool.spec.name === "write_morph_source")
    if (read === undefined || write === undefined) throw new Error("Morph source tools missing")

    for (const path of ["/index.ts", "./index.ts"]) {
      const readResult = await Effect.runPromise(
        Effect.provide(
          read.run({ path }, { callId: `read-${path}` }),
          Layer.empty as Layer.Layer<World>
        )
      )
      const writeResult = await Effect.runPromise(
        Effect.provide(
          write.run(
            { files: [{ path, content: "export const changed = true" }] },
            { callId: `write-${path}` }
          ),
          Layer.empty as Layer.Layer<World>
        )
      )

      expect(readResult).toEqual({ error: `${JSON.stringify(path)} is not a package-relative path` })
      expect(writeResult).toEqual({ error: `${JSON.stringify(path)} is not a package-relative path` })
    }
    expect(editCalls).toBe(0)
  })
})
