import { afterEach, describe, expect, test } from "bun:test"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { UserScriptsGate } from "@/bridge/user-scripts"
import { UserScriptsCard } from "./UserScriptsCard"
import { pollsUserScripts, reduceUserScripts, userScriptsApprovalStatus, userScriptsVisible } from "./user-scripts-card"

afterEach(cleanup)

const fakeGate = (enabled: boolean) => {
  const calls: string[] = []
  let current = enabled
  const gate: UserScriptsGate = {
    enabled: async () => {
      calls.push("enabled")
      return current
    },
    openSettings: async () => {
      calls.push("openSettings")
    },
    reload: async () => {
      calls.push("reload")
    }
  }
  return { gate, calls, set: (next: boolean) => (current = next) }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe("user scripts stage", () => {
  test("a check that says off asks; a check that says on tells and goes", () => {
    expect(reduceUserScripts("unknown", { type: "checked", enabled: false })).toBe("off")
    expect(reduceUserScripts("off", { type: "checked", enabled: true })).toBe("on")
    expect(reduceUserScripts("opened", { type: "checked", enabled: true })).toBe("on")
    expect(reduceUserScripts("on", { type: "checked", enabled: false })).toBe("off")
  })

  test("waiting at the switch survives a check that still says off", () => {
    expect(reduceUserScripts("off", { type: "openSettings" })).toBe("opened")
    expect(reduceUserScripts("opened", { type: "checked", enabled: false })).toBe("opened")
  })

  test("not now is final for this panel", () => {
    expect(reduceUserScripts("off", { type: "dismiss" })).toBe("dismissed")
    expect(reduceUserScripts("dismissed", { type: "checked", enabled: false })).toBe("dismissed")
    expect(reduceUserScripts("dismissed", { type: "checked", enabled: true })).toBe("dismissed")
    expect(reduceUserScripts("dismissed", { type: "openSettings" })).toBe("dismissed")
  })

  test("a card that said on and went stays gone", () => {
    expect(reduceUserScripts("on", { type: "gone" })).toBe("done")
    expect(reduceUserScripts("off", { type: "gone" })).toBe("off")
    expect(reduceUserScripts("done", { type: "checked", enabled: false })).toBe("done")
    expect(userScriptsVisible("done")).toBe(false)
    expect(pollsUserScripts("done")).toBe(false)
  })

  test("the card polls only while the reader can act on the answer", () => {
    expect(pollsUserScripts("off")).toBe(true)
    expect(pollsUserScripts("opened")).toBe(true)
    expect(pollsUserScripts("on")).toBe(false)
    expect(pollsUserScripts("dismissed")).toBe(false)
    expect(pollsUserScripts("unknown")).toBe(false)
  })

  test("each stage maps to one approval status and one visibility", () => {
    expect(userScriptsApprovalStatus("off")).toBe("pending")
    expect(userScriptsApprovalStatus("opened")).toBe("running")
    expect(userScriptsApprovalStatus("on")).toBe("complete")
    expect(userScriptsVisible("unknown")).toBe(false)
    expect(userScriptsVisible("dismissed")).toBe(false)
    expect(userScriptsVisible("on")).toBe(true)
  })
})

describe("UserScriptsCard", () => {
  test("draws nothing while the switch is on", async () => {
    const { gate, calls } = fakeGate(true)
    render(<UserScriptsCard gate={gate} pollMs={5} />)
    await waitFor(() => expect(calls).toContain("enabled"))
    expect(screen.queryByText("Morph needs User Scripts")).toBeNull()
  })

  test("asks while the switch is off, with the way to it and what it unlocks", async () => {
    const { gate } = fakeGate(false)
    render(<UserScriptsCard gate={gate} pollMs={5} />)
    expect(await screen.findByText("Morph needs User Scripts")).toBeTruthy()
    expect(screen.getByTestId("tool-approval-status").textContent).toBe("Switch off")
    expect(screen.getByRole("button", { name: "Open Morph settings" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Not now" })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "View details" }))
    expect(screen.getByText("Allow User Scripts")).toBeTruthy()
    expect(screen.getByText("Set the design, Apply styles, Run a script, Load the kit")).toBeTruthy()
  })

  test("opening the settings waits at the switch, then completes when the check says on", async () => {
    const { gate, calls, set } = fakeGate(false)
    render(<UserScriptsCard gate={gate} pollMs={5} hideMs={20} />)
    fireEvent.click(await screen.findByRole("button", { name: "Open Morph settings" }))
    await waitFor(() => expect(calls).toContain("openSettings"))
    expect(await screen.findByText("Turn on Allow User Scripts")).toBeTruthy()
    expect(screen.getByTestId("tool-approval-status").textContent).toBe("Waiting")
    expect(screen.getByRole("button", { name: "Reload Morph" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Open Morph settings" })).toBeNull()

    set(true)
    expect(await screen.findByText("User Scripts is on")).toBeTruthy()
    expect(screen.getByTestId("tool-approval-status").textContent).toBe("On")
    // Says on for `hideMs`, then leaves the tree.
    await act(() => wait(100))
    expect(screen.queryByText("User Scripts is on")).toBeNull()
  })

  test("a switch turned on without the button is noticed too", async () => {
    const { gate, set } = fakeGate(false)
    render(<UserScriptsCard gate={gate} pollMs={5} hideMs={1000} />)
    expect(await screen.findByText("Morph needs User Scripts")).toBeTruthy()
    set(true)
    expect(await screen.findByText("User Scripts is on")).toBeTruthy()
  })

  test("not now hides the card and stops the checks", async () => {
    const { gate, calls } = fakeGate(false)
    render(<UserScriptsCard gate={gate} pollMs={5} />)
    fireEvent.click(await screen.findByRole("button", { name: "Not now" }))
    await waitFor(() => expect(screen.queryByText("Morph needs User Scripts")).toBeNull())
    const before = calls.filter((call) => call === "enabled").length
    await act(() => wait(30))
    expect(calls.filter((call) => call === "enabled").length).toBe(before)
  })

  test("reload asks the extension to restart", async () => {
    const { gate, calls } = fakeGate(false)
    render(<UserScriptsCard gate={gate} pollMs={5} />)
    fireEvent.click(await screen.findByRole("button", { name: "Open Morph settings" }))
    fireEvent.click(await screen.findByRole("button", { name: "Reload Morph" }))
    await waitFor(() => expect(calls).toContain("reload"))
  })
})
