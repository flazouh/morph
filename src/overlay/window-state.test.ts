import { describe, expect, test } from "bun:test"
import { initialChatWindow, reduceChatWindow } from "./window-state"

describe("chat window state", () => {
  test("minimize and restore preserve the last full layout", () => {
    const expanded = reduceChatWindow(initialChatWindow, { type: "toggleExpandedChat" })
    const minimized = reduceChatWindow(expanded, { type: "minimizeChat" })

    expect(minimized).toEqual({ mode: "minimized", restoreMode: "expanded" })
    expect(reduceChatWindow(minimized, { type: "restoreChat" })).toEqual(expanded)
  })

  test("restore is stable outside the minimized state", () => {
    expect(reduceChatWindow(initialChatWindow, { type: "restoreChat" })).toBe(initialChatWindow)
  })
})
