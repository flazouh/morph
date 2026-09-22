import { describe, expect, test } from "bun:test"
import type { Event } from "@clavia/tardigrade/core/event"
import { stepsOf } from "./run"

const ev = (e: Record<string, unknown>): Event => ({ at: 1, ...e }) as unknown as Event

describe("stepsOf", () => {
  test("a user message, working text, a tool call joined to its return, and the final answer", () => {
    const steps = stepsOf([
      ev({ type: "MessageReceived", id: "m1", text: "make it dark" }),
      ev({ type: "ModelCalled", callId: "a" }),
      ev({ type: "TextReturned", text: "Reading the page." }),
      ev({ type: "ToolCalled", callId: "c1", name: "read_page", arguments: { selector: "main" } }),
      ev({ type: "ToolReturned", callId: "c1", result: { nodes: 3 } }),
      ev({ type: "ModelCalled", callId: "b" }),
      ev({ type: "TurnCompleted", output: "Done." })
    ])
    expect(steps).toEqual([
      { kind: "user", text: "make it dark", at: 1 },
      { kind: "thinking", text: "Reading the page.", at: 1 },
      { kind: "tool", callId: "c1", name: "read_page", input: { selector: "main" }, result: { nodes: 3 }, at: 1 },
      { kind: "assistant", text: "Done.", at: 1 }
    ])
  })

  test("a call with no return yet has no result field", () => {
    const [step] = stepsOf([ev({ type: "ToolCalled", callId: "c1", name: "apply_styles", arguments: { css: "a{}" } })])
    expect(step).toEqual({ kind: "tool", callId: "c1", name: "apply_styles", input: { css: "a{}" }, at: 1 })
    expect(step !== undefined && "result" in step).toBe(false)
  })

  test("a failed turn is an error step; an empty final output adds nothing", () => {
    expect(stepsOf([ev({ type: "TurnFailed", error: "model down" })])).toEqual([{ kind: "error", text: "model down", at: 1 }])
    expect(stepsOf([ev({ type: "TurnCompleted", output: "" })])).toEqual([])
  })

  test("two model calls with nothing between them show the reader a died attempt", () => {
    const steps = stepsOf([
      ev({ type: "MessageReceived", id: "m1", text: "go" }),
      ev({ type: "ModelCalled", callId: "a", at: 10_000 }),
      ev({ type: "ModelCalled", callId: "a", ordinal: 1, at: 200_000 }),
      ev({ type: "ModelCalled", callId: "a", ordinal: 2, at: 400_000 }),
      ev({ type: "TurnCompleted", output: "Done." })
    ])
    expect(steps).toEqual([
      { kind: "user", text: "go", at: 1 },
      { kind: "error", text: "The model's attempt died after 190s (cut off or timed out). Trying again (attempt 2).", at: 200_000 },
      { kind: "error", text: "The model's attempt died after 200s (cut off or timed out). Trying again (attempt 3).", at: 400_000 },
      { kind: "assistant", text: "Done.", at: 1 }
    ])
  })

  test("the final answer is not repeated when it equals the last working text", () => {
    const steps = stepsOf([ev({ type: "TextReturned", text: "Applied." }), ev({ type: "TurnCompleted", output: "Applied." })])
    expect(steps).toEqual([
      { kind: "thinking", text: "Applied.", at: 1 },
      { kind: "assistant", text: "Applied.", at: 1 }
    ])
  })

  test("events it does not draw are ignored", () => {
    expect(stepsOf([ev({ type: "ModelCalled", callId: "x" }), ev({ type: "ReplyDelivered", turn: "m1" }), ev({ type: "Whatever" })])).toEqual([])
  })
})
