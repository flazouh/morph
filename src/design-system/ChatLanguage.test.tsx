import { afterEach, expect, test } from "bun:test"
import { cleanup, render, screen } from "@testing-library/react"
import { TOOL_NAMES } from "@/agent/tool-names"
import { ChatLanguage } from "./ChatLanguage"

afterEach(cleanup)

test("shows the question design, bot chats, and every chat tool", () => {
  const { container } = render(<ChatLanguage />)

  expect(screen.getByRole("heading", { name: "Ask the reader" })).toBeTruthy()
  expect(screen.getByText("Which direction should the redesign take?")).toBeTruthy()
  expect(screen.getByRole("tab", { name: "Layout bot" })).toBeTruthy()
  expect(screen.getByLabelText("Layout bot is working")).toBeTruthy()
  expect(screen.getByLabelText("Copy bot is done")).toBeTruthy()

  for (const name of TOOL_NAMES) {
    expect(container.querySelector(`[data-tool="${name}"]`)).toBeTruthy()
  }
})
