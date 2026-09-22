import { describe, expect, test } from "bun:test"
import { currentRevisionOf } from "./forks/model"
import type { ForkPreview } from "./forks/editor"
import type { PagePackagePreview } from "./preview"
import { fakeCapabilities, fakeForkDraft, fakeInstalledLibrary } from "./page-install.fake"
import { createPagePreviewState } from "./page-preview-state"

const location = {
  origin: "https://github.com",
  pathname: "/pulls"
}

const marketplacePreview = (id: string): PagePackagePreview => ({
  id,
  slug: "flazouh/focus",
  scope: { kind: "page", origin: location.origin, paths: [location.pathname] },
  js: `marketplace ${id}`,
  css: ".marketplace{}",
  capabilities: fakeCapabilities
})

const forkPreview = (draftId: string): ForkPreview => {
  const draft = fakeForkDraft({ id: draftId })
  return {
    tabId: 1,
    draftId,
    runtime: draft.runtime,
    parent: draft.parent,
    scope: draft.scope,
    revision: currentRevisionOf(draft)
  }
}

describe("page preview state", () => {
  test("settles a replaced sender in each preview channel", () => {
    const state = createPagePreviewState()
    const marketplaceAnswers: unknown[] = []
    const forkAnswers: unknown[] = []

    state.showMarketplace(marketplacePreview("market-1"), (answer) => {
      marketplaceAnswers.push(answer)
    })
    state.showMarketplace(marketplacePreview("market-2"), () => {})
    state.showFork(forkPreview("draft-1"), (answer) => {
      forkAnswers.push(answer)
    })
    state.showFork(forkPreview("draft-2"), () => {})

    expect(marketplaceAnswers).toEqual([
      {
        type: "marketplacePreviewError",
        message: "the marketplace preview was replaced"
      }
    ])
    expect(forkAnswers).toEqual([
      {
        type: "forkPreviewError",
        message: "the local Morph preview was replaced"
      }
    ])
  })

  test("settles marketplace and fork refreshes independently", () => {
    const state = createPagePreviewState()
    const marketplaceAnswers: unknown[] = []
    const forkAnswers: unknown[] = []

    state.clearMarketplace((answer) => marketplaceAnswers.push(answer))
    state.showFork(forkPreview("draft-1"), (answer) => forkAnswers.push(answer))
    state.refresh(
      {
        slug: "preview:still-mounted",
        mode: "temporary",
        js: "",
        css: "",
        capabilities: fakeCapabilities
      },
      true
    )

    expect(marketplaceAnswers).toEqual([])
    expect(forkAnswers).toEqual([
      {
        type: "forkPreviewError",
        message: "the local Morph draft does not match this page"
      }
    ])

    state.refresh(undefined, false)
    expect(marketplaceAnswers).toEqual([{ type: "marketplacePreviewStopped" }])
  })

  test("settles successful refreshes for both channels", () => {
    const state = createPagePreviewState()
    const marketplaceAnswers: unknown[] = []
    const forkAnswers: unknown[] = []

    state.showMarketplace(marketplacePreview("market-1"), (answer) => {
      marketplaceAnswers.push(answer)
    })
    state.refresh(
      {
        slug: "preview:market-1",
        mode: "temporary",
        js: "",
        css: "",
        capabilities: fakeCapabilities
      },
      true
    )
    state.showFork(forkPreview("draft-1"), (answer) => forkAnswers.push(answer))
    state.refresh(
      {
        slug: "local:draft-1",
        mode: "temporary",
        js: "",
        css: "",
        capabilities: fakeCapabilities
      },
      true
    )

    expect(marketplaceAnswers).toEqual([{ type: "marketplacePackagePreviewed" }])
    expect(forkAnswers).toEqual([{ type: "forkRevisionPreviewed" }])
  })

  test("cleans active previews and pending replies on navigation", async () => {
    const state = createPagePreviewState()
    const marketplaceAnswers: unknown[] = []
    const forkAnswers: unknown[] = []

    state.showMarketplace(marketplacePreview("market-1"), (answer) => {
      marketplaceAnswers.push(answer)
    })
    state.showFork(forkPreview("draft-1"), (answer) => forkAnswers.push(answer))
    state.navigate()

    expect(marketplaceAnswers).toEqual([
      {
        type: "marketplacePreviewError",
        message: "the marketplace preview stopped when the page changed"
      }
    ])
    expect(forkAnswers).toEqual([
      {
        type: "forkPreviewError",
        message: "the local Morph preview stopped when the page changed"
      }
    ])
    expect(
      await state.current(location, fakeInstalledLibrary(), {})
    ).toMatchObject({ slug: "flazouh/focus", mode: "installed" })
  })

  test("uses marketplace, explicit fork, saved fork, then installed order", async () => {
    const state = createPagePreviewState()
    const library = fakeInstalledLibrary()
    const drafts = { "saved-draft": fakeForkDraft({ id: "saved-draft" }) }

    expect(await state.current(location, library, drafts)).toMatchObject({
      slug: "local:saved-draft"
    })

    state.showFork(forkPreview("live-draft"), () => {})
    expect(await state.current(location, library, drafts)).toMatchObject({
      slug: "local:live-draft"
    })

    state.showMarketplace(marketplacePreview("market-1"), () => {})
    expect(await state.current(location, library, drafts)).toMatchObject({
      slug: "preview:market-1"
    })

    state.navigate()
    state.clearFork("saved-draft", () => {})
    expect(await state.current(location, library, drafts)).toMatchObject({
      slug: "flazouh/focus",
      mode: "installed"
    })
  })
})
