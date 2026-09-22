import { afterEach, expect, test } from "bun:test"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { PublishLook, PUBLISH_PROMPT } from "./PublishLook"
import { lastAppliedAt, publishedIn } from "./activity"
import type { Step } from "@/session"

const render = (node: React.ReactNode): HTMLElement => {
  const host = document.createElement("div")
  document.body.append(host)
  act(() => {
    createRoot(host).render(node)
  })
  return host
}

afterEach(() => {
  document.body.innerHTML = ""
})

const row = (host: HTMLElement): HTMLElement | null => host.querySelector("[aria-hidden='false']")

test("nothing applied, nothing to offer", () => {
  const host = render(<PublishLook applied={false} published={false} onPublish={() => {}} />)
  expect(row(host)).toBeNull()
})

test("a look on the page offers to share it", () => {
  const host = render(<PublishLook applied published={false} onPublish={() => {}} />)
  expect(row(host)?.textContent).toContain("Share this look as a Morph")
})

test("the button asks the agent, so the reader still confirms the release", () => {
  const sent: string[] = []
  const host = render(<PublishLook applied published={false} onPublish={() => sent.push(PUBLISH_PROMPT)} />)
  act(() => {
    host.querySelector("button")?.click()
  })
  expect(sent).toEqual(["Publish this look to the Morph marketplace."])
})

test("once it is published the row says so instead of asking again", () => {
  const host = render(<PublishLook applied published onPublish={() => {}} />)
  expect(row(host)?.textContent).toContain("Published to the marketplace")
  expect(host.querySelector("button")).toBeNull()
})

const step = (name: string, result: unknown): Step => ({ kind: "tool", callId: "c", name, input: {}, result, at: 0 })

test("lastAppliedAt finds the write the page wears, so a removal can be told from a later one", () => {
  const wrote = step("write_skin", { ok: true, applied: { path: "/", skin: { "page.tsx": "x" } } })
  const read = step("read_page", { ok: true, page: {} })
  expect(lastAppliedAt([])).toBe(-1)
  expect(lastAppliedAt([read])).toBe(-1)
  expect(lastAppliedAt([wrote, read])).toBe(0)
  expect(lastAppliedAt([read, wrote])).toBe(1)
  // A write that failed put nothing on the page.
  expect(lastAppliedAt([step("write_skin", { error: "no" })])).toBe(-1)
})

test("publishedIn reads a publish that landed, and only that", () => {
  expect(publishedIn([])).toBe(false)
  expect(publishedIn([step("write_skin", { ok: true })])).toBe(false)
  expect(publishedIn([step("publish_morph", { error: "the reader must confirm this exact release before publishing" })])).toBe(false)
  expect(publishedIn([step("publish_morph", { ok: true, releaseId: "release-1" })])).toBe(true)
})
