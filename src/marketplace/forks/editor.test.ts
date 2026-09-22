import { describe, expect, test } from "bun:test"
import type { CompiledPackage } from "../compiler/compile"
import type { PackageSource } from "../compiler/source"
import type { SandboxCapabilities } from "../manifest"
import { forkEditor, type ForkPreview } from "./editor"
import { compactForkDraftStorage, forkDraftMemory } from "./memory"
import type { ForkDraftLibrary, ForkParent } from "./model"

const source = (value: string): PackageSource => ({
  entry: "entry.ts",
  style: "style.css",
  files: {
    "entry.ts": `export const start = () => ${JSON.stringify(value)}`,
    "style.css": ""
  }
})

const capabilities = (storage = false): SandboxCapabilities => ({
  page: { read: [], navigate: [], traverse: false },
  network: [],
  storage,
  context: { viewer: false, theme: true, route: false },
  assets: [],
  secureForms: []
})

const compiled = (value: string): CompiledPackage => ({
  compiler: "test",
  script: value,
  style: "",
  sources: {
    "entry.ts": `sha256:source-${value}`,
    "style.css": "sha256:source-style"
  },
  artifacts: { script: `sha256:script-${value}`, css: "sha256:artifact-style" }
})

const parent = (): ForkParent => ({
  slug: "alex/quiet",
  version: "1.2.0",
  commit: "abc123",
  runtime: "sandbox-v1",
  license: "MIT",
  compatibility: { kit: "^1.0.0", chrome: ">=120" },
  scope: { kind: "page", origin: "https://example.com", paths: ["/inbox"] },
  source: source("parent"),
  compiled: compiled("parent"),
  capabilities: capabilities()
})

const setup = () => {
  let stored: unknown
  let nextId = 0
  let tick = 0
  const previews: ForkPreview[] = []
  const memory = forkDraftMemory({
    read: async () => stored,
    write: async (library) => {
      stored = structuredClone(library)
    }
  })
  const editor = forkEditor(memory, {
    compile: async (input) => compiled(input.files[input.entry] ?? ""),
    preview: async (preview) => {
      previews.push(preview)
    },
    clearPreview: async () => {},
    id: () => `local-${++nextId}`,
    now: () => `2026-09-09T22:00:0${tick++}.000Z`
  })
  return {
    editor,
    memory,
    previews,
    stored: () => stored as ForkDraftLibrary | undefined
  }
}

