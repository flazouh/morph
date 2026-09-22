import { describe, expect, test } from "bun:test"
import type { Persisted } from "../bridge/persisted"
import type { PackageDetail } from "./api/http"
import { marketplaceInstaller, type InstalledLibrary } from "./installer"

const digest = async (value: string): Promise<string> => {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return `sha256:${[...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`
}

const detail = async (version: string, title: string): Promise<{ readonly detail: PackageDetail; readonly files: Readonly<Record<string, string>> }> => {
  const view = JSON.stringify({
    schema: 1,
    target: "#original",
    sources: [{ id: "page", selector: "body", many: true, fields: { title: { selector: "h1", read: "text" } } }],
    styles: { page: { display: "block" } },
    root: { tag: "main", className: "page", children: [{ tag: "h1", text: title }] }
  })
  const css = ""
  const viewUrl = `https://raw.test/${version}/view.json`
  const cssUrl = `https://raw.test/${version}/style.css`
  const manifest = {
    schema: 1 as const,
    slug: "alex/hn-quiet",
    version,
    summary: "A calm Hacker News front page",
    license: "MIT",
    author: { handle: "alex" },
    scope: { kind: "page" as const, origin: "https://news.ycombinator.com", paths: ["/"] },
    runtime: "declarative-v1" as const,
    entry: "view.redesign.json",
    files: { "view.redesign.json": await digest(view) },
    compatibility: { kit: "^1.0.0", chrome: ">=135" },
    artifacts: { view: await digest(view), css: await digest(css) },
    previews: {
      before: "sha256:390ba68063fdc12a200b359589947cc5d6cf1b882b1c59e6b5b9a4dabb37fc69",
      after: "sha256:0d9f8bf1b4bb01a819b4426c305c949101355ce635be9a83ad3cc0b0ec4674f0"
    },
    permissions: { page: ["read:text", "read:attributes", "navigate"] as const, network: [] as const }
  }
  return {
    detail: {
      slug: manifest.slug,
      name: "HN Quiet",
      summary: manifest.summary,
      origin: manifest.scope.origin,
      paths: manifest.scope.paths,
      version,
      runtime: manifest.runtime,
      license: manifest.license,
      installs: 0,
      stars: 0,
      updatedAt: "2026-09-08T20:00:00.000Z",
      author: { handle: "alex", displayName: "Alex", avatarUrl: null },
      manifest,
      source: { repository: "flazouh/redesign-marketplace", commit: version, path: version, url: `https://github.test/${version}` },
      files: {
        manifest: `https://raw.test/${version}/manifest.json`,
        source: `https://github.test/${version}/source`,
        before: `https://raw.test/${version}/before.webp`,
        after: `https://raw.test/${version}/after.webp`,
        css: cssUrl,
        view: viewUrl
      }
    },
    files: { [viewUrl]: view, [cssUrl]: css }
  }
}

