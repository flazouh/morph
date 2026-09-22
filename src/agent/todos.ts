/**
 * The plan the model writes with `write_todos`. The tool checks the list; the panel
 * draws the last one on the turn.
 */

export const TODO_STATUSES = ["pending", "in-progress", "completed", "cancelled"] as const

export type TodoStatus = (typeof TODO_STATUSES)[number]

export interface Todo {
  readonly id: string
  readonly title: string
  readonly status: TodoStatus
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

const statusOf = (value: unknown): TodoStatus | undefined => {
  if (value === "in_progress") return "in-progress"
  return TODO_STATUSES.find((status) => status === value)
}

/** Well-formed items only. A broken item is dropped. */
export const todosFrom = (value: unknown): ReadonlyArray<Todo> => {
  const raw = isRecord(value) ? value["todos"] : undefined
  if (!Array.isArray(raw)) return []
  const todos: Todo[] = []
  for (const item of raw) {
    if (!isRecord(item)) continue
    const id = typeof item["id"] === "string" ? item["id"] : ""
    const title = typeof item["title"] === "string" ? item["title"] : ""
    const status = statusOf(item["status"])
    if (id === "" || title === "" || status === undefined) continue
    todos.push({ id, title, status })
  }
  return todos
}

export const parseTodos = (input: unknown): { readonly ok: true; readonly todos: ReadonlyArray<Todo> } | { readonly error: string } => {
  const raw = isRecord(input) ? input["todos"] : undefined
  if (!Array.isArray(raw) || raw.length === 0) return { error: "write_todos needs a non-empty todos array" }
  const todos = todosFrom(input)
  if (todos.length !== raw.length) {
    return { error: "each todo needs id, title and status (pending | in-progress | completed | cancelled)" }
  }
  return { ok: true, todos }
}
