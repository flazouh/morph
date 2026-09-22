import { describe, expect, test } from "bun:test"
import { Effect, Option } from "effect"
import type { InstalledLibrary } from "../installer"
import { sandboxOn } from "./installed"
import { mountInstalledSandbox, watchInstalledSandboxes } from "./watch"

const capabilities = {
  takeover: {
    slot: '[data-testid="pulls-dashboard-surface-layout"]'
  },
  page: { read: [], navigate: ["https://github.com"], traverse: false },
  network: [],
  storage: false,
  context: { viewer: true, theme: true, route: true },
  assets: [],
  secureForms: []
} as const

const library = (): InstalledLibrary => ({
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
        paths: ["/pulls", "/pulls/inbox"],
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
          scope: { kind: "page", origin: "https://github.com", paths: ["/pulls", "/pulls/inbox"] },
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
          payload: { kind: "sandbox", js: "return require('effect').Effect.void", css: "", capabilities }
        }
      ]
    }
  },
  history: {}
})

const fetchPage = () => Effect.die("unused")

describe("installed sandbox watcher", () => {
  test("mounts a flow-sized frame in GitHub's dashboard slot", async () => {
    const slot = document.createElement("div")
    slot.setAttribute("data-testid", "pulls-dashboard-surface-layout")
    const native = document.createElement("section")
    native.textContent = "GitHub inbox"
    slot.append(native)
    document.body.append(slot)
    const location = { origin: "https://github.com", pathname: "/pulls/inbox" }

    expect(sandboxOn(library(), location)?.slug).toBe("flazouh/focus")

    const host = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const result = yield* mountInstalledSandbox({
            document,
            location,
            sandboxUrl: "about:blank",
            library: () => Effect.succeed(library()),
            fetchPage
          })
          expect(Option.isSome(result)).toBe(true)
          expect(slot.querySelector('[data-morph-sandbox="flazouh/focus"]')).not.toBeNull()
          expect(native.hidden).toBe(true)
          return Option.getOrThrow(result).host
        })
      )
    )

    expect(document.body.contains(host)).toBe(false)
    expect(native.hidden).toBe(false)
    slot.remove()
  })

  test("leaves GitHub alone when the package artifact is empty", async () => {
    const slot = document.createElement("div")
    slot.setAttribute("data-testid", "pulls-dashboard-surface-layout")
    const native = document.createElement("section")
    native.textContent = "GitHub inbox"
    slot.append(native)
    document.body.append(slot)
    const empty = library()
    const current = empty.active["flazouh/focus"]
    if (current === undefined) throw new Error("missing sandbox release")
    const blank: InstalledLibrary = {
      active: {
        "flazouh/focus": {
          ...current,
          records: current.records.map((record) => ({
            ...record,
            payload: { ...record.payload, js: "" }
          }))
        }
      },
      history: {}
    }

    const result = await Effect.runPromise(
      Effect.scoped(
        mountInstalledSandbox({
          document,
          location: { origin: "https://github.com", pathname: "/pulls/inbox" },
          sandboxUrl: "about:blank",
          library: () => Effect.succeed(blank),
          fetchPage
        })
      )
    )

    expect(Option.isNone(result)).toBe(true)
    expect(native.hidden).toBe(false)
    expect(slot.querySelector('[data-morph-sandbox="flazouh/focus"]')).toBeNull()
    slot.remove()
  })

  test("starts and stops with GitHub client-side navigation", async () => {
    const slot = document.createElement("div")
    slot.setAttribute("data-testid", "pulls-dashboard-surface-layout")
    document.body.append(slot)
    const location = { origin: "https://github.com", pathname: "/issues" }

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* watchInstalledSandboxes({
            document,
            location,
            sandboxUrl: "about:blank",
            library: () => Effect.succeed(library()),
            fetchPage
          })
          expect(document.querySelector('[data-morph-sandbox="flazouh/focus"]')).toBeNull()

          location.pathname = "/pulls/inbox"
          document.dispatchEvent(new Event("turbo:load"))
          yield* Effect.sleep(25)
          expect(document.querySelector('[data-morph-sandbox="flazouh/focus"]')).not.toBeNull()

          location.pathname = "/issues"
          document.dispatchEvent(new Event("turbo:load"))
          yield* Effect.sleep(25)
          expect(document.querySelector('[data-morph-sandbox="flazouh/focus"]')).toBeNull()
        })
      )
    )

    slot.remove()
  })

  test("restores GitHub's dashboard when the sandbox mount fails", async () => {
    const slot = document.createElement("div")
    slot.setAttribute("data-testid", "pulls-dashboard-surface-layout")
    const native = document.createElement("section")
    native.textContent = "GitHub inbox"
    slot.append(native)
    document.body.append(slot)
    const location = { origin: "https://github.com", pathname: "/pulls/inbox" }
    const append = slot.append.bind(slot)
    slot.append = () => {
      throw new Error("sandbox mount failed")
    }

    await expect(
      Effect.runPromise(
        Effect.scoped(
          mountInstalledSandbox({
            document,
            location,
            sandboxUrl: "about:blank",
            library: () => Effect.succeed(library()),
            fetchPage
          })
        )
      )
    ).rejects.toThrow("sandbox mount failed")

    expect(native.hidden).toBe(false)
    slot.append = append
    slot.remove()
  })
})
