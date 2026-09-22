import { describe, expect, test } from "bun:test"
import type { PackageDetail } from "./api/http"
import type { MarketplaceClient } from "./client"
import {
  createExtensionForkDrafts,
  createExtensionMarketplace,
  MarketplaceCommandFailure
} from "./extension"
import type { InstalledLibrary, InstalledRelease } from "./installer"
import type { MarketplaceAsk } from "./messages"
import type { MarketplacePreviewAsk } from "./preview"

const detail: PackageDetail = {
  slug: "alex/hn-quiet",
  name: "HN Quiet",
  summary: "A calm Hacker News front page",
  origin: "https://news.ycombinator.com",
  paths: ["/"],
  version: "1.2.0",
  runtime: "declarative-v1",
  license: "MIT",
  installs: 42,
  stars: 7,
  updatedAt: "2026-09-08T20:00:00.000Z",
  author: { handle: "alex", displayName: "Alex", avatarUrl: null },
  manifest: {
    schema: 1,
    slug: "alex/hn-quiet",
    version: "1.2.0",
    summary: "A calm Hacker News front page",
    license: "MIT",
    author: { handle: "alex" },
    scope: { kind: "page", origin: "https://news.ycombinator.com", paths: ["/"] },
    runtime: "declarative-v1",
    entry: "view.redesign.json",
    files: {
      "view.redesign.json": "sha256:181fdd46f214709a8305029595836c65c6d2f5ff4a46b6c7269ccbf367099c9d"
    },
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
  },
  source: {
    repository: "flazouh/redesign-marketplace",
    commit: "0123456789abcdef0123456789abcdef01234567",
    path: "packages/alex/hn-quiet/1.2.0",
    url: "https://github.com/flazouh/redesign-marketplace/tree/version"
  },
  files: {
    manifest: "https://raw.githubusercontent.com/flazouh/redesign-marketplace/version/manifest.json",
    source: "https://github.com/flazouh/redesign-marketplace/tree/version/source",
    before: "https://raw.githubusercontent.com/flazouh/redesign-marketplace/version/preview-before.webp",
    after: "https://raw.githubusercontent.com/flazouh/redesign-marketplace/version/preview-after.webp",
    css: "https://raw.githubusercontent.com/flazouh/redesign-marketplace/version/style.css",
    view: "https://raw.githubusercontent.com/flazouh/redesign-marketplace/version/view.json"
  }
}

const release: InstalledRelease = {
  slug: detail.slug,
  version: detail.version,
  installedAt: "2026-09-08T20:05:00.000Z",
  detail,
  records: []
}

const library: InstalledLibrary = {
  active: { [detail.slug]: release },
  history: {}
}

describe("extension marketplace", () => {
  test("installs a catalog package before it records the public install", async () => {
    const events: string[] = []
    const asks: Array<MarketplaceAsk | MarketplacePreviewAsk> = []
    const client = {
      get: async (slug: string) => {
        events.push(`get:${slug}`)
        return detail
      },
      recordInstall: async (slug: string) => {
        events.push(`count:${slug}`)
      }
    } satisfies Pick<MarketplaceClient, "get" | "recordInstall">
    const marketplace = createExtensionMarketplace(client, async (ask) => {
      asks.push(ask)
      events.push(`send:${ask.type}`)
      return { type: "packageInstalled", release }
    })

    expect(await marketplace.install(detail.slug)).toEqual(release)
    expect(asks).toEqual([{ type: "installPackage", detail }])
    expect(events).toEqual(["get:alex/hn-quiet", "send:installPackage", "count:alex/hn-quiet"])
  })

  test("lists, rolls back, and removes installed packages", async () => {
    const asks: Array<MarketplaceAsk | MarketplacePreviewAsk> = []
    const marketplace = createExtensionMarketplace(
      {
        get: async () => detail,
        recordInstall: async () => {}
      },
      async (ask) => {
        asks.push(ask)
        if (ask.type === "listInstalledPackages") return { type: "installedPackages", library }
        if (ask.type === "rollbackPackage") return { type: "packageRolledBack", release }
        return { type: "packageRemoved", slug: detail.slug }
      }
    )

    expect(await marketplace.list()).toEqual(library)
    expect(await marketplace.rollback(detail.slug)).toEqual(release)
    await expect(marketplace.remove(detail.slug)).resolves.toBeUndefined()
    expect(asks).toEqual([
      { type: "listInstalledPackages" },
      { type: "rollbackPackage", slug: detail.slug },
      { type: "removePackage", slug: detail.slug }
    ])
  })

  test("rejects background errors and malformed answers", async () => {
    const failed = createExtensionMarketplace(
      { get: async () => detail, recordInstall: async () => {} },
      async () => ({ type: "marketplaceError", message: "artifact digest mismatch" })
    )
    const malformed = createExtensionMarketplace(
      { get: async () => detail, recordInstall: async () => {} },
      async () => ({ type: "packageInstalled" })
    )

    await expect(failed.install(detail.slug)).rejects.toEqual(
      new MarketplaceCommandFailure("artifact digest mismatch")
    )
    await expect(malformed.install(detail.slug)).rejects.toEqual(
      new MarketplaceCommandFailure("The extension returned an invalid marketplace response.")
    )

    const nestedMalformed = createExtensionMarketplace(
      { get: async () => detail, recordInstall: async () => {} },
      async () => ({
        type: "packageInstalled",
        release: { ...release, detail: {} }
      })
    )
    await expect(nestedMalformed.install(detail.slug)).rejects.toEqual(
      new MarketplaceCommandFailure("The extension returned an invalid marketplace response.")
    )

    const drafts = createExtensionForkDrafts(
      async () => ({
        type: "forkDrafts",
        drafts: [{ id: "draft-1", parent: {}, revisions: [] }]
      }),
      1
    )
    await expect(drafts.list()).rejects.toEqual(
      new MarketplaceCommandFailure("The extension returned an invalid marketplace response.")
    )
  })

  test("keeps a successful install when the public counter is unavailable", async () => {
    const marketplace = createExtensionMarketplace(
      {
        get: async () => detail,
        recordInstall: async () => {
          throw new Error("network unavailable")
        }
      },
      async () => ({ type: "packageInstalled", release })
    )

    await expect(marketplace.install(detail.slug)).resolves.toEqual(release)
  })

  test("previews and stops without installing the package", async () => {
    const asks: Array<MarketplaceAsk | MarketplacePreviewAsk> = []
    const marketplace = createExtensionMarketplace(
      {
        get: async () => detail,
        recordInstall: async () => {}
      },
      async (ask) => {
        asks.push(ask)
        return ask.type === "previewMarketplacePackage"
          ? { type: "marketplacePackagePreviewed", slug: ask.detail.slug }
          : { type: "marketplacePreviewStopped" }
      }
    )

    await marketplace.preview(detail.slug)
    await marketplace.stopPreview()
    expect(asks).toEqual([
      { type: "previewMarketplacePackage", detail },
      { type: "stopMarketplacePreview" }
    ])
  })
})
