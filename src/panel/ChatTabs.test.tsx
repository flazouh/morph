import { afterEach, expect, mock, test } from "bun:test"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { ChatTabs } from "./ChatTabs"
import { Transcript } from "./Transcript"

afterEach(cleanup)

const threads = [
  { id: "homepage", title: "Homepage refresh", createdAt: 0 },
  { id: "checkout", title: "Checkout flow", createdAt: 1 }
]

test("chat tabs use mascot marks and expose thread selection and creation", () => {
  const onSelect = mock(() => undefined)
  const onNew = mock(() => undefined)
  render(<ChatTabs threads={threads} selected="homepage" onSelect={onSelect} onNew={onNew} onClose={() => undefined} />)

  const homepage = screen.getByRole("tab", { name: "Homepage refresh" })
  const checkout = screen.getByRole("tab", { name: "Checkout flow" })
  expect(homepage.getAttribute("aria-selected")).toBe("true")
  expect(homepage.id).toBe("active-chat-thread-tab")
  expect(homepage.tabIndex).toBe(0)
  expect(checkout.tabIndex).toBe(-1)
  expect(homepage.querySelector("[data-shape]")).toBeTruthy()
  expect(checkout.querySelector("[data-shape]")).toBeTruthy()
  expect(new Set([homepage, checkout].map((tab) => tab.querySelector("[data-shape]")?.getAttribute("data-shape"))).size).toBe(2)

  fireEvent.click(checkout)
  fireEvent.click(screen.getByRole("button", { name: "New chat" }))
  expect(onSelect).toHaveBeenCalledWith("checkout")
  expect(onNew).toHaveBeenCalledTimes(1)

  fireEvent.keyDown(homepage, { key: "ArrowRight" })
  expect(onSelect).toHaveBeenLastCalledWith("checkout")
  expect(document.activeElement).toBe(checkout)
})

test("chat tabs stay available", () => {
  render(<ChatTabs threads={threads} selected="homepage" onSelect={() => undefined} onNew={() => undefined} onClose={() => undefined} />)

  expect((screen.getByRole("tab", { name: "Checkout flow" }) as HTMLButtonElement).disabled).toBe(false)
  expect((screen.getByRole("button", { name: "New chat" }) as HTMLButtonElement).disabled).toBe(false)
})

test("bot chats sit after their parent and show live status", () => {
  const crew = [
    { id: "other", title: "Other", createdAt: 0 },
    { id: "child", title: "Checkout bot", createdAt: 2, parentId: "root", rootId: "root", agentId: "bot-1", status: "working" as const },
    { id: "root", title: "Redesign", createdAt: 1 }
  ]
  render(<ChatTabs threads={crew} selected="root" onSelect={() => undefined} onNew={() => undefined} onClose={() => undefined} />)

  const tabs = screen.getAllByRole("tab")
  expect(tabs.map((tab) => tab.textContent)).toEqual(["Other", "Redesign", "Checkout bot"])
  expect(screen.getByLabelText("Checkout bot is working")).toBeTruthy()
  expect(screen.getByRole("tab", { name: "Checkout bot" }).closest("[data-parent]")?.getAttribute("data-parent")).toBe("root")
})

test("a destination bot uses the same mascot as its chat tab", () => {
  const crew = [
    { id: "root", title: "Redesign", createdAt: 1 },
    { id: "child-thread", title: "Checkout bot", createdAt: 2, parentId: "root", rootId: "root", agentId: "checkout-bot", status: "working" as const }
  ]
  render(
    <>
      <ChatTabs threads={crew} selected="root" onSelect={() => undefined} onNew={() => undefined} onClose={() => undefined} />
      <Transcript
        mascot={{ seed: "root" }}
        steps={[
          { kind: "user", text: "Send the update.", at: 1 },
          {
            kind: "tool",
            callId: "message-1",
            name: "send_agent",
            input: { to: "checkout-bot", message: "Ready." },
            result: { ok: true },
            at: 2
          }
        ]}
        state="idle"
      />
    </>
  )

  const tabShape = screen.getByRole("tab", { name: "Checkout bot" }).querySelector("[data-shape]")
  const toolShape = screen.getByRole("img", { name: "Destination bot checkout-bot" }).querySelector("[data-shape]")
  expect(toolShape?.getAttribute("data-shape")).toBe(tabShape?.getAttribute("data-shape"))
  expect(toolShape?.getAttribute("fill")).toBe(tabShape?.getAttribute("fill"))
})

test("clearing a chat asks first, and keep leaves it", () => {
  const onClose = mock(() => undefined)
  render(<ChatTabs threads={threads} selected="homepage" onSelect={() => undefined} onNew={() => undefined} onClose={onClose} />)

  fireEvent.click(screen.getByRole("button", { name: "Clear Homepage refresh" }))
  expect(screen.getByText("The look on the page stays.")).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: "Keep" }))
  expect(onClose).not.toHaveBeenCalled()

  fireEvent.click(screen.getByRole("button", { name: "Clear Homepage refresh" }))
  fireEvent.click(screen.getByRole("button", { name: "Clear" }))
  expect(onClose).toHaveBeenCalledWith("homepage")
})
