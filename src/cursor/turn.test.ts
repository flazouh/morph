import { describe, expect, test } from "bun:test"
import {
  cursorFinalText,
  initialCursorTurn,
  normalizeCursorTranscript,
  reduceCursorTurn,
  type CursorTurnEvent
} from "./turn"
import type { TurnView } from "../session/contract"

describe("the Cursor turn reducer", () => {
  test("keeps streamed assistant narration as activity until the terminal result", () => {
    const started = reduceCursorTurn(initialCursorTurn, { _tag: "start", at: 10 })
    const narrated = reduceCursorTurn(started, {
      _tag: "assistant",
      text: "I will inspect the page first."
    })
    const thinking = reduceCursorTurn(narrated, {
      _tag: "thinking",
      text: "Reading the page structure."
    })

    expect(thinking).toEqual({
      phase: "thinking",
      activityText: "I will inspect the page first.Reading the page structure.",
      answerDraft: "",
      finalAnswer: "",
      activeTool: undefined,
      startedAt: 10
    })

    expect(
      reduceCursorTurn(thinking, {
        _tag: "complete",
        text: "I restyled the page."
      })
    ).toEqual({
      phase: "complete",
      activityText: "I will inspect the page first.Reading the page structure.",
      answerDraft: "",
      finalAnswer: "I restyled the page.",
      activeTool: undefined,
      startedAt: 10
    })
  })

  test("tool start and finish are explicit transitions", () => {
    const tool = {
      kind: "tool" as const,
      callId: "call-1",
      name: "read_page",
      input: { selector: "body" },
      at: 20
    }
    const running = reduceCursorTurn(
      reduceCursorTurn(initialCursorTurn, { _tag: "start", at: 10 }),
      { _tag: "toolStarted", tool }
    )

    expect(running).toMatchObject({
      phase: "runningTool",
      answerDraft: "",
      activeTool: tool
    })
    expect(
      reduceCursorTurn(running, {
        _tag: "toolFinished",
        tool: { ...tool, result: { nodes: 3 } }
      })
    ).toMatchObject({
      phase: "starting",
      activeTool: undefined
    })
  })

  test("Cursor's announced tool call is running tools with no tool in hand, and its text so far is not an answer", () => {
    const announced = [
      { _tag: "start", at: 10 },
      { _tag: "assistant", text: "I'll write the skin." },
      { _tag: "toolAnnounced" }
    ].reduce<TurnView>((turn, event) => reduceCursorTurn(turn, event as CursorTurnEvent), initialCursorTurn)
    expect(announced).toMatchObject({ phase: "runningTool", answerDraft: "", activeTool: undefined, activityText: "I'll write the skin." })

    const tool = { kind: "tool" as const, callId: "call-1", name: "write_skin", input: {}, at: 20 }
    const running = reduceCursorTurn(announced, { _tag: "toolStarted", tool })
    // The frame may land after the relay call as well; the tool in hand stays.
    expect(reduceCursorTurn(running, { _tag: "toolAnnounced" })).toMatchObject({ phase: "runningTool", activeTool: tool })
  })

  test("a result that glues narration before a tool onto the segment after it completes with that segment", () => {
    const tool = { kind: "tool" as const, callId: "ask", name: "ask_user", input: {}, at: 20 }
    const afterTool = [
      { _tag: "start", at: 10 },
      { _tag: "assistant", text: "I will ask you first." },
      { _tag: "toolStarted", tool },
      { _tag: "toolFinished", tool: { ...tool, result: { answer: "light" } } },
      { _tag: "assistant", text: "You chose a light header." }
    ].reduce<TurnView>((turn, event) => reduceCursorTurn(turn, event as CursorTurnEvent), initialCursorTurn)
    expect(afterTool.answerDraft).toBe("You chose a light header.")

    const complete = (text: string | undefined) => reduceCursorTurn(afterTool, { _tag: "complete", text }).finalAnswer
    // Cursor's `result` frame joins every assistant segment with no separator.
    expect(complete("I will ask you first.You chose a light header.")).toBe("You chose a light header.")
    expect(complete("You chose a light header.")).toBe("You chose a light header.")
    expect(complete("A summary Cursor wrote itself.")).toBe("A summary Cursor wrote itself.")
    expect(complete("")).toBe("You chose a light header.")
    expect(complete(undefined)).toBe("You chose a light header.")
  })

  test("cursorFinalText prefers the result text and falls back to the streamed text", () => {
    expect(cursorFinalText("Done.", "streamed")).toBe("Done.")
    expect(cursorFinalText("", "streamed")).toBe("streamed")
    expect(cursorFinalText(undefined, "streamed")).toBe("streamed")
  })

  test("old progress narration becomes thinking while the last answer stays an answer", () => {
    expect(
      normalizeCursorTranscript([
        { kind: "user", text: "Restyle it.", at: 1 },
        { kind: "assistant", text: "I will inspect the page.", at: 2 },
        { kind: "tool", callId: "read", name: "read_page", input: {}, result: {}, at: 3 },
        { kind: "assistant", text: "Done.", at: 4 }
      ])
    ).toEqual([
      { kind: "user", text: "Restyle it.", at: 1 },
      { kind: "thinking", text: "I will inspect the page.", at: 2 },
      { kind: "tool", callId: "read", name: "read_page", input: {}, result: {}, at: 3 },
      { kind: "assistant", text: "Done.", at: 4 }
    ])
  })
})