const sandboxRelease = async (version: string, js: string, css: string) => {
  const scriptUrl = `https://raw.test/sandbox/${version}/script.js`
  const cssUrl = `https://raw.test/sandbox/${version}/style.css`
  const manifest = {
    schema: 1 as const,
    slug: "flazouh/focus",
    version,
    summary: "Focus dashboard",
    license: "AGPL-3.0-or-later",
    author: { handle: "flazouh" },
    scope: { kind: "page" as const, origin: "https://github.com", paths: ["/pulls", "/pulls/inbox"] },
    runtime: "sandbox-v1" as const,
    entry: "entry.ts",
    files: { "entry.ts": await digest(js) },
    compatibility: { kit: "^1.0.0", chrome: ">=135" },
    artifacts: { script: await digest(js), css: await digest(css) },
    previews: {
      before: "sha256:390ba68063fdc12a200b359589947cc5d6cf1b882b1c59e6b5b9a4dabb37fc69",
      after: "sha256:0d9f8bf1b4bb01a819b4426c305c949101355ce635be9a83ad3cc0b0ec4674f0"
    },
    permissions: { page: [] as const, network: [] as const },
    capabilities: {
      takeover: {
        slot: '[data-testid="pulls-dashboard-surface-layout"]',
        fallback: 'react-app[app-name="dashboard-surface"]'
      },
      page: { read: [], navigate: ["https://github.com"], traverse: false },
      network: [
        {
          origin: "https://github.com",
          paths: ["/pulls/inbox/queries"],
          methods: ["GET"] as const,
          credentials: "include" as const,
          headers: ["Accept", "X-Requested-With"] as const
        }
      ],
      storage: true,
      context: { viewer: true, theme: true, route: true },
      assets: [],
      secureForms: []
    }
  }
  return {
    detail: {
      slug: manifest.slug,
      name: "Focus",
      summary: manifest.summary,
      origin: manifest.scope.origin,
      paths: manifest.scope.paths,
      version: manifest.version,
      runtime: manifest.runtime,
      license: manifest.license,
      installs: 0,
      stars: 0,
      updatedAt: "2026-09-09T12:00:00.000Z",
      author: { handle: "flazouh", displayName: "Alex", avatarUrl: null },
      manifest,
      source: { repository: "flazouh/focus", commit: version, path: "dashboard", url: "https://github.test/focus" },
      files: {
        manifest: `https://raw.test/sandbox/${version}/manifest.json`,
        source: "https://github.test/focus/source",
        before: `https://raw.test/sandbox/${version}/before.webp`,
        after: `https://raw.test/sandbox/${version}/after.webp`,
        css: cssUrl,
        script: scriptUrl
      }
    } satisfies PackageDetail,
    files: { [scriptUrl]: js, [cssUrl]: css } as Record<string, string>
  }
}

