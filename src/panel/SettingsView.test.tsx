import { afterEach, expect, mock, test } from "bun:test"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { CatalogModel } from "./models"
import { DEFAULT_SETTINGS, type Settings } from "@/session/contract"
import { memorySkills } from "@/skills/store"
import { SettingsView } from "./SettingsView"

afterEach(cleanup)

const skills = memorySkills()

const renderView = (
  settings: Partial<Settings> = {},
  loadCursorModels?: (key: string) => Promise<ReadonlyArray<CatalogModel>>
) => {
  const onChange = mock((_: Partial<Settings>) => undefined)
  const onBack = mock(() => undefined)
  render(
    <SettingsView
      settings={{ ...DEFAULT_SETTINGS, ...settings }}
      skills={skills}
      onChange={onChange}
      onBack={onBack}
      {...(loadCursorModels === undefined ? {} : { loadCursorModels })}
    />
  )
  return { onChange, onBack }
}

test("the workspace opens on Appearance with the theme and font size controls", () => {
  renderView()
  expect(screen.getByRole("group", { name: "Theme" })).toBeTruthy()
  expect(screen.getByRole("group", { name: "Font size" })).toBeTruthy()
  // The AI provider fields stay behind their own section.
  expect(screen.queryByLabelText("OpenRouter key")).toBeNull()
})

test("the sidebar switches to the AI provider section", () => {
  renderView()
  fireEvent.click(screen.getByRole("button", { name: "AI provider" }))
  expect(screen.getByLabelText("OpenRouter key")).toBeTruthy()
  expect(screen.queryByRole("group", { name: "Theme" })).toBeNull()
})

test("the sidebar opens the installed skills", async () => {
  renderView()
  fireEvent.click(screen.getByRole("button", { name: "Skills" }))

  expect(await screen.findByRole("button", { name: "Open Typography" })).toBeTruthy()
})

test("the active section is marked as the current page", () => {
  renderView()
  expect(screen.getByRole("button", { name: "Appearance" }).getAttribute("aria-current")).toBe("page")
  fireEvent.click(screen.getByRole("button", { name: "Skills" }))
  expect(screen.getByRole("button", { name: "Skills" }).getAttribute("aria-current")).toBe("page")
  expect(screen.getByRole("button", { name: "Appearance" }).getAttribute("aria-current")).toBeNull()
})

test("choosing a theme writes the store", () => {
  const { onChange } = renderView()
  fireEvent.click(screen.getByRole("button", { name: "Dark" }))
  expect(onChange).toHaveBeenCalledWith({ theme: "dark" })
})

test("the current theme reads as pressed", () => {
  renderView({ theme: "dark" })
  expect(screen.getByRole("button", { name: "Dark" }).getAttribute("aria-pressed")).toBe("true")
  expect(screen.getByRole("button", { name: "System" }).getAttribute("aria-pressed")).toBe("false")
})

test("choosing a font size writes the store", () => {
  const { onChange } = renderView()
  fireEvent.click(screen.getByRole("button", { name: "Large" }))
  expect(onChange).toHaveBeenCalledWith({ fontSize: "large" })
})

test("the OpenRouter key writes the store as the reader types", () => {
  const { onChange } = renderView()
  fireEvent.click(screen.getByRole("button", { name: "AI provider" }))
  fireEvent.change(screen.getByLabelText("OpenRouter key"), { target: { value: "sk-or-x" } })
  expect(onChange).toHaveBeenCalledWith({ openRouterKey: "sk-or-x" })
})

test("the provider switch shows only the selected provider fields", () => {
  const { onChange } = renderView()
  fireEvent.click(screen.getByRole("button", { name: "AI provider" }))
  fireEvent.click(screen.getByRole("button", { name: "Cursor" }))
  expect(onChange).toHaveBeenCalledWith({ provider: "cursor" })

  cleanup()
  renderView({ provider: "cursor", cursorKey: "crsr_x" })
  fireEvent.click(screen.getByRole("button", { name: "AI provider" }))
  expect(screen.getByLabelText("Cursor key")).toBeTruthy()
  expect(screen.getByRole("link", { name: "Get a Cursor API key" }).getAttribute("href")).toBe(
    "https://cursor.com/dashboard/api"
  )
  expect(screen.queryByLabelText("OpenRouter key")).toBeNull()
})

test("the Cursor key check reports empty, connected, and 401 outcomes", async () => {
  const load = mock(async (key: string) => {
    if (key === "") throw new Error("Enter a Cursor API key.")
    if (key === "bad") throw new Error("Cursor rejected this API key (401).")
    return [{ value: "composer-2", label: "Composer 2", in: "—", out: "—" }]
  })

  const view = renderView({ provider: "cursor" }, load)
  fireEvent.click(screen.getByRole("button", { name: "AI provider" }))
  fireEvent.click(screen.getByRole("button", { name: "Check connection" }))
  expect(await screen.findByText("Enter a Cursor API key.")).toBeTruthy()

  view.onChange.mockClear()
  cleanup()
  renderView({ provider: "cursor", cursorKey: "good" }, load)
  fireEvent.click(screen.getByRole("button", { name: "AI provider" }))
  fireEvent.click(screen.getByRole("button", { name: "Check connection" }))
  expect(await screen.findByText("Connected · 1 model")).toBeTruthy()

  cleanup()
  renderView({ provider: "cursor", cursorKey: "bad" }, load)
  fireEvent.click(screen.getByRole("button", { name: "AI provider" }))
  fireEvent.click(screen.getByRole("button", { name: "Check connection" }))
  expect(await screen.findByText("Cursor rejected this API key (401).")).toBeTruthy()
  await waitFor(() => expect(load).toHaveBeenCalledWith("bad"))
})

test("Back to chat calls onBack", () => {
  const { onBack } = renderView()
  fireEvent.click(screen.getByRole("button", { name: "Back to chat" }))
  expect(onBack).toHaveBeenCalledTimes(1)
})
