import { afterEach, expect, test } from "bun:test"
import { cleanup, render, screen, within } from "@testing-library/react"
import { ToolStep } from "./ToolStep"

afterEach(cleanup)

test("only crew tools put bot icons inside their action labels", () => {
  const mascot = { seed: "root-bot", variant: 0 }
  const base = { kind: "tool" as const, result: { ok: true }, at: 1 }
  render(
    <>
      <ToolStep
        call={{ ...base, callId: "styles", name: "apply_styles", input: { css: "body {}" } }}
        running={false}
        mascot={mascot}
      />
      <ToolStep
        call={{ ...base, callId: "message", name: "send_agent", input: { to: "copy-bot", message: "Ready." } }}
        running={false}
        mascot={mascot}
      />
    </>
  )

  const styles = screen.getByRole("button", { name: /Apply styles/ })
  const message = screen.getByRole("button", { name: /Messaging/ })
  expect(within(styles).queryByTestId("tool-bots")).toBeNull()
  const bot = within(message).getByRole("img", { name: "Destination bot copy-bot" })
  expect(bot).toBeTruthy()
  expect(bot.parentElement?.className).not.toContain("bg-background")
  expect(bot.parentElement?.className).not.toContain("ring-")
})
