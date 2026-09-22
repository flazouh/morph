import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { pageSourceId } from "../marketplace/compiler/page"
import type { PackageSource } from "../marketplace/compiler/source"
import type { ReleaseStatus } from "../marketplace/publishing/client"
import type { PageReleaseRequestMetadata } from "../marketplace/publishing/messages"
import type { AppliedPages } from "./applied"
import { memoryDesigns } from "./designs"
import { DEFAULT_LICENSE, pagePublishToolsFor } from "./page-publish-tools"
import { createQuestionController, PAGE_DRAFT_ID, type PublishAuthorization } from "./question"
import { MORPH_TOOL_NAMES } from "./tool-names"
import { SYSTEM, toolsFor } from "./tools"

const URL_ = "https://example.com/a"
const SITE = "https://example.com"

const PATH = "/a"
const applied: AppliedPages = { [PATH]: { css: "body{}", skin: { "page.tsx": "export default () => null" } } }
const design = { tokens: { "--primary": "red" } }

const release: ReleaseStatus = {
  id: "release-1",
  state: "completed",
  slug: "alex/page",
  version: "1.0.0",
  commit: "abc",
  receipt: "receipt-1",
  retryable: false,
  error: null
}

const harness = (current: AppliedPages = applied, designs = memoryDesigns({ [SITE]: design })) => {
  const published: Array<{
    readonly source: PackageSource
    readonly paths: ReadonlyArray<string>
    readonly submission: PageReleaseRequestMetadata
  }> = []
  const questions = createQuestionController()
  const tools = pagePublishToolsFor(
    {
      publisher: {
        publishPage: async (source, paths, submission) => {
          published.push({ source, paths, submission })
          return release
        }
      },
      applied: () => current
    },
    SITE,
    questions
  )
  const run = (name: string, input: unknown) => {
    const tool = tools.find((candidate) => candidate.spec.name === name)
    if (tool === undefined) throw new Error(`${name} missing`)
    return Effect.runPromise(Effect.provide(tool.run(input, { callId: "call" }), designs) as Effect.Effect<unknown>)
  }
  return { tools, questions, published, run }
}

const accept = async (
  questions: ReturnType<typeof createQuestionController>,
  callId: string,
  authorization: PublishAuthorization,
  selected = "publish"
): Promise<void> => {
  const pending = Effect.runPromise(
    questions.ask(
      {
        question: "Publish?",
        options: [{ id: "publish", label: "Publish" }, { id: "cancel", label: "Cancel" }],
        authorization
      },
      callId
    )
  )
  await Promise.resolve()
  expect(questions.answer(callId, [selected])).toBe(true)
  await pending
}

const releaseInput = { name: "Page", slug: "alex/page", summary: "A page", version: "1.0.0" }

