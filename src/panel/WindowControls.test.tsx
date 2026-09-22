import { afterEach, expect, test } from "bun:test"
import { cleanup, render, screen } from "@testing-library/react"
import { WindowControls } from "./WindowControls"

afterEach(cleanup)

test("window controls keep compact hit areas around the macOS dots", () => {
  render(<WindowControls onAction={() => undefined} />)

  for (const button of screen.getAllByRole("button")) {
    expect(button.className.split(" ")).toContain("size-4")
    expect(button.className.split(" ")).not.toContain("size-11")
    expect(button.querySelector("span")?.className.split(" ")).toContain("size-3")
    expect(button.querySelector("svg")?.classList.contains("opacity-0")).toBe(true)
  }
})
