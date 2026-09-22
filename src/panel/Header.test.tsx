import { afterEach, expect, mock, test } from "bun:test"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { Header } from "./Header"

afterEach(cleanup)

test("the chat decoration uses equal top and left insets", () => {
  render(
    <Header
      busy={false}
      onForgetPage={() => undefined}
      onForgetSite={() => undefined}
      onOpenSettings={() => undefined}
      onWindowAction={() => undefined}
    />
  )

  const controls = screen.getByRole("group", { name: "Chat window controls" })
  const controlClasses = controls.className.split(" ")
  expect(controls.parentElement?.className).toContain("px-2")
  expect(controlClasses).toContain("self-start")
  expect(controlClasses).toContain("mt-2")
  expect(controlClasses).toContain("gap-1")
})

test("the gear opens the settings workspace", () => {
  const onOpenSettings = mock(() => undefined)
  render(<Header busy={false} onForgetPage={() => undefined} onForgetSite={() => undefined} onOpenSettings={onOpenSettings} />)

  fireEvent.click(screen.getByRole("button", { name: "Settings" }))
  expect(onOpenSettings).toHaveBeenCalledTimes(1)
})

test("an embedded header shows Inspect page with the hotkey in its accessible name", () => {
  const onToggleInspector = mock(() => undefined)
  render(
    <Header
      busy={false}
      onForgetPage={() => undefined}
      onForgetSite={() => undefined}
      onOpenSettings={() => undefined}
      onWindowAction={() => undefined}
      onToggleInspector={onToggleInspector}
    />
  )

  const inspect = screen.getByRole("button", { name: "Inspect page (Alt+Shift+I)" })
  expect(inspect.getAttribute("title")).toBe("Inspect page (Alt+Shift+I)")
  fireEvent.click(inspect)
  expect(onToggleInspector).toHaveBeenCalledTimes(1)
})

test("a standalone header does not show Inspect page", () => {
  render(<Header busy={false} onForgetPage={() => undefined} onForgetSite={() => undefined} onOpenSettings={() => undefined} />)
  expect(screen.queryByRole("button", { name: /Inspect page/ })).toBeNull()
})

test("taking a look off asks which, then asks again", () => {
  const onForgetPage = mock(() => undefined)
  const onForgetSite = mock(() => undefined)
  render(<Header busy={false} onForgetPage={onForgetPage} onForgetSite={onForgetSite} onOpenSettings={() => undefined} />)

  fireEvent.click(screen.getByRole("button", { name: "Take a look off" }))
  fireEvent.click(screen.getByRole("button", { name: "This page" }))
  expect(screen.getByText("This URL goes back. Its saved repo files are removed too.")).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: "Keep" }))
  expect(onForgetPage).not.toHaveBeenCalled()

  fireEvent.click(screen.getByRole("button", { name: "This site" }))
  expect(screen.getByText("Every page on this host goes back. Its saved repo files are removed too.")).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: "Keep" }))
  expect(onForgetSite).not.toHaveBeenCalled()

  fireEvent.click(screen.getByRole("button", { name: "This page" }))
  fireEvent.click(screen.getByRole("button", { name: "Remove" }))
  expect(onForgetPage).toHaveBeenCalledTimes(1)
  expect(onForgetSite).not.toHaveBeenCalled()
})
