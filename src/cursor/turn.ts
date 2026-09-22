import {
  IDLE_TURN,
  type Step,
  type ToolStep,
  type TurnView
} from "../session/contract"
import type { CursorRunStatus } from "./api"

export type CursorTurnEvent =
  | { readonly _tag: "start"; readonly at: number }
  | { readonly _tag: "assistant"; readonly text: string }
  | { readonly _tag: "thinking"; readonly text: string }
  | { readonly _tag: "toolStarted"; readonly tool: ToolStep }
  | { readonly _tag: "toolFinished"; readonly tool: ToolStep }
  /** Cursor issued a tool call the relay has not delivered yet: the run is on a tool now. */
  | { readonly _tag: "toolAnnounced" }
  /** Cursor's own mark of a tool call that returned: text after it is a new segment. */
  | { readonly _tag: "boundary" }
  | { readonly _tag: "complete"; readonly text?: string }
  | { readonly _tag: "stop" }
  | { readonly _tag: "fail" }
  | { readonly _tag: "reset" }

export const initialCursorTurn = IDLE_TURN

/** Cursor's final reply when it has one, else the text the run streamed. */
export const cursorFinalText = (text: string | undefined, streamed: string): string =>
  text === undefined || text === "" ? streamed : text

/**
 * The answer a complete turn shows. `text` is the run's whole reply, from Cursor's
 * `result` frame or from everything the run streamed; `draft` is the segment streamed
 * after the last tool. Cursor's result joins every segment with no separator, so after a
 * tool it reads "...ask you first.You chose light." A reply that only wraps the last
 * segment shows that segment alone. A reply Cursor wrote as its own text does not end
 * with the draft and is shown as is.
 */
const answerOf = (text: string | undefined, draft: string): string => {
  const reply = cursorFinalText(text, draft)
  return draft !== "" && reply !== draft && reply.endsWith(draft) ? draft : reply
}

/** The turn transition a run status means, when it means one. */
export const terminalTurnEvent = (
  status: CursorRunStatus,
  text?: string
): CursorTurnEvent | undefined => {
  switch (status) {
    case "FINISHED":
      return { _tag: "complete", text }
    case "CANCELLED":
      return { _tag: "stop" }
    case "ERROR":
    case "EXPIRED":
      return { _tag: "fail" }
    case "CREATING":
    case "RUNNING":
      return undefined
  }
}

export const isCursorTurnActive = (turn: TurnView): boolean =>
  turn.phase === "starting" ||
  turn.phase === "thinking" ||
  turn.phase === "runningTool" ||
  turn.phase === "answering"

/** Read old Cursor histories with only the last assistant message in each turn as an answer. */
export const normalizeCursorTranscript = (
  steps: ReadonlyArray<Step>
): ReadonlyArray<Step> => {
  let hasAnswer = false
  let changed = false
  const normalized = [...steps]
  for (let index = normalized.length - 1; index >= 0; index -= 1) {
    const step = normalized[index]
    if (step?.kind === "user") {
      hasAnswer = false
      continue
    }
    if (step?.kind !== "assistant") continue
    if (!hasAnswer) {
      hasAnswer = true
      continue
    }
    normalized[index] = { kind: "thinking", text: step.text, at: step.at }
    changed = true
  }
  return changed ? normalized : steps
}

/** The only transition function for text and phase changes in one Cursor turn. */
export const reduceCursorTurn = (
  turn: TurnView,
  event: CursorTurnEvent
): TurnView => {
  switch (event._tag) {
    case "start":
      return { ...initialCursorTurn, phase: "starting", startedAt: event.at }
    case "assistant":
      return {
        ...turn,
        phase: turn.activeTool === undefined ? "answering" : "runningTool",
        activityText: turn.activityText + event.text,
        answerDraft: turn.activeTool === undefined ? turn.answerDraft + event.text : ""
      }
    case "thinking":
      return {
        ...turn,
        phase: turn.activeTool === undefined ? "thinking" : "runningTool",
        activityText: turn.activityText + event.text,
        answerDraft: ""
      }
    case "toolStarted":
      return {
        ...turn,
        phase: "runningTool",
        answerDraft: "",
        activeTool: event.tool
      }
    case "toolFinished":
      return {
        ...turn,
        phase: "starting",
        answerDraft: "",
        activeTool: undefined
      }
    case "toolAnnounced":
      return { ...turn, phase: "runningTool", answerDraft: "" }
    case "boundary":
      return { ...turn, answerDraft: "" }
    case "complete":
      return {
        ...turn,
        phase: "complete",
        finalAnswer: answerOf(event.text, turn.answerDraft),
        activeTool: undefined
      }
    case "stop":
      return { ...turn, phase: "stopped", answerDraft: "", activeTool: undefined }
    case "fail":
      return { ...turn, phase: "failed", answerDraft: "", activeTool: undefined }
    case "reset":
      return initialCursorTurn
  }
}
