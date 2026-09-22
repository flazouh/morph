/**
 * The two libraries a page reads before it runs a Morph: the installed releases and the
 * reader's own forks of them. Both shapes are large and both are checked by parsers, so
 * the tests share one builder instead of holding a copy each.
 */
import type { ForkDraft } from "./forks/model"
import type { InstalledLibrary } from "./installer"
import type { SandboxCapabilities } from "./manifest"

export const fakeCapabilities: SandboxCapabilities = {
  page: { read: [], navigate: [], traverse: false },
  network: [],
  storage: false,
  context: { viewer: false, theme: true, route: false },
  assets: [],
  secureForms: []
}

export interface FakeRelease {
  readonly slug?: string
  readonly version?: string
  readonly commit?: string
  readonly origin?: string
  readonly paths?: ReadonlyArray<string>
  readonly js?: string
}

export const fakeInstalledLibrary = (release: FakeRelease = {}): InstalledLibrary => {
  const slug = release.slug ?? "flazouh/focus"
  const version = release.version ?? "1.0.0"
  const commit = release.commit ?? "abc123"
  const origin = release.origin ?? "https://github.com"
  const paths = release.paths ?? ["/pulls"]
  const digest = "sha256:0000000000000000000000000000000000000000000000000000000000000000"
  return {
    active: {
      [slug]: {
        slug,
        version,
        installedAt: "2026-09-09T12:00:00.000Z",
        detail: {
          slug,
          name: "Focus",
          summary: "Pull inbox",
          origin,
          paths,
          version,
          runtime: "sandbox-v1",
          license: "AGPL-3.0-or-later",
          installs: 0,
          stars: 0,
          updatedAt: "2026-09-09T12:00:00.000Z",
          author: { handle: "flazouh", displayName: "Alex", avatarUrl: null },
          manifest: {
            schema: 1,
            slug,
            version,
            summary: "Pull inbox",
            license: "AGPL-3.0-or-later",
            author: { handle: "flazouh" },
            scope: { kind: "page", origin, paths },
            runtime: "sandbox-v1",
            entry: "entry.ts",
            files: { "entry.ts": digest },
            compatibility: { kit: "^1.0.0", chrome: ">=135" },
            artifacts: { script: digest, css: digest },
            previews: { before: digest, after: digest },
            permissions: { page: [], network: [] },
            capabilities: fakeCapabilities
          },
          source: {
            repository: slug,
            commit,
            path: "dashboard",
            url: "https://github.test/focus"
          },
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
            id: `redesign:sandbox:${origin}${paths[0] ?? "/"}`,
            matches: `${origin}${paths[0] ?? "/"}*`,
            payload: {
              kind: "sandbox",
              js: release.js ?? "installed release",
              css: ":host{}",
              capabilities: fakeCapabilities
            }
          }
        ]
      }
    },
    history: {}
  }
}

export interface FakeDraft extends FakeRelease {
  readonly id?: string
  readonly script?: string
}

export const fakeForkDraft = (draft: FakeDraft = {}): ForkDraft => {
  const digest = "sha256:1111111111111111111111111111111111111111111111111111111111111111"
  return {
    id: draft.id ?? "draft-1",
    parent: {
      slug: draft.slug ?? "flazouh/focus",
      version: draft.version ?? "1.0.0",
      commit: draft.commit ?? "abc123",
      license: "AGPL-3.0-or-later",
      compatibility: { kit: "^1.0.0", chrome: ">=135" }
    },
    runtime: "sandbox-v1",
  parentCapabilities: fakeCapabilities,
    scope: {
      kind: "page",
      origin: draft.origin ?? "https://github.com",
      paths: draft.paths ?? ["/pulls"]
    },
    revisions: [
      {
        id: "revision-1",
        createdAt: "2026-09-09T12:00:00.000Z",
        source: { entry: "entry.ts", style: "style.css", files: { "entry.ts": "", "style.css": "" } },
        compiled: {
          compiler: "test",
          script: draft.script ?? "draft script",
          style: ".draft{}",
          sources: { "entry.ts": digest, "style.css": digest },
          artifacts: { script: digest, css: digest }
        },
        capabilities: fakeCapabilities,
        permissions: { added: [], removed: [] }
      }
    ],
    currentRevision: "revision-1",
    createdAt: "2026-09-09T12:00:00.000Z",
    updatedAt: "2026-09-09T12:00:00.000Z"
  }
}