describe("marketplace installer", () => {
  test("installs, updates, and rolls back a verified declarative package", async () => {
    const first = await detail("1.0.0", "First")
    const second = await detail("2.0.0", "Second")
    const files = { ...first.files, ...second.files }
    const swaps: Array<{ readonly remove: ReadonlyArray<string>; readonly records: ReadonlyArray<Persisted> }> = []
    let library: InstalledLibrary = { active: {}, history: {} }
    const installer = marketplaceInstaller({
      fetcher: async (input) => new Response(files[String(input)] ?? "missing", { status: String(input) in files ? 200 : 404 }),
      registrations: {
        replace: async (remove, records) => {
          swaps.push({ remove, records })
        }
      },
      memory: {
        read: async () => library,
        write: async (next) => {
          library = next
        }
      },
      now: () => "2026-09-08T20:00:00.000Z"
    })

    await installer.install(first.detail)
    await installer.install(second.detail)
    await installer.rollback(first.detail.slug)

    expect(library.active[first.detail.slug]?.version).toBe("1.0.0")
    expect(swaps).toHaveLength(3)
    expect(swaps[0]?.records[0]).toMatchObject({
      id: "redesign:declarative:https://news.ycombinator.com/",
      matches: "https://news.ycombinator.com/*",
      payload: { kind: "declarative" }
    })
    expect(swaps[2]?.records[0]?.payload).toMatchObject({
      kind: "declarative",
      view: { root: { children: [{ text: "First" }] } }
    })
  })

  test("installs a sandbox package into the library without a page script", async () => {
    const js = "return Effect.succeed(null)"
    const css = ":host{display:block}"
    const release = await sandboxRelease("1.0.0", js, css)
    const swaps: Array<{ readonly remove: ReadonlyArray<string>; readonly records: ReadonlyArray<Persisted> }> = []
    let library: InstalledLibrary = { active: {}, history: {} }
    const installer = marketplaceInstaller({
      fetcher: async (input) => new Response(release.files[String(input)] ?? "missing", { status: String(input) in release.files ? 200 : 404 }),
      registrations: {
        replace: async (remove, records) => {
          swaps.push({ remove, records })
        }
      },
      memory: {
        read: async () => library,
        write: async (next) => {
          library = next
        }
      },
      now: () => "2026-09-09T12:00:00.000Z"
    })

    await installer.install(release.detail)

    const installed = library.active[release.detail.slug]
    expect(installed?.records).toHaveLength(2)
    expect(installed?.records[0]).toMatchObject({
      id: "redesign:sandbox:https://github.com/pulls",
      payload: {
        kind: "sandbox",
        js,
        css,
        capabilities: release.detail.manifest.capabilities
      }
    })
    expect(swaps).toEqual([{ remove: [], records: [] }])
  })

  test("updates and rolls back a sandbox package in the library", async () => {
    const first = await sandboxRelease("1.0.0", "return Effect.succeed('first')", ":host{display:block}")
    const second = await sandboxRelease("2.0.0", "return Effect.succeed('second')", ":host{display:flex}")
    const files = { ...first.files, ...second.files }
    let library: InstalledLibrary = { active: {}, history: {} }
    const installer = marketplaceInstaller({
      fetcher: async (input) => new Response(files[String(input)] ?? "missing", { status: String(input) in files ? 200 : 404 }),
      registrations: { replace: async () => undefined },
      memory: {
        read: async () => library,
        write: async (next) => {
          library = next
        }
      },
      now: () => "2026-09-09T12:00:00.000Z"
    })

    await installer.install(first.detail)
    await installer.install(second.detail)
    expect(library.active[first.detail.slug]?.version).toBe("2.0.0")
    expect(library.active[first.detail.slug]?.records[0]?.payload).toMatchObject({
      kind: "sandbox",
      js: "return Effect.succeed('second')"
    })

    await installer.rollback(first.detail.slug)
    expect(library.active[first.detail.slug]?.version).toBe("1.0.0")
    expect(library.active[first.detail.slug]?.records[0]?.payload).toMatchObject({
      kind: "sandbox",
      js: "return Effect.succeed('first')"
    })
  })

  test("restores the previous sandbox library when memory write fails", async () => {
    const first = await sandboxRelease("1.0.0", "return Effect.succeed('first')", "")
    const second = await sandboxRelease("2.0.0", "return Effect.succeed('second')", "")
    const files = { ...first.files, ...second.files }
    let library: InstalledLibrary = { active: {}, history: {} }
    let writes = 0
    const installer = marketplaceInstaller({
      fetcher: async (input) => new Response(files[String(input)] ?? "missing", { status: String(input) in files ? 200 : 404 }),
      registrations: { replace: async () => undefined },
      memory: {
        read: async () => library,
        write: async (next) => {
          writes += 1
          if (writes === 2) throw new Error("memory write failed")
          library = next
        }
      },
      now: () => "2026-09-09T12:00:00.000Z"
    })

    await installer.install(first.detail)
    await expect(installer.install(second.detail)).rejects.toThrow("memory write failed")
    expect(library.active[first.detail.slug]?.version).toBe("1.0.0")
    expect(library.active[first.detail.slug]?.records[0]?.payload).toMatchObject({
      kind: "sandbox",
      js: "return Effect.succeed('first')"
    })
  })

  test("rejects a changed artifact before registrations or memory change", async () => {
    const release = await detail("1.0.0", "First")
    let swaps = 0
    let writes = 0
    const installer = marketplaceInstaller({
      fetcher: async (input) => new Response(String(input).endsWith("view.json") ? '{"changed":true}' : ""),
      registrations: {
        replace: async () => {
          swaps += 1
        }
      },
      memory: {
        read: async () => ({ active: {}, history: {} }),
        write: async () => {
          writes += 1
        }
      },
      now: () => "2026-09-08T20:00:00.000Z"
    })

    await expect(installer.install(release.detail)).rejects.toThrow("view artifact digest does not match")
    expect({ swaps, writes }).toEqual({ swaps: 0, writes: 0 })
  })
})
