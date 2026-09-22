import { afterEach, expect, test } from "bun:test"
import { cleanup, render, screen } from "@testing-library/react"
import { EmptyState } from "./EmptyState"

afterEach(cleanup)

test("the empty state invites a first restyle and has no starter prompts", () => {
  render(<EmptyState mascot={{ seed: "new-chat", variant: 0 }} />)

  const buddy = screen.getByRole("img", { name: "Friendly shape" })
  expect([...buddy.querySelectorAll("[data-shape]")].map((shape) => shape.getAttribute("data-shape"))).toEqual(["squircle"])
  expect([...buddy.querySelectorAll("[data-shape]")].map((shape) => shape.getAttribute("fill"))).toEqual(["#FF9800"])
  expect(buddy.querySelector("defs, mask, linearGradient")).toBeNull()
  expect([...buddy.querySelectorAll("[data-stripe-eyes]")].map((eyes) => eyes.querySelectorAll("path").length)).toEqual([2])
  expect([...buddy.querySelectorAll("[data-stripe-eyes]")].every((eyes) => eyes.getAttribute("fill") === "#111111")).toBe(true)
  expect(screen.getByRole("heading", { name: "What should we restyle?" })).toBeTruthy()
  expect(screen.queryByText("Tell the agent what to change")).toBeNull()
  expect(screen.queryByText("Start with")).toBeNull()
  expect(screen.queryByRole("button", { name: "Redesign this page" })).toBeNull()
  expect(screen.queryByRole("button", { name: "Make it dark and calm" })).toBeNull()
  expect(screen.queryByRole("button", { name: "Turn the list into cards" })).toBeNull()
})
