import { todosFrom, type Todo } from "@/agent/todos"
import type { Step } from "@/session"

export const THINKING_LINES = 4

/** How many lines of thinking the activity keeps, from the end of the text. */
export const lastLines = (text: string, n = THINKING_LINES): string => {
  if (text === "") return ""
  const lines = text.split("\n")
  return lines.length <= n ? text : lines.slice(-n).join("\n")
}

export const thoughtText = (steps: ReadonlyArray<Step>): string =>
  steps
    .filter((step) => step.kind === "thinking")
    .map((step) => step.text)
    .join("\n")

/** The last write_todos on this turn. The result wins once it has landed. */
export const todosOf = (turn: ReadonlyArray<Step>): ReadonlyArray<Todo> => {
  for (let i = turn.length - 1; i >= 0; i--) {
    const step = turn[i]
    if (step?.kind !== "tool" || step.name !== "write_todos") continue
    const fromResult = todosFrom(step.result)
    return fromResult.length > 0 ? fromResult : todosFrom(step.input)
  }
  return []
}

/** The latest to-do state for the current turn. */
export const currentTodosOf = (steps: ReadonlyArray<Step>): ReadonlyArray<Todo> => {
  const start = steps.findLastIndex((step) => step.kind === "user")
  return todosOf(start < 0 ? steps : steps.slice(start))
}

/**
 * Whether this thread already published what it applied. A publish that landed turns the
 * offer to publish into a statement that it is done, so the row never asks twice.
 */
/**
 * Where the last successful write sits in the transcript, or -1. The panel compares it with
 * the point the reader took the look off: a write after that is a look the page wears again.
 */
export const lastAppliedAt = (steps: ReadonlyArray<Step>): number =>
  steps.findLastIndex((step) => step.kind === "tool" && succeeded(step.result) && applies(step.result))

const applies = (result: unknown): boolean =>
  typeof result === "object" && result !== null && "applied" in result && result.applied !== undefined

export const publishedIn = (steps: ReadonlyArray<Step>): boolean =>
  steps.some((step) => step.kind === "tool" && step.name === "publish_morph" && succeeded(step.result))

const succeeded = (result: unknown): boolean =>
  typeof result === "object" && result !== null && "ok" in result && result.ok === true
