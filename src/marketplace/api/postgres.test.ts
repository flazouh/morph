import { describe, expect, test } from "bun:test"
import { postgresMarketplace, publicFilesOf } from "./postgres"
import type { RedesignManifest } from "../manifest"

describe("public package files", () => {
  test("uses immutable GitHub commit URLs for a declarative package", () => {
    expect(
      publicFilesOf({
        owner: "flazouh",
        repository: "redesign-marketplace",
        commit: "0123456789abcdef0123456789abcdef01234567",
        path: "packages/alex/hn quiet/1.2.0",
        runtime: "declarative-v1"
      })
    ).toEqual({
      manifest:
        "https://raw.githubusercontent.com/flazouh/redesign-marketplace/0123456789abcdef0123456789abcdef01234567/packages/alex/hn%20quiet/1.2.0/manifest.json",
      source:
        "https://github.com/flazouh/redesign-marketplace/tree/0123456789abcdef0123456789abcdef01234567/packages/alex/hn%20quiet/1.2.0/source",
      before:
        "https://raw.githubusercontent.com/flazouh/redesign-marketplace/0123456789abcdef0123456789abcdef01234567/packages/alex/hn%20quiet/1.2.0/preview-before.webp",
      after:
        "https://raw.githubusercontent.com/flazouh/redesign-marketplace/0123456789abcdef0123456789abcdef01234567/packages/alex/hn%20quiet/1.2.0/preview-after.webp",
      css:
        "https://raw.githubusercontent.com/flazouh/redesign-marketplace/0123456789abcdef0123456789abcdef01234567/packages/alex/hn%20quiet/1.2.0/style.css",
      view:
        "https://raw.githubusercontent.com/flazouh/redesign-marketplace/0123456789abcdef0123456789abcdef01234567/packages/alex/hn%20quiet/1.2.0/view.json"
    })
  })

  test("exposes sandbox script output instead of a declarative view", () => {
    const files = publicFilesOf({
      owner: "flazouh",
      repository: "redesign-marketplace",
      commit: "0123456789abcdef0123456789abcdef01234567",
      path: "packages/flazouh/focus/1.0.0",
      runtime: "sandbox-v1"
    })

    expect(files.script).toEndWith("/script.js")
    expect(files.view).toBeUndefined()
  })

  test("exposes reviewed script output instead of a declarative view", () => {
    const files = publicFilesOf({
      owner: "flazouh",
      repository: "redesign-marketplace",
      commit: "0123456789abcdef0123456789abcdef01234567",
      path: "packages/alex/hn-quiet/1.2.0",
      runtime: "script-v1"
    })

    expect(files.script).toEndWith("/script.js")
    expect(files.view).toBeUndefined()
  })

  test("decodes a JSONB manifest returned as text by Bun SQL", async () => {
    const manifest: RedesignManifest = {
      schema: 1,
      slug: "alex/hn-quiet",
      version: "1.0.0",
      summary: "A calm Hacker News front page",
      license: "MIT",
      author: { handle: "alex" },
      scope: { kind: "page", origin: "https://news.ycombinator.com", paths: ["/"] },
      runtime: "declarative-v1",
      entry: "view.redesign.json",
      files: { "view.redesign.json": "sha256:181fdd46f214709a8305029595836c65c6d2f5ff4a46b6c7269ccbf367099c9d" },
      compatibility: { kit: "^1.0.0", chrome: ">=135" },
      artifacts: {
        view: "sha256:7c81d724c975349a70227461ca767a0986f3843f3b95d6cf85ea81887f38c075",
        css: "sha256:9e94873f7504a4da7c134e840970618457481c0b89289a0f9da3d5979d2e5fbe"
      },
      previews: {
        before: "sha256:390ba68063fdc12a200b359589947cc5d6cf1b882b1c59e6b5b9a4dabb37fc69",
        after: "sha256:0d9f8bf1b4bb01a819b4426c305c949101355ce635be9a83ad3cc0b0ec4674f0"
      },
      permissions: { page: ["read:text", "read:attributes", "navigate"], network: [] }
    }
    const sql = (() =>
      Promise.resolve([
        {
          id: 1,
          slug: manifest.slug,
          name: "HN Quiet",
          summary: manifest.summary,
          scope_origin: manifest.scope.origin,
          scope_paths: manifest.scope.paths,
          version: manifest.version,
          runtime: manifest.runtime,
          license: manifest.license,
          install_count: 0,
          star_count: 0,
          updated_at: "2026-09-08T20:00:00.000Z",
          author_handle: "alex",
          author_display_name: "Alex",
          author_avatar_url: null,
          manifest: JSON.stringify(manifest),
          github_owner: "flazouh",
          github_repo: "redesign-marketplace",
          github_commit: "0123456789abcdef0123456789abcdef01234567",
          github_path: "packages/alex/hn-quiet/1.0.0"
        }
      ])) as unknown as typeof Bun.sql

    expect((await postgresMarketplace(sql).get(manifest.slug))?.manifest).toEqual(manifest)
  })
})
