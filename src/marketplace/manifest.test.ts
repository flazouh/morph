import { describe, expect, test } from "bun:test"
import { parseManifest } from "./manifest"

const validManifest = {
  schema: 1,
  slug: "alex/hn-quiet",
  version: "1.2.0",
  summary: "A calm Hacker News front page",
  license: "MIT",
  author: { handle: "alex" },
  scope: {
    kind: "page",
    origin: "https://news.ycombinator.com",
    paths: ["/", "/news"]
  },
  runtime: "declarative-v1",
  entry: "view.redesign.json",
  files: {
    "view.redesign.json": "sha256:181fdd46f214709a8305029595836c65c6d2f5ff4a46b6c7269ccbf367099c9d"
  },
  compatibility: {
    kit: "^1.0.0",
    chrome: ">=135"
  },
  artifacts: {
    view: "sha256:7c81d724c975349a70227461ca767a0986f3843f3b95d6cf85ea81887f38c075",
    css: "sha256:9e94873f7504a4da7c134e840970618457481c0b89289a0f9da3d5979d2e5fbe"
  },
  previews: {
    before: "sha256:390ba68063fdc12a200b359589947cc5d6cf1b882b1c59e6b5b9a4dabb37fc69",
    after: "sha256:0d9f8bf1b4bb01a819b4426c305c949101355ce635be9a83ad3cc0b0ec4674f0"
  },
  permissions: {
    page: ["read:text", "read:attributes", "navigate"],
    network: []
  }
} as const

describe("parseManifest", () => {
  test("accepts a safe declarative package", () => {
    expect(parseManifest(validManifest)).toEqual(validManifest)
  })

  test("rejects credentials, paths, and fragments in the origin", () => {
    expect(() =>
      parseManifest({
        ...validManifest,
        scope: { ...validManifest.scope, origin: "https://alex:secret@example.com/account#settings" }
      })
    ).toThrow("scope.origin must be an http or https origin")
  })

  test("requires script packages to declare only a script artifact", () => {
    expect(() =>
      parseManifest({
        ...validManifest,
        runtime: "script-v1",
        entry: "page.tsx",
        files: {
          "page.tsx": validManifest.files["view.redesign.json"]
        },
        artifacts: { css: validManifest.artifacts.css }
      })
    ).toThrow("script-v1 requires artifacts.script")

    expect(() =>
      parseManifest({
        ...validManifest,
        artifacts: { ...validManifest.artifacts, script: validManifest.artifacts.view }
      })
    ).toThrow("declarative-v1 cannot contain artifacts.script")
  })

  test("keeps executable source out of declarative packages", () => {
    expect(() =>
      parseManifest({
        ...validManifest,
        entry: "page.tsx",
        files: {
          "page.tsx": validManifest.files["view.redesign.json"]
        }
      })
    ).toThrow("declarative-v1 entry must end with .redesign.json")
  })

  test("requires hashed before-and-after previews", () => {
    const { previews: _, ...withoutPreviews } = validManifest
    expect(() => parseManifest(withoutPreviews)).toThrow("previews must be an object")
    expect(() =>
      parseManifest({
        ...validManifest,
        previews: { ...validManifest.previews, after: "after.webp" }
      })
    ).toThrow("previews.after must be a sha256 digest")
  })

  test("rejects sensitive and unknown page permissions", () => {
    expect(() =>
      parseManifest({
        ...validManifest,
        permissions: { ...validManifest.permissions, page: ["read:text", "read:forms"] }
      })
    ).toThrow('permissions.page contains unsupported permission "read:forms"')
  })

  test("accepts a sandbox package with capability grants and a script artifact", () => {
    const sandbox = {
      ...validManifest,
      runtime: "sandbox-v1" as const,
      entry: "entry.ts",
      files: {
        "entry.ts": validManifest.files["view.redesign.json"]
      },
      artifacts: {
        script: validManifest.artifacts.view,
        css: validManifest.artifacts.css
      },
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

    expect(parseManifest(sandbox)).toEqual(sandbox)
  })

  test("rejects a sandbox package without capability grants or a script artifact", () => {
    expect(() =>
      parseManifest({
        ...validManifest,
        runtime: "sandbox-v1",
        entry: "entry.ts",
        files: { "entry.ts": validManifest.files["view.redesign.json"] },
        artifacts: { css: validManifest.artifacts.css }
      })
    ).toThrow("sandbox-v1 requires artifacts.script")

    expect(() =>
      parseManifest({
        ...validManifest,
        runtime: "sandbox-v1",
        entry: "entry.ts",
        files: { "entry.ts": validManifest.files["view.redesign.json"] },
        artifacts: { script: validManifest.artifacts.view, css: validManifest.artifacts.css }
      })
    ).toThrow("sandbox-v1 requires capabilities")
  })

  test("rejects duplicate, relative, and wildcard scope paths", () => {
    for (const paths of [["/news", "/news"], ["news"], ["/*"]]) {
      expect(() =>
        parseManifest({
          ...validManifest,
          scope: { ...validManifest.scope, paths }
        })
      ).toThrow()
    }
  })
})
