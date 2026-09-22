import { describe, expect, test } from "bun:test"
import type { InstalledRelease } from "../installer"
import { digestOf } from "../compiler/digest"
import type { CompiledPackage } from "../compiler/compile"
import { loadForkParent } from "./source"

const capabilities = {
  page: { read: [], navigate: [], traverse: false },
  network: [],
  storage: false,
  context: { viewer: false, theme: true, route: false },
  assets: [],
  secureForms: []
} as const

const fixture = async () => {
  const files = {
    "entry.ts": 'import "./ui/style.css"\nexport const start = () => 1',
    "ui/style.css": ".quiet { color: black }"
  }
  const sources = Object.fromEntries(
    await Promise.all(
      Object.entries(files).map(async ([path, source]) => [path, await digestOf(source)])
    )
  )
  const compiled: CompiledPackage = {
    compiler: "test",
    script: "compiled",
    style: "compiled-css",
    sources,
    artifacts: {
      script: await digestOf("compiled"),
      css: await digestOf("compiled-css")
    }
  }
  const release = {
    slug: "alex/quiet",
    version: "1.0.0",
    installedAt: "2026-09-09T20:00:00.000Z",
    detail: {
      slug: "alex/quiet",
      name: "Quiet",
      summary: "A quiet page",
      origin: "https://example.com",
      paths: ["/inbox"],
      version: "1.0.0",
      runtime: "sandbox-v1",
      license: "MIT",
      installs: 1,
      stars: 0,
      updatedAt: "2026-09-09T20:00:00.000Z",
      author: { handle: "alex", displayName: "Alex", avatarUrl: null },
      manifest: {
        schema: 1,
        slug: "alex/quiet",
        version: "1.0.0",
        summary: "A quiet page",
        license: "MIT",
        author: { handle: "alex" },
        scope: { kind: "page", origin: "https://example.com", paths: ["/inbox"] },
        runtime: "sandbox-v1",
        entry: "entry.ts",
        files: sources,
        compatibility: { kit: "^1.0.0", chrome: ">=135" },
        artifacts: {
          script: compiled.artifacts.script,
          css: compiled.artifacts.css
        },
        previews: {
          before: await digestOf("before"),
          after: await digestOf("after")
        },
        permissions: { page: [], network: [] },
        capabilities
      },
      source: {
        repository: "flazouh/morph-packages",
        commit: "abc123",
        path: "packages/alex/quiet/1.0.0",
        url: "https://github.com/flazouh/morph-packages"
      },
      files: {
        manifest:
          "https://raw.githubusercontent.com/flazouh/morph-packages/abc123/packages/alex/quiet/1.0.0/manifest.json",
        source: "https://github.com/flazouh/morph-packages/tree/abc123/packages/alex/quiet/1.0.0/source",
        before: "https://example.com/before.webp",
        after: "https://example.com/after.webp",
        script: "https://example.com/script.js",
        css: "https://example.com/style.css"
      }
    },
    records: []
  } satisfies InstalledRelease
  return { files, compiled, release }
}

describe("loading a published Morph for local changes", () => {
  test("downloads each canonical source file, verifies it, and reproduces the release", async () => {
    const { files, compiled, release } = await fixture()
    const requested: string[] = []
    const parent = await loadForkParent(
      release,
      async (input) => {
        const url = String(input)
        requested.push(url)
        const path = decodeURIComponent(url.split("/source/")[1] ?? "")
        return new Response(files[path as keyof typeof files] ?? "", { status: 200 })
      },
      async () => compiled
    )

    expect(parent.source.style).toBe("ui/style.css")
    expect(parent.source.files).toEqual(files)
    expect(parent.commit).toBe("abc123")
    expect(requested.map((url) => new URL(url).pathname)).toEqual([
      expect.stringContaining("/source/entry.ts"),
      expect.stringContaining("/source/ui/style.css")
    ])
  })

  test("refuses changed source bytes and changed compiler output", async () => {
    const { files, compiled, release } = await fixture()
    await expect(
      loadForkParent(
        release,
        async (input) => {
          const path = decodeURIComponent(String(input).split("/source/")[1] ?? "")
          return new Response(
            path === "entry.ts" ? `${files["entry.ts"]}\nchanged` : files["ui/style.css"]
          )
        },
        async () => compiled
      )
    ).rejects.toThrow("source digest does not match for entry.ts")

    await expect(
      loadForkParent(
        release,
        async (input) => {
          const path = decodeURIComponent(String(input).split("/source/")[1] ?? "")
          return new Response(files[path as keyof typeof files] ?? "")
        },
        async () => ({ ...compiled, artifacts: { ...compiled.artifacts, script: "wrong" } })
      )
    ).rejects.toThrow("local compiler output does not match")
  })

  test("a page package is loaded too, with style.css as its stylesheet and no capabilities", async () => {
    const { compiled, release } = await fixture()
    const files = { "page.tsx": "export default () => null", "style.css": "body { margin: 0 }" }
    const sources = Object.fromEntries(
      await Promise.all(Object.entries(files).map(async ([path, text]) => [path, await digestOf(text)]))
    )
    const page: InstalledRelease = {
      ...release,
      detail: {
        ...release.detail,
        runtime: "script-v1",
        manifest: {
          ...release.detail.manifest,
          runtime: "script-v1",
          entry: "page.tsx",
          files: sources,
          capabilities: undefined
        }
      }
    }

    const parent = await loadForkParent(
      page,
      async (input) => {
        const path = decodeURIComponent(String(input).split("/source/")[1] ?? "")
        return new Response(files[path as keyof typeof files] ?? "", { status: 200 })
      },
      async () => ({ ...compiled, sources })
    )

    expect(parent.runtime).toBe("script-v1")
    // The page contract names its stylesheet; nothing is derived from an import.
    expect(parent.source.style).toBe("style.css")
    expect(parent.source.entry).toBe("page.tsx")
    expect(parent.capabilities).toBeUndefined()
  })

  test("a sandbox package that names no capabilities is refused, since its source claims nothing", async () => {
    const { compiled, release } = await fixture()
    const bare: InstalledRelease = {
      ...release,
      detail: { ...release.detail, manifest: { ...release.detail.manifest, capabilities: undefined } }
    }
    await expect(
      loadForkParent(bare, async () => new Response(""), async () => compiled)
    ).rejects.toThrow("names no capabilities")
  })

  test("refuses a source path that can leave the declared package folder", async () => {
    const { compiled, release } = await fixture()
    const traversing: InstalledRelease = {
      ...release,
      detail: {
        ...release.detail,
        source: {
          ...release.detail.source,
          path: "packages/alex/quiet/../other"
        }
      }
    }

    await expect(
      loadForkParent(
        traversing,
        async () => new Response(""),
        async () => compiled
      )
    ).rejects.toThrow("source path must be canonical")
  })
})
