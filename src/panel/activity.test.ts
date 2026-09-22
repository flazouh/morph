import { describe, expect, test } from "bun:test"
import type { Step } from "@/session"
import { lastLines, todosOf } from "./activity"

const tool = (name: string, result?: unknown, at = 2): Extract<Step, { kind: "tool" }> => ({
  kind: "tool",
  callId: name,
  name,
  input: name === "write_todos" ? { todos: [{ id: "1", title: "Inspect the page", status: "in-progress" }] } : {},
  ...(result === undefined ? {} : { result }),
  at
})

describe("thinking on screen", () => {
  test("keeps the last four lines", () => {
    expect(lastLines("one\ntwo\nthree\nfour\nfive\nsix")).toBe("three\nfour\nfive\nsix")
    expect(lastLines("short")).toBe("short")
    expect(lastLines("")).toBe("")
  })
})

describe("the plan drawn from the turn", () => {
  test("is the last write_todos list, from the result when it has landed", () => {
    const first = tool("write_todos", {
      ok: true,
      todos: [{ id: "1", title: "Inspect the page", status: "completed" }]
    })
    const second: Step = {
      ...tool("write_todos"),
      callId: "later",
      input: { todos: [{ id: "2", title: "Apply a dark canvas", status: "in-progress" }] }
    }
    expect(todosOf([first, second])).toEqual([{ id: "2", title: "Apply a dark canvas", status: "in-progress" }])
    expect(todosOf([tool("read_page")])).toEqual([])
  })
})
