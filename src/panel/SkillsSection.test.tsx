import { afterEach, expect, test } from "bun:test"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { Effect } from "effect"
import { memorySkills } from "@/skills/store"
import { SkillsSection } from "./SkillsSection"

afterEach(cleanup)

test("shows the complete starter set with enabled switches", async () => {
  render(<SkillsSection store={memorySkills()} />)

  expect(await screen.findByRole("button", { name: "Open Art Direction" })).toBeTruthy()
  expect(screen.getByRole("button", { name: "Open Motion Craft" })).toBeTruthy()
  expect(screen.getAllByRole("switch")).toHaveLength(7)
  expect(screen.getAllByRole("switch").every((control) => control.getAttribute("aria-checked") === "true")).toBe(true)
})

test("opens a built-in for inspection and returns to the list", async () => {
  render(<SkillsSection store={memorySkills()} />)
  fireEvent.click(await screen.findByRole("button", { name: "Open Typography" }))

  expect(screen.getByRole("heading", { name: "Typography" })).toBeTruthy()
  expect(screen.getByRole("link", { name: "Hallmark" })).toBeTruthy()
  expect(screen.queryByRole("button", { name: "Edit Typography" })).toBeNull()

  fireEvent.click(screen.getByRole("button", { name: "All skills" }))
  expect(await screen.findByRole("button", { name: "Open Typography" })).toBeTruthy()
})

test("a switch changes the stored enabled state", async () => {
  const store = memorySkills()
  render(<SkillsSection store={store} />)
  const toggle = await screen.findByRole("switch", { name: "Enable Typography" })

  fireEvent.click(toggle)

  await waitFor(async () => {
    expect((await Effect.runPromise(store.read)).find((skill) => skill.id === "typography")?.enabled).toBe(false)
  })
})

test("creates a custom skill from a title and instructions", async () => {
  const store = memorySkills({}, { id: () => "custom-1", now: () => "now" })
  render(<SkillsSection store={store} />)
  fireEvent.click(await screen.findByRole("button", { name: "Add skill" }))
  fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Editorial data" } })
  fireEvent.change(screen.getByLabelText("Instructions"), {
    target: { value: "Use tabular numbers and quiet separators." }
  })
  fireEvent.click(screen.getByRole("button", { name: "Save skill" }))

  expect(await screen.findByRole("heading", { name: "Editorial data" })).toBeTruthy()
  expect((await Effect.runPromise(store.read)).at(-1)).toMatchObject({
    id: "custom-1",
    title: "Editorial data",
    enabled: true
  })
})

test("edits a custom skill without exposing edit for built-ins", async () => {
  const store = memorySkills({}, { id: () => "custom-1", now: () => "now" })
  await Effect.runPromise(store.create({ title: "First title", content: "First instructions." }))
  render(<SkillsSection store={store} />)
  fireEvent.click(await screen.findByRole("button", { name: "Open First title" }))
  fireEvent.click(screen.getByRole("button", { name: "Edit First title" }))
  fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Better title" } })
  fireEvent.click(screen.getByRole("button", { name: "Save skill" }))

  expect(await screen.findByRole("heading", { name: "Better title" })).toBeTruthy()
  expect((await Effect.runPromise(store.read)).at(-1)?.title).toBe("Better title")
})

test("asks before deleting a custom skill", async () => {
  const store = memorySkills({}, { id: () => "custom-1", now: () => "now" })
  await Effect.runPromise(store.create({ title: "Temporary", content: "Temporary guidance." }))
  render(<SkillsSection store={store} />)
  fireEvent.click(await screen.findByRole("button", { name: "Open Temporary" }))
  fireEvent.click(screen.getByRole("button", { name: "Delete Temporary" }))
  expect(screen.getByText("Delete this skill?")).toBeTruthy()

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Delete" }))
  })
  expect(await screen.findByRole("button", { name: "Add skill" })).toBeTruthy()
  expect((await Effect.runPromise(store.read)).some((skill) => skill.id === "custom-1")).toBe(false)
})

test("shows field errors for an empty custom skill", async () => {
  render(<SkillsSection store={memorySkills()} />)
  fireEvent.click(await screen.findByRole("button", { name: "Add skill" }))
  fireEvent.click(screen.getByRole("button", { name: "Save skill" }))

  expect(await screen.findByText("Add a skill title.")).toBeTruthy()
})