describe("page publish tools", () => {
  test("a thread with a publisher and no fork gets the morph tools; a fork wins over the publisher", () => {
    const context = { publisher: { publishPage: async () => release }, applied: () => applied }
    const names = toolsFor({ url: URL_ }, { publish: context }).map((tool) => tool.spec.name)
    // The page's redesign is edited through write_skin, so only reading and publishing come along.
    expect(names.filter((name) => (MORPH_TOOL_NAMES as ReadonlyArray<string>).includes(name))).toEqual(["read_morph_source", "publish_morph"])
    expect(toolsFor({ url: URL_ }).map((tool) => tool.spec.name)).not.toContain("publish_morph")
    expect(SYSTEM(URL_, undefined, "", { kind: "page" })).toContain(`draftId "${PAGE_DRAFT_ID}"`)
    expect(SYSTEM(URL_, undefined)).not.toContain("publish_morph")
  })

  test("read_morph_source lists the page package with its revision id, then reads one file", async () => {
    const { run } = harness()
    const listing = (await run("read_morph_source", {})) as { revisionId: string; files: ReadonlyArray<string> }
    expect(listing).toMatchObject({ parent: null, draftId: PAGE_DRAFT_ID, entry: "page.tsx", license: DEFAULT_LICENSE })
    expect(listing.files).toEqual(["design.css", "page.tsx", "style.css"])
    expect(listing.revisionId).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(await run("read_morph_source", { path: "style.css" })).toEqual({ path: "style.css", content: "body{}" })
    expect(await run("read_morph_source", { path: "nope.ts" })).toEqual({ error: 'source file "nope.ts" does not exist' })
  })

  test("nothing applied is an error, not an empty package", async () => {
    const { run } = harness({})
    expect(await run("read_morph_source", {})).toEqual({ error: "nothing is applied on this page yet; redesign it before publishing" })
    expect(await run("publish_morph", { ...releaseInput, confirmationCallId: "x" })).toEqual({
      error: "nothing is applied on this page yet; redesign it before publishing"
    })
  })

  test("publish_morph needs the reader's confirmation of this exact source", async () => {
    const { run, questions, published } = harness()
    expect(await run("publish_morph", { ...releaseInput, confirmationCallId: "missing" })).toEqual({
      error: "the reader must confirm this exact release before publishing"
    })
    const revisionId = await pageSourceId({
      entry: "page.tsx",
      style: "style.css",
      files: {
        "style.css": "body{}",
        "design.css": ':root,\n:root[data-beui-theme="light"],\n:root[data-beui-theme="dark"] {\n  --primary: red;\n}\n',
        "page.tsx": "export default () => null"
      }
    })
    expect(((await run("read_morph_source", {})) as { revisionId: string }).revisionId).toBe(revisionId)
    // A confirmation of another revision, or of a fork draft, does not carry over.
    await accept(questions, "other", { action: "publish_morph", draftId: PAGE_DRAFT_ID, revisionId: "stale", ...releaseInput, addedPermissions: [] })
    expect(await run("publish_morph", { ...releaseInput, confirmationCallId: "other" })).toEqual({
      error: "the reader must confirm this exact release before publishing"
    })
    await accept(questions, "draft", { action: "publish_morph", draftId: "draft-1", revisionId, ...releaseInput, addedPermissions: [] })
    expect(await run("publish_morph", { ...releaseInput, confirmationCallId: "draft" })).toEqual({
      error: "the reader must confirm this exact release before publishing"
    })
    expect(published).toHaveLength(0)
  })

  test("publish_morph publishes the confirmed source once, with the default license", async () => {
    const { run, questions, published } = harness()
    const { revisionId } = (await run("read_morph_source", {})) as { revisionId: string }
    await accept(questions, "ok", { action: "publish_morph", draftId: PAGE_DRAFT_ID, revisionId, ...releaseInput, addedPermissions: [] })
    expect(await run("publish_morph", { ...releaseInput, confirmationCallId: "ok" })).toEqual({
      ok: true,
      releaseId: "release-1",
      status: "completed",
      slug: "alex/page",
      paths: [PATH],
      version: "1.0.0",
      commit: "abc",
      receipt: "receipt-1"
    })
    expect(published).toHaveLength(1)
    expect(published[0]?.source.entry).toBe("page.tsx")
    expect(published[0]?.submission).toEqual({ ...releaseInput, license: DEFAULT_LICENSE, approvePermissionWidening: false })
    // The evidence is spent: the same call id does not publish twice.
    expect(await run("publish_morph", { ...releaseInput, confirmationCallId: "ok" })).toEqual({
      error: "the reader must confirm this exact release before publishing"
    })
    expect(published).toHaveLength(1)
  })

  test("a thread that redesigned two pages publishes one package naming both paths", async () => {
    const two = {
      "/a": { skin: { "page.tsx": "export default () => null" } },
      "/b": { skin: { "page.tsx": "export default () => null" } }
    }
    const { run, questions, published } = harness(two)
    const listed = (await run("read_morph_source", {})) as { revisionId: string; paths: ReadonlyArray<string>; files: ReadonlyArray<string> }
    expect(listed.paths).toEqual(["/a", "/b"])
    expect(listed.files).toContain("pages/a/page.tsx")
    expect(listed.files).toContain("pages/b/page.tsx")
    await accept(questions, "ok", { action: "publish_morph", draftId: PAGE_DRAFT_ID, revisionId: listed.revisionId, ...releaseInput, addedPermissions: [] })
    await run("publish_morph", { ...releaseInput, confirmationCallId: "ok" })
    expect(published).toHaveLength(1)
    expect(published[0]?.paths).toEqual(["/a", "/b"])
  })

  test("what the thread applies after the listing changes the revision, so an old confirmation fails", async () => {
    let current: AppliedPages = applied
    const published: Array<PackageSource> = []
    const questions = createQuestionController()
    const tools = pagePublishToolsFor(
      { publisher: { publishPage: async (source) => (published.push(source), release) }, applied: () => current },
      SITE,
      questions
    )
    const run = (name: string, input: unknown) =>
      Effect.runPromise(Effect.provide(tools.find((t) => t.spec.name === name)!.run(input, { callId: "c" }), memoryDesigns()) as Effect.Effect<unknown>)
    const { revisionId } = (await run("read_morph_source", {})) as { revisionId: string }
    await accept(questions, "ok", { action: "publish_morph", draftId: PAGE_DRAFT_ID, revisionId, ...releaseInput, addedPermissions: [] })
    current = { [PATH]: { ...applied[PATH], css: "body{color:red}" } }
    expect(await run("publish_morph", { ...releaseInput, confirmationCallId: "ok" })).toEqual({
      error: "the reader must confirm this exact release before publishing"
    })
    expect(published).toHaveLength(0)
  })
})
