import { describe, expect, test } from "bun:test"
import { TOOL_NAMES } from "@/agent/tool-names"
import { botTargetsOf, partsOf, statusOf, summarizeInput, targetOf, viewOf, type ToolCall } from "./tools-view"

const call = (name: string, input: unknown, result?: unknown): ToolCall => ({
  kind: "tool",
  callId: "c1",
  name,
  input,
  ...(result === undefined ? {} : { result }),
  at: 0
})

describe("how a tool call reads", () => {
  test("every shared tool name has a view of its own; a stranger gets the fallback", () => {
    const titles = new Set(TOOL_NAMES.map((n) => viewOf(n).title))
    expect(titles.size).toBe(TOOL_NAMES.length)
    expect(viewOf("teleport").title).toBe("Tool call")
    expect(TOOL_NAMES.every((n) => viewOf(n).action !== undefined)).toBe(true)
    expect(viewOf("read_page").action).toBe("read")
    expect(viewOf("apply_styles").action).toBe("edit")
    expect(viewOf("run_script").action).toBe("run")
  })

  test("the live row names the object of the call, not the tool title", () => {
    expect(targetOf(call("read_page", { selector: "main" }))).toBe("main")
    expect(targetOf(call("read_page", {}))).toBe("body")
    expect(targetOf(call("read_styles", { selector: ".x" }))).toBe(".x")
    expect(targetOf(call("apply_styles", { css: "body{color:red}" }))).toBe("styles")
    expect(targetOf(call("look", {}))).toBe("page")
    expect(targetOf(call("load_kit", {}))).toBe("kit")
    expect(targetOf(call("teleport", {}))).toBe("tool")
  })

  test("the summary is the first string input, clipped, skipping the code field", () => {
    expect(summarizeInput({ selector: ".athing", limit: 3 })).toBe(".athing")
    expect(summarizeInput({ css: "body{}", note: "dark   and\ncalm" }, "css")).toBe("dark and calm")
    expect(summarizeInput({ css: "body{}" }, "css")).toBe("")
    expect(summarizeInput({ persist: true })).toBe("")
    expect(summarizeInput("a".repeat(40))).toBe(`${"a".repeat(21)}…`)
    expect(summarizeInput(["x"])).toBe("")
  })

  test("a write that failed for the User Scripts switch names the card instead of the input", () => {
    const off = { error: "any prose the model was told", code: "userScriptsOff" as const }
    expect(partsOf(call("write_design", { tokens: { primary: "hotpink" } }, off)).summary).toBe("needs User Scripts, see the card above")
    expect(partsOf(call("apply_styles", { css: "body{}" }, off)).summary).toBe("needs User Scripts, see the card above")
    // Any other failure keeps the input summary, whatever its prose says.
    expect(partsOf(call("read_styles", { selector: ".x" }, { error: "boom" })).summary).toBe(".x")
    expect(partsOf(call("read_styles", { selector: ".x" }, { error: "chrome.userScripts is off" })).summary).toBe(".x")
  })

  test("status: running without a result while the turn runs, cancelled after, error on { error }", () => {
    expect(statusOf(call("read_page", {}), true)).toBe("running")
    expect(statusOf(call("read_page", {}), false)).toBe("cancelled")
    expect(statusOf(call("read_page", {}, { error: "no" }), false)).toBe("error")
    expect(statusOf(call("read_page", {}, { ok: true }), false)).toBe("success")
  })

  test("bot targets use crew destinations and remove duplicates", () => {
    expect(botTargetsOf(call("apply_styles", {}), "root")).toEqual([{ seed: "root", destination: false }])
    expect(botTargetsOf(call("send_agent", { to: "copy" }), "root")).toEqual([{ seed: "copy", destination: true }])
    expect(botTargetsOf(call("spawn_agent", {}, { id: "layout" }), "root")).toEqual([{ seed: "layout", destination: true }])
    expect(botTargetsOf(call("await_agents", { agentIds: ["layout", "copy", "layout"] }), "root")).toEqual([
      { seed: "layout", destination: true },
      { seed: "copy", destination: true }
    ])
  })

  test("parts: the code field comes out apart from the other inputs, and empty rests vanish", () => {
    const parts = partsOf(call("apply_styles", { css: "body{color:red}", persist: true }, { ok: true }))
    expect(parts.code).toEqual({ label: "css", language: "css", text: "body{color:red}" })
    expect(parts.inputs).toBe(JSON.stringify({ persist: true }, null, 2))
    expect(parts.result).toBe(JSON.stringify({ ok: true }, null, 2))
    expect(parts.summary).toBe("")

    const alone = partsOf(call("run_script", { js: "1" }))
    expect(alone.code?.language).toBe("javascript")
    expect(alone.inputs).toBeUndefined()
    expect(alone.result).toBeUndefined()

    const noCode = partsOf(call("read_styles", { selector: ".x" }))
    expect(noCode.code).toBeUndefined()
    expect(noCode.inputs).toBe(JSON.stringify({ selector: ".x" }, null, 2))
    expect(noCode.summary).toBe(".x")

    expect(partsOf(call("read_page", {})).inputs).toBeUndefined()
    expect(partsOf(call("read_page", undefined)).inputs).toBeUndefined()
  })

  test("a skin's files read as one TSX block, each under its path, and the row names the paths", () => {
    const parts = partsOf(call("write_skin", { files: [{ path: "page.tsx", content: "export default () => null" }, { path: "components/Row.tsx", content: "export const Row = () => null" }] }))
    expect(parts.code).toEqual({ label: "files", language: "tsx", text: "// page.tsx\nexport default () => null\n\n// components/Row.tsx\nexport const Row = () => null" })
    expect(parts.inputs).toBeUndefined()
    expect(parts.summary).toBe("page.tsx +1 file")
    expect(partsOf(call("write_skin", { files: [{ path: "page.tsx", content: "" }] })).summary).toBe("page.tsx")
    // A malformed files input is not code; it shows as JSON.
    expect(partsOf(call("write_skin", { files: [{ path: 1 }] })).code).toBeUndefined()
  })
})
