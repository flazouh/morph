import { afterEach, describe, expect, test } from "bun:test"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { MarketplaceClient } from "../client"
import type { PackageDetail, PackageSummary } from "../api/http"
import { MarketplaceApp } from "./App"

const summary: PackageSummary = {
  slug: "alex/hn-quiet",
  name: "HN Quiet",
  summary: "A quieter Hacker News front page for focused reading.",
  origin: "https://news.ycombinator.com",
  paths: ["/"],
  version: "1.0.0",
  runtime: "declarative-v1",
  license: "MIT",
  installs: 0,
  stars: 0,
  updatedAt: "2026-09-08T21:19:52.189Z"
}

const detail: PackageDetail = {
  ...summary,
  author: { handle: "alex", displayName: "Alex", avatarUrl: null },
  manifest: {
    schema: 1,
    slug: summary.slug,
    version: summary.version,
    summary: summary.summary,
    license: summary.license,
    author: { handle: "alex" },
    scope: { kind: "page", origin: summary.origin, paths: ["/", "/news"] },
    runtime: summary.runtime,
    entry: "page.redesign.json",
    files: { "page.redesign.json": `sha256:${"a".repeat(64)}` },
    compatibility: { kit: "^1.0.0", chrome: ">=135" },
    artifacts: { view: `sha256:${"b".repeat(64)}`, css: `sha256:${"c".repeat(64)}` },
    previews: { before: `sha256:${"d".repeat(64)}`, after: `sha256:${"e".repeat(64)}` },
    permissions: { page: ["read:text"], network: [] }
  },
  source: {
    repository: "alex/hn-quiet",
    commit: "abc123",
    path: "packages/hn-quiet",
    url: "https://github.com/alex/hn-quiet"
  },
  files: {
    manifest: "https://cdn.test/manifest.json",
    source: "https://cdn.test/source.tar.gz",
    before: "https://cdn.test/before.webp",
    after: "https://cdn.test/after.webp",
    css: "https://cdn.test/skin.css",
    view: "https://cdn.test/view.json"
  }
}

const client = (overrides: Partial<MarketplaceClient> = {}): MarketplaceClient => ({
  list: async () => ({ items: [summary], nextCursor: null }),
  get: async () => detail,
  recordInstall: async () => {},
  report: async () => ({ id: "report-1" }),
  ...overrides
})

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

afterEach(() => {
  cleanup()
  window.history.replaceState({}, "", "/")
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined })
})

describe("marketplace web app", () => {
  test("loads the public catalog and opens package details", async () => {
    render(<MarketplaceApp client={client()} />)

    expect(screen.getByRole("heading", { name: "Find a better version of the sites you use." })).toBeTruthy()
    expect(await screen.findByRole("heading", { name: "HN Quiet" })).toBeTruthy()
    expect(screen.getByText("No installs yet")).toBeTruthy()
    expect(screen.getByRole("img", { name: "news.ycombinator.com favicon" }).getAttribute("src")).toBe(
      "https://news.ycombinator.com/favicon.ico"
    )

    fireEvent.click(screen.getByRole("button", { name: "View HN Quiet" }))

    expect(await screen.findByRole("heading", { name: "HN Quiet", level: 1 })).toBeTruthy()
    expect(screen.getAllByText("Runs on this page")).toHaveLength(3)
    expect(screen.getAllByText("https://news.ycombinator.com/, https://news.ycombinator.com/news")).toHaveLength(3)
    expect(screen.getAllByRole("link", { name: "View source" })[0]?.getAttribute("href")).toBe(detail.source.url)
    expect(screen.getAllByRole("button", { name: "Copy install request" })).toHaveLength(2)
  })

  test("falls back to the site initials when its favicon cannot load", async () => {
    render(<MarketplaceApp client={client()} />)

    const favicon = await screen.findByRole("img", { name: "news.ycombinator.com favicon" })
    fireEvent.error(favicon)

    expect(screen.queryByRole("img", { name: "news.ycombinator.com favicon" })).toBeNull()
    expect(screen.getByText("NE")).toBeTruthy()
  })

  test("searches by website and keeps errors actionable", async () => {
    const queries: unknown[] = []
    const marketplace = client({
      list: async (query) => {
        queries.push(query)
        if (queries.length > 1) throw new Error("offline")
        return { items: [summary], nextCursor: null }
      }
    })
    render(<MarketplaceApp client={marketplace} />)
    await screen.findByRole("heading", { name: "HN Quiet" })

    fireEvent.change(screen.getByLabelText("Website or search term"), { target: { value: "example.com" } })
    fireEvent.submit(screen.getByRole("search"))

    await waitFor(() => expect(queries).toHaveLength(2))
    expect(await screen.findByText("The marketplace could not load.")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy()
  })

  test("keeps the newest catalog response when requests finish out of order", async () => {
    const first = deferred<{ readonly items: ReadonlyArray<PackageSummary>; readonly nextCursor: null }>()
    const second = deferred<{ readonly items: ReadonlyArray<PackageSummary>; readonly nextCursor: null }>()
    let calls = 0
    const marketplace = client({
      list: () => (++calls === 1 ? first.promise : second.promise)
    })
    const newer = { ...summary, slug: "alex/newer", name: "Newer redesign" }
    render(<MarketplaceApp client={marketplace} />)

    fireEvent.change(screen.getByLabelText("Website or search term"), { target: { value: "newer" } })
    fireEvent.submit(screen.getByRole("search"))
    second.resolve({ items: [newer], nextCursor: null })
    expect(await screen.findByRole("heading", { name: "Newer redesign" })).toBeTruthy()

    first.resolve({ items: [summary], nextCursor: null })
    await Promise.resolve()
    expect(screen.queryByRole("heading", { name: "HN Quiet" })).toBeNull()
  })

  test("shows a manual recovery when clipboard access fails", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async () => Promise.reject(new Error("denied")) }
    })
    render(<MarketplaceApp client={client()} />)
    fireEvent.click(await screen.findByRole("button", { name: "View HN Quiet" }))
    const copyButtons = await screen.findAllByRole("button", { name: "Copy install request" })
    fireEvent.click(copyButtons[0]!)

    expect((await screen.findAllByRole("status"))[0]?.textContent).toContain("The install request could not copy.")
  })

  test("opens the publish approval screen with the extension device code", () => {
    render(<MarketplaceApp client={client()} />)

    fireEvent.click(screen.getByRole("button", { name: "publish" }))
    fireEvent.change(screen.getByLabelText("Device code"), {
      target: { value: "MORP-H123" }
    })
    expect((screen.getByLabelText("Device code") as HTMLInputElement).value).toBe("MORP-H123")
    const signIn = screen.getByRole("link", { name: "Continue with GitHub" })
    expect(signIn.getAttribute("href")).toBe(
      "/v1/auth/github?user_code=MORP-H123"
    )
    expect(screen.getByText(/does not grant access to the package repository/)).toBeTruthy()
  })
})