describe("local Morph forks", () => {
  test("concurrent first changes create one anonymous draft for one immutable parent", async () => {
    const { editor } = setup()
    const [first, second] = await Promise.all([
      editor.ensure(parent()),
      editor.ensure(parent())
    ])

    expect(first.id).toBe(second.id)
    expect(first.parent).toEqual({
      slug: "alex/quiet",
      version: "1.2.0",
      commit: "abc123",
      license: "MIT",
      compatibility: { kit: "^1.0.0", chrome: ">=120" }
    })
    expect(first).not.toHaveProperty("slug")
    expect(first).not.toHaveProperty("author")
    expect(first.revisions[0]?.source).toEqual(source("parent"))
    expect(first.revisions[0]?.compiled.sources).toEqual(compiled("parent").sources)
  })

  test("a successful edit compiles, previews, records permission changes, and keeps exact history", async () => {
    const { editor, previews } = setup()
    const changed = source("changed")
    const draft = await editor.edit(parent(), changed, capabilities(true), 7)

    expect(previews).toHaveLength(1)
    expect(draft.revisions).toHaveLength(2)
    expect(draft.revisions[1]?.source).toEqual(changed)
    expect(draft.revisions[1]?.permissions).toEqual({
      added: ["storage"],
      removed: []
    })

    const restored = await editor.rollback(draft.id, draft.revisions[0]!.id, 7)
    expect(restored.currentRevision).toBe(draft.revisions[0]!.id)
    expect(restored.revisions).toEqual(draft.revisions)
    expect(previews[1]?.revision.compiled).toEqual(compiled("parent"))
  })

  test("an empty first edit creates no draft or revision", async () => {
    const { editor, previews } = setup()
    await expect(
      editor.edit(parent(), source("parent"), capabilities(), 7)
    ).rejects.toThrow("source did not change")

    expect(await editor.list()).toEqual([])
    expect(previews).toHaveLength(0)
  })

  test("a compile or preview failure keeps the last successful source and preview", async () => {
    let stored: unknown
    let failCompile = false
    let failPreview = false
    let visible = ""
    let nextId = 0
    const memory = forkDraftMemory({
      read: async () => stored,
      write: async (library) => {
        stored = structuredClone(library)
      }
    })
    const editor = forkEditor(memory, {
      compile: async (input) => {
        if (failCompile) throw new Error("compile failed")
        return compiled(input.files["entry.ts"] ?? "")
      },
      preview: async (preview) => {
        if (failPreview) throw new Error("sandbox failed")
        visible = preview.revision.compiled.script
      },
      clearPreview: async () => {
        visible = ""
      },
      id: () => `id-${++nextId}`,
      now: () => "2026-09-09T22:00:00.000Z"
    })
    const good = await editor.edit(parent(), source("good"), capabilities(), 7)
    const before = structuredClone(good)
    const visibleBefore = visible

    failCompile = true
    await expect(editor.edit(parent(), source("bad compile"), capabilities(), 7)).rejects.toThrow(
      "compile failed"
    )
    failCompile = false
    failPreview = true
    await expect(editor.edit(parent(), source("bad preview"), capabilities(), 7)).rejects.toThrow(
      "sandbox failed"
    )

    expect((await editor.list())[0]).toEqual(before)
    expect(visible).toBe(visibleBefore)
  })

  test("a failed first compile or preview leaves no parent-only draft", async () => {
    let stored: unknown
    let failPreview = false
    const memory = forkDraftMemory({
      read: async () => stored,
      write: async (library) => {
        stored = structuredClone(library)
      }
    })
    const editor = forkEditor(memory, {
      compile: async () => {
        throw new Error("compile failed")
      },
      preview: async () => {
        if (failPreview) throw new Error("sandbox failed")
      },
      clearPreview: async () => {},
      id: () => crypto.randomUUID(),
      now: () => "2026-09-09T22:00:00.000Z"
    })
    await expect(editor.edit(parent(), source("bad"), capabilities(), 7)).rejects.toThrow(
      "compile failed"
    )
    expect(await editor.list()).toEqual([])

    const previewEditor = forkEditor(memory, {
      compile: async () => compiled("candidate"),
      preview: async () => {
        failPreview = true
        throw new Error("sandbox failed")
      },
      clearPreview: async () => {},
      id: () => crypto.randomUUID(),
      now: () => "2026-09-09T22:00:00.000Z"
    })
    await expect(
      previewEditor.edit(parent(), source("bad preview"), capabilities(), 7)
    ).rejects.toThrow("sandbox failed")
    expect(failPreview).toBe(true)
    expect(await previewEditor.list()).toEqual([])
  })

  test("a failed first storage write clears the unpersisted preview", async () => {
    let cleared = false
    const memory = forkDraftMemory({
      read: async () => undefined,
      write: async () => {
        throw new Error("storage full")
      }
    })
    const editor = forkEditor(memory, {
      compile: async () => compiled("candidate"),
      preview: async () => {},
      clearPreview: async () => {
        cleared = true
      },
      id: () => crypto.randomUUID(),
      now: () => "2026-09-09T22:00:00.000Z"
    })

    await expect(
      editor.edit(parent(), source("candidate"), capabilities(), 7)
    ).rejects.toThrow("storage full")
    expect(cleared).toBe(true)
    expect(await editor.list()).toEqual([])
  })

  test("a failed rollback restores the saved revision in the preview", async () => {
    let stored: unknown
    let failWrite = false
    let visible = ""
    let nextId = 0
    const memory = forkDraftMemory({
      read: async () => stored,
      write: async (library) => {
        if (failWrite) throw new Error("storage full")
        stored = structuredClone(library)
      }
    })
    const editor = forkEditor(memory, {
      compile: async (input) => compiled(input.files["entry.ts"] ?? ""),
      preview: async (preview) => {
        visible = preview.revision.compiled.script
      },
      clearPreview: async () => {
        visible = ""
      },
      id: () => `id-${++nextId}`,
      now: () => "2026-09-09T22:00:00.000Z"
    })
    const draft = await editor.edit(parent(), source("saved"), capabilities(), 7)
    const saved = structuredClone(draft)
    const visibleBefore = visible

    failWrite = true
    await expect(
      editor.rollback(draft.id, draft.revisions[0]!.id, 7)
    ).rejects.toThrow("storage full")

    expect(visible).toBe(visibleBefore)
    expect((await editor.list())[0]).toEqual(saved)
  })

  test("a failed discard restores the saved draft preview", async () => {
    let stored: unknown
    let failWrite = false
    let visible = ""
    let nextId = 0
    const memory = forkDraftMemory({
      read: async () => stored,
      write: async (library) => {
        if (failWrite) throw new Error("storage full")
        stored = structuredClone(library)
      }
    })
    const editor = forkEditor(memory, {
      compile: async (input) => compiled(input.files["entry.ts"] ?? ""),
      preview: async (preview) => {
        visible = preview.revision.compiled.script
      },
      clearPreview: async () => {
        visible = ""
      },
      id: () => `id-${++nextId}`,
      now: () => "2026-09-09T22:00:00.000Z"
    })
    const draft = await editor.edit(parent(), source("saved"), capabilities(), 7)
    const saved = structuredClone(draft)
    const visibleBefore = visible

    failWrite = true
    await expect(editor.discard(draft.id, 7)).rejects.toThrow("storage full")

    expect(visible).toBe(visibleBefore)
    expect((await editor.list())[0]).toEqual(saved)
  })

  test("rename trims the display name, discard removes the draft, and malformed storage reads empty", async () => {
    const { editor, memory, stored } = setup()
    const draft = await editor.ensure(parent())
    const renamed = await editor.rename(draft.id, "  My quiet view  ")
    expect(renamed.name).toBe("My quiet view")

    await editor.discard(draft.id, 7)
    expect(await editor.list()).toEqual([])

    await memory.write({ drafts: { broken: {} as never } })
    expect(await memory.read()).toEqual({ drafts: {} })
    expect(stored()).toBeDefined()
  })

  test("browser storage deduplicates blobs and refuses writes above its total budget", async () => {
    let stored: unknown
    const shared = "x".repeat(10_000)
    const base = parent()
    const withShared: ForkParent = {
      ...base,
      source: {
        ...base.source,
        files: { ...base.source.files, "vendor/shared.ts": shared }
      },
      compiled: {
        ...base.compiled,
        sources: {
          ...base.compiled.sources,
          "vendor/shared.ts": "sha256:source-shared"
        }
      }
    }
    const compact = compactForkDraftStorage({
      read: async () => stored,
      write: async (value) => {
        stored = structuredClone(value)
      }
    })
    const memory = forkDraftMemory(compact)
    const editor = forkEditor(memory, {
      compile: async (input) => ({
        ...compiled(input.files["entry.ts"] ?? ""),
        sources: Object.fromEntries(
          Object.keys(input.files).map((path) => [
            path,
            path === "vendor/shared.ts"
              ? "sha256:source-shared"
              : `sha256:source-${path}-${input.files[path]?.length ?? 0}`
          ])
        )
      }),
      preview: async () => {},
      clearPreview: async () => {},
      id: () => crypto.randomUUID(),
      now: () => "2026-09-09T22:00:00.000Z"
    })
    const changedSource = {
      ...withShared.source,
      files: {
        ...withShared.source.files,
        "entry.ts": source("changed").files["entry.ts"]!
      }
    }
    const changed = await editor.edit(withShared, changedSource, capabilities(), 7)
    const raw = JSON.stringify(stored)
    const hydrated = JSON.stringify({ drafts: { [changed.id]: changed } })

    expect(raw.length).toBeLessThan(hydrated.length)
    expect(await memory.read()).toEqual({ drafts: { [changed.id]: changed } })

    const tiny = compactForkDraftStorage(
      { read: async () => undefined, write: async () => {} },
      10
    )
    await expect(tiny.write({ drafts: { [changed.id]: changed } })).rejects.toThrow(
      "10 byte storage budget"
    )
  })
  test("a page fork is still there when the library is read back", async () => {
    const { editor, memory } = setup()
    const page: ForkParent = {
      ...parent(),
      runtime: "script-v1",
      source: { entry: "page.tsx", style: "style.css", files: { "page.tsx": "a", "style.css": "b" } },
      capabilities: undefined
    }
    const draft = await editor.ensure(page)
    const read = (await memory.read()).drafts[draft.id]
    expect(read?.runtime).toBe("script-v1")
    expect(read?.revisions).toHaveLength(1)
  })
  test("a page fork keeps no capabilities, and asks for no permissions", async () => {
    const { editor } = setup()
    const page: ForkParent = {
      ...parent(),
      runtime: "script-v1",
      source: { entry: "page.tsx", style: "style.css", files: { "page.tsx": "a", "style.css": "b" } },
      capabilities: undefined
    }
    const draft = await editor.ensure(page)
    expect(draft.runtime).toBe("script-v1")
    expect(draft.parentCapabilities).toBeUndefined()
    const first = draft.revisions[0]
    expect(first?.capabilities).toBeUndefined()
    expect(first?.permissions).toEqual({ added: [], removed: [] })

    const edited = await editor.edit(
      page,
      { ...page.source, files: { "page.tsx": "changed", "style.css": "b" } },
      undefined,
      7
    )
    const revision = edited.revisions.at(-1)
    expect(revision?.capabilities).toBeUndefined()
    expect(revision?.permissions).toEqual({ added: [], removed: [] })
  })
})
