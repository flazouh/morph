import { describe, expect, test } from "bun:test"
import type { InstalledLibrary } from "../installer"
import { sandboxOn } from "./installed"

const capabilities = {
  takeover: {
    slot: '[data-testid="pulls-dashboard-surface-layout"]',
    fallback: 'react-app[app-name="dashboard-surface"]'
  },
  page: { read: [], navigate: ["https://github.com"], traverse: false },
  network: [],
  storage: true,
  context: { viewer: true, theme: true, route: true },
  assets: [],
  secureForms: []
} as const

const library = (paths: ReadonlyArray<string>): InstalledLibrary => ({
  active: {
    "flazouh/focus": {
      slug: "flazouh/focus",
      version: "1.0.0",
      installedAt: "2026-09-09T12:00:00.000Z",
      detail: {
        slug: "flazouh/focus",
        name: "Focus",
        summary: "Pull inbox",
        origin: "https://github.com",
        paths,
        version: "1.0.0",
        runtime: "sandbox-v1",
        license: "AGPL-3.0-or-later",
        installs: 0,
        stars: 0,
        updatedAt: "2026-09-09T12:00:00.000Z",
        author: { handle: "flazouh", displayName: "Alex", avatarUrl: null },
        manifest: {
          schema: 1,
          slug: "flazouh/focus",
          version: "1.0.0",
          summary: "Pull inbox",
          license: "AGPL-3.0-or-later",
          author: { handle: "flazouh" },
          scope: { kind: "page", origin: "https://github.com", paths },
          runtime: "sandbox-v1",
          entry: "entry.ts",
          files: { "entry.ts": "sha256:181fdd46f214709a8305029595836c65c6d2f5ff4a46b6c7269ccbf367099c9d" },
          compatibility: { kit: "^1.0.0", chrome: ">=135" },
          artifacts: {
            script: "sha256:7c81d724c975349a70227461ca767a0986f3843f3b95d6cf85ea81887f38c075",
            css: "sha256:9e94873f7504a4da7c134e840970618457481c0b89289a0f9da3d5979d2e5fbe"
          },
          previews: {
            before: "sha256:390ba68063fdc12a200b359589947cc5d6cf1b882b1c59e6b5b9a4dabb37fc69",
            after: "sha256:0d9f8bf1b4bb01a819b4426c305c949101355ce635be9a83ad3cc0b0ec4674f0"
          },
          permissions: { page: [], network: [] },
          capabilities
        },
        source: { repository: "flazouh/focus", commit: "abc", path: "dashboard", url: "https://github.test/focus" },
        files: {
          manifest: "https://raw.test/manifest.json",
          source: "https://github.test/source",
          before: "https://raw.test/before.webp",
          after: "https://raw.test/after.webp",
          css: "https://raw.test/style.css",
          script: "https://raw.test/script.js"
        }
      },
      records: [
        {
          id: "redesign:sandbox:https://github.com/pulls",
          matches: "https://github.com/pulls*",
          payload: { kind: "sandbox", js: "return require('effect').Effect.void", css: ":host{}", capabilities }
        }
      ]
    }
  },
  history: {}
})

describe("installed sandbox packages", () => {
  test("returns the sandbox install on a declared GitHub inbox path", () => {
    const found = sandboxOn(library(["/pulls", "/pulls/inbox"]), {
      origin: "https://github.com",
      pathname: "/pulls/inbox"
    })
    expect(found).toMatchObject({
      slug: "flazouh/focus",
      js: "return require('effect').Effect.void",
      capabilities
    })
  })

  test("returns nothing on another GitHub path", () => {
    expect(
      sandboxOn(library(["/pulls", "/pulls/inbox"]), {
        origin: "https://github.com",
        pathname: "/issues"
      })
    ).toBeUndefined()
  })
})
