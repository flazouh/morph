/**
 * What the panel and the service worker say to each other about a Cursor thread.
 *
 * The panel holds no Cursor state. It asks the background for a thread's view, and the
 * background pushes a new view after every change. Both sides decode what they receive:
 * an extension message channel carries every other feature's traffic too, and a message
 * from a stale panel or an older build must not be read as this one.
 */

import { Option, Schema } from "effect"
import { Spend } from "../agent/spend"
import { StepSchema, TurnViewSchema } from "../session/contract"

export const RunStateSchema = Schema.Literals(["idle", "working", "applied"])

/** One panel step, as the wire and the store both carry it. */
export const CursorStep = StepSchema

const Thread = { threadId: Schema.NonEmptyString }

/** The panel attaches to a thread. The background opens the live session if it has none. */
const Attach = Schema.Struct({
  type: Schema.Literal("cursor/attach"),
  ...Thread,
  url: Schema.NonEmptyString,
  tabId: Schema.Number
})

const Send = Schema.Struct({ type: Schema.Literal("cursor/send"), ...Thread, text: Schema.String })
const Stop = Schema.Struct({ type: Schema.Literal("cursor/stop"), ...Thread })
const Reset = Schema.Struct({ type: Schema.Literal("cursor/reset"), ...Thread })
const Clear = Schema.Struct({ type: Schema.Literal("cursor/clear"), ...Thread })
const ForgetPage = Schema.Struct({ type: Schema.Literal("cursor/forgetPage"), ...Thread })
const ForgetSite = Schema.Struct({ type: Schema.Literal("cursor/forgetSite"), ...Thread })
/** The reader closed the thread: archive the agent when possible and drop what was kept. */
const Close = Schema.Struct({ type: Schema.Literal("cursor/close"), ...Thread })
/** The reader answered a pending ask_user call. */
const AnswerQuestion = Schema.Struct({
  type: Schema.Literal("cursor/answer"),
  ...Thread,
  callId: Schema.String,
  optionIds: Schema.Array(Schema.String)
})
/**
 * The panel is done with this thread, but the reader is not: another provider is drawing
 * it now, or the page moved. The live session goes, whole. What it persisted stays, so
 * the way back in reads the same steps, the same agent, and the same spend.
 */
const Release = Schema.Struct({ type: Schema.Literal("cursor/release"), ...Thread })

export const CursorAsk = Schema.Union([
  Attach,
  Send,
  Stop,
  Reset,
  Clear,
  ForgetPage,
  ForgetSite,
  Close,
  Release,
  AnswerQuestion
])
export type CursorAsk = typeof CursorAsk.Type

/** Everything the panel draws of a thread. The answer and the push both carry it whole. */
const View = {
  ...Thread,
  steps: Schema.Array(CursorStep),
  turn: TurnViewSchema,
  state: RunStateSchema,
  spend: Spend
}

/** The whole view of a thread. Small enough to send after every change. */
export const CursorView = Schema.Struct({ type: Schema.Literal("cursor/view"), ...View })
export type CursorView = typeof CursorView.Type

/**
 * The background does not hold this thread. The panel attaches again and asks once more:
 * a service worker may be stopped between two messages.
 */
export const CursorUnknownThread = Schema.Struct({
  type: Schema.Literal("cursor/unknownThread"),
  ...Thread
})

export const CursorDone = Schema.Struct({ type: Schema.Literal("cursor/done"), ...Thread })

/** The run's own verdict on an answer: false means the question or the options were stale. */
export const CursorAnswered = Schema.Struct({
  type: Schema.Literal("cursor/answered"),
  ...Thread,
  accepted: Schema.Boolean
})

/** The background could not do it. `message` is safe to show; nothing else travels. */
export const CursorFailed = Schema.Struct({
  type: Schema.Literal("cursor/failed"),
  ...Thread,
  message: Schema.String
})

export const CursorAnswer = Schema.Union([CursorView, CursorUnknownThread, CursorDone, CursorAnswered, CursorFailed])
export type CursorAnswer = typeof CursorAnswer.Type

/** Pushed by the background after every change to a thread's steps or run state. */
export const CursorUpdate = Schema.Struct({ type: Schema.Literal("cursor/update"), ...View })
export type CursorUpdate = typeof CursorUpdate.Type

const askOf = Schema.decodeUnknownOption(CursorAsk)
const answerOf = Schema.decodeUnknownOption(CursorAnswer)
const updateOf = Schema.decodeUnknownOption(CursorUpdate)

export const decodeCursorAsk = (value: unknown): CursorAsk | undefined =>
  Option.getOrUndefined(askOf(value))

export const decodeCursorAnswer = (value: unknown): CursorAnswer | undefined =>
  Option.getOrUndefined(answerOf(value))

export const decodeCursorUpdate = (value: unknown): CursorUpdate | undefined =>
  Option.getOrUndefined(updateOf(value))

export const isCursorAsk = (value: unknown): value is CursorAsk => decodeCursorAsk(value) !== undefined
