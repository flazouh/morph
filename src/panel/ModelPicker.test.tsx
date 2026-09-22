import { afterEach, expect, test } from "bun:test"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { ModelPicker } from "./ModelPicker"

afterEach(cleanup)

test("the model selector uses the stock trigger and compact metadata rows", async () => {
  render(
    <ModelPicker
      models={[
        { value: "openai/gpt-5.2", label: "GPT-5.2", in: "$1.75/M", out: "$14/M" },
        { value: "anthropic/claude-sonnet-4", label: "Claude Sonnet 4", in: "$3/M", out: "$15/M" }
      ]}
      value="openai/gpt-5.2"
      onChange={() => undefined}
    />
  )

  const trigger = screen.getByRole("button", { name: /GPT-5.2/ })
  expect(trigger.className).toContain("border-0")
  expect(trigger.className).toContain("bg-transparent")
  fireEvent.click(trigger)

  expect((await screen.findByRole("dialog")).className).toContain("max-h-[min(18rem,calc(100vh-1rem))]")
  const option = await screen.findByRole("option", { name: /GPT-5.2.*\$1.75\/M in · \$14\/M out/ })
  expect(option.className).toContain("items-center")
  expect(option.className).not.toContain("transition-colors")
  expect(screen.getByRole("option", { name: /Claude Sonnet 4/ }).className).toContain("hover:bg-foreground/[0.07]")
  expect(option.textContent).toBe("GPT-5.2$1.75$14")
  expect(option.querySelector('[title="Input price"]')?.className).toContain("text-success")
  expect(option.querySelector('[title="Output price"]')?.className).toContain("text-warning")
  expect(option.querySelector("img")?.getAttribute("src")).toContain("openai.com")
  expect(screen.getByRole("option", { name: /Claude Sonnet 4/ }).querySelector("img")?.getAttribute("src")).toContain(
    "anthropic.com"
  )
})

test("the model selector keeps search and sorting", async () => {
  render(
    <ModelPicker
      models={[
        { value: "cheap", label: "Cheap", in: "$0.1/M", out: "$0.2/M", intelligence: 10, promptPerM: 0.1 },
        { value: "smart", label: "Smart", in: "$5/M", out: "$15/M", intelligence: 50, promptPerM: 5 }
      ]}
      value="cheap"
      onChange={() => undefined}
    />
  )

  fireEvent.click(screen.getByRole("button", { name: /Cheap/ }))
  const rows = () => screen.getAllByRole("option").map((option) => option.textContent)
  expect(rows()).toEqual(["Smart50$5$15", "Cheap10$0.1$0.2"])
  expect(screen.getByRole("option", { name: /Smart/ }).querySelector('[title="Intelligence score"]')?.className).toContain(
    "text-violet"
  )

  fireEvent.click(screen.getByRole("button", { name: "Sort models" }))
  const priceSort = screen.getByRole("menuitem", { name: /Price in/ })
  const intelligenceSort = screen.getByRole("menuitem", { name: /Intelligence/ })
  expect(priceSort.closest("[role='menu']")?.className).toContain("absolute")
  expect(priceSort.closest("[role='menu']")?.className).toContain("top-0")
  expect(priceSort.closest("[role='menu']")?.className).toContain("w-60")
  expect(intelligenceSort.children[1]?.className).toContain("truncate")
  expect(screen.getByRole("listbox").className).not.toContain("hidden")
  expect(rows()).toEqual(["Smart50$5$15", "Cheap10$0.1$0.2"])
  fireEvent.click(priceSort)
  expect(rows()).toEqual(["Cheap$0.1$0.2", "Smart$5$15"])

  fireEvent.change(screen.getByLabelText("Filter models"), { target: { value: "smart" } })
  expect(rows()).toEqual(["Smart$5$15"])
})
