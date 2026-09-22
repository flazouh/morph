import { afterEach, expect, mock, test } from "bun:test"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ExtensionMarketplace } from "@/marketplace/extension"
import type { PackageMatch } from "@/marketplace/discovery"
import { MarketplaceMatches } from "./MarketplaceMatches"

afterEach(cleanup)

const match: PackageMatch = {
  package: {
    slug: "alex/quiet",
    name: "Quiet",
    summary: "A calmer page",
    origin: "https://example.com",
    paths: ["/inbox"],
    version: "1.0.0",
    runtime: "sandbox-v1",
    license: "MIT",
    installs: 4,
    stars: 2,
    updatedAt: "2026-09-09T20:00:00.000Z"
  },
  reason: "Matches /inbox",
  installed: false
}

test("previews, restores, installs, and opens a Morph in chat", async () => {
  const preview = mock(async () => {})
  const stopPreview = mock(async () => {})
  const install = mock(async () => ({}) as never)
  const modify = mock(() => {})
  const marketplace = {
    list: async () => ({ active: {}, history: {} }),
    preview,
    stopPreview,
    install
  } as unknown as ExtensionMarketplace

  render(
    <MarketplaceMatches
      url="https://example.com/inbox?private=yes"
      marketplace={marketplace}
      findMatches={async () => [match]}
      onModify={modify}
    />
  )

  expect(await screen.findByText("1 Morph for this page")).toBeTruthy()
  expect(screen.getByText("Matches /inbox")).toBeTruthy()
  stopPreview.mockClear()

  fireEvent.click(screen.getByRole("button", { name: "Preview" }))
  await waitFor(() => expect(preview).toHaveBeenCalledWith("alex/quiet"))
  fireEvent.click(await screen.findByRole("button", { name: "Restore" }))
  await waitFor(() => expect(stopPreview).toHaveBeenCalledTimes(1))

  fireEvent.click(screen.getByRole("button", { name: "Install" }))
  await waitFor(() => expect(install).toHaveBeenCalledWith("alex/quiet"))
  fireEvent.click(await screen.findByRole("button", { name: "Modify" }))
  await waitFor(() => expect(modify).toHaveBeenCalledWith("Quiet"))
})

test("stops an active preview when the chat panel closes", async () => {
  const preview = mock(async () => {})
  const stopPreview = mock(async () => {})
  const marketplace = {
    list: async () => ({ active: {}, history: {} }),
    detail: async () => {
      throw new Error("detail unavailable")
    },
    preview,
    stopPreview
  } as unknown as ExtensionMarketplace
  const view = render(
    <MarketplaceMatches
      url="https://example.com/inbox"
      marketplace={marketplace}
      findMatches={async () => [match]}
      onModify={() => {}}
    />
  )
  fireEvent.click(await screen.findByRole("button", { name: "Preview" }))
  await waitFor(() => expect(preview).toHaveBeenCalledTimes(1))

  view.unmount()
  await waitFor(() => expect(stopPreview).toHaveBeenCalledTimes(2))
})
