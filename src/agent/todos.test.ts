import { describe, expect, test } from "bun:test"
import { parseTodos, todosFrom } from "./todos"

describe("the plan list a write_todos call carries", () => {
  test("keeps well-formed items and treats in_progress as in-progress", () => {
    const input = {
      todos: [
        { id: "1", title: "Read the page", status: "in_progress" },
        { id: "2", title: "Restyle", status: "pending" }
      ]
    }
    expect(parseTodos(input)).toEqual({
      ok: true,
      todos: [
        { id: "1", title: "Read the page", status: "in-progress" },
        { id: "2", title: "Restyle", status: "pending" }
      ]
    })
    expect(todosFrom({ ok: true, todos: [{ id: "1", title: "Read the page", status: "completed" }] })).toEqual([
      { id: "1", title: "Read the page", status: "completed" }
    ])
  })

  test("refuses an empty or broken list", () => {
    expect(parseTodos({})).toEqual({ error: "write_todos needs a non-empty todos array" })
    expect(parseTodos({ todos: [] })).toEqual({ error: "write_todos needs a non-empty todos array" })
    expect(parseTodos({ todos: [{ id: "1", title: "x" }] })).toEqual({
      error: "each todo needs id, title and status (pending | in-progress | completed | cancelled)"
    })
  })
})
