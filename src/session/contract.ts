/**
 * What the side panel sees of a run, and nothing about how the run is made.
 *
 * The panel draws steps and sends text. The harness behind this seam decides how a
 * model is called, which tools exist, and where the log lives. Keeping the panel on
 * this side means the panel can be built and tested against a fake session.
 */

import { Effect, Option, Schema } from "effect"
import { Provider } from "../agent/provider"
import type { Spend } from "../agent/spend"

export { Provider } from "../agent/provider"
export type { Spend } from "../agent/spend"

const TextStep = <K extends "user" | "assistant" | "thinking" | "error">(kind: K) =>
  Schema.Struct({
    kind: Schema.Literal(kind),
    text: Schema.String,
    at: Schema.Number
  })

export const ToolStepSchema = Schema.Struct({
  kind: Schema.Literal("tool"),
  callId: Schema.String,
  name: Schema.String,
  input: Schema.Unknown,
  result: Schema.optionalKey(Schema.Unknown),
  at: Schema.Number
})

/** One transcript step, used by the store and every message seam. */
export const StepSchema = Schema.Union([
  TextStep("user"),
  TextStep("assistant"),
  TextStep("thinking"),
  TextStep("error"),
  ToolStepSchema
])
export type Step = typeof StepSchema.Type

/** The user half of a turn, for the places that insert a late answer after it. */
export type UserStep = Extract<Step, { kind: "user" }>

/**
 * `idle`: nothing running and nothing applied yet this session.
 * `working`: a turn is in flight.
 * `applied`: the last turn changed the page and the code was recorded.
 */
export type RunState = "idle" | "working" | "applied"

export const TurnPhase = Schema.Literals([
  "idle",
  "starting",
  "thinking",
  "runningTool",
  "answering",
  "complete",
  "stopped",
  "failed"
])
export type TurnPhase = typeof TurnPhase.Type

export type ToolStep = typeof ToolStepSchema.Type

/** The active turn, split by purpose so progress text can never become an answer bubble. */
export const TurnViewSchema = Schema.Struct({
  phase: TurnPhase,
  activityText: Schema.String,
  answerDraft: Schema.String,
  finalAnswer: Schema.String,
  activeTool: Schema.optionalKey(Schema.Union([ToolStepSchema, Schema.Undefined])),
  startedAt: Schema.Number
})
export type TurnView = typeof TurnViewSchema.Type

/** React external-store snapshots stay stable until one visible turn field changes. */
export const sameTurnView = (left: TurnView, right: TurnView): boolean =>
  left.phase === right.phase &&
  left.activityText === right.activityText &&
  left.answerDraft === right.answerDraft &&
  left.finalAnswer === right.finalAnswer &&
  left.startedAt === right.startedAt &&
  (left.activeTool === right.activeTool ||
    (left.activeTool?.callId === right.activeTool?.callId &&
      left.activeTool?.result === right.activeTool?.result))

export const IDLE_TURN: TurnView = {
  phase: "idle",
  activityText: "",
  answerDraft: "",
  finalAnswer: "",
  activeTool: undefined,
  startedAt: 0
}

/** `system` follows the OS. `light` and `dark` hold the panel on one palette. */
export const ThemeChoice = Schema.Literals(["system", "light", "dark"])
export type ThemeChoice = typeof ThemeChoice.Type

/** Panel text scale. `default` is the built-in size. */
export const FontSize = Schema.Literals(["small", "default", "large"])
export type FontSize = typeof FontSize.Type

const SETTINGS_DEFAULTS = {
  provider: "openrouter",
  openRouterKey: "",
  cursorKey: "",
  model: "moonshotai/kimi-k3",
  cursorModel: "",
  theme: "system",
  fontSize: "default"
} as const

const defaultString = (value: string) =>
  Schema.String.pipe(
    Schema.catchDecoding(() => Effect.succeed(Option.some(value))),
    Schema.withDecodingDefaultKey(Effect.succeed(value))
  )

const defaultNonEmptyString = (value: string) =>
  Schema.NonEmptyString.pipe(
    Schema.catchDecoding(() => Effect.succeed(Option.some(value))),
    Schema.withDecodingDefaultKey(Effect.succeed(value))
  )

/** Persisted settings. Each field decodes independently so one old or invalid field cannot erase the others. */
export const SettingsSchema = Schema.Struct({
  provider: Provider.pipe(
    Schema.catchDecoding(() => Effect.succeed(Option.some<Provider>(SETTINGS_DEFAULTS.provider))),
    Schema.withDecodingDefaultKey(Effect.succeed<Provider>(SETTINGS_DEFAULTS.provider))
  ),
  openRouterKey: defaultString(SETTINGS_DEFAULTS.openRouterKey),
  cursorKey: defaultString(SETTINGS_DEFAULTS.cursorKey),
  /** OpenRouter model. Kept as `model` for stored-settings and runtime compatibility. */
  model: defaultNonEmptyString(SETTINGS_DEFAULTS.model),
  cursorModel: defaultString(SETTINGS_DEFAULTS.cursorModel),
  /** The panel palette. `system` follows the OS. */
  theme: ThemeChoice.pipe(
    Schema.catchDecoding(() => Effect.succeed(Option.some<ThemeChoice>(SETTINGS_DEFAULTS.theme))),
    Schema.withDecodingDefaultKey(Effect.succeed<ThemeChoice>(SETTINGS_DEFAULTS.theme))
  ),
  /** The panel text scale. */
  fontSize: FontSize.pipe(
    Schema.catchDecoding(() => Effect.succeed(Option.some<FontSize>(SETTINGS_DEFAULTS.fontSize))),
    Schema.withDecodingDefaultKey(Effect.succeed<FontSize>(SETTINGS_DEFAULTS.fontSize))
  )
}).pipe(
  Schema.catchDecoding(() => Effect.succeed(Option.some(SETTINGS_DEFAULTS)))
)

export type Settings = typeof SettingsSchema.Type

export const DEFAULT_SETTINGS: Settings = SETTINGS_DEFAULTS

export interface Session {
  /** The thread keeps its log while the active page changes. */
  readonly threadId: string
  /** The page this session currently acts on. */
  readonly url: string
  /** Send one user message and run the turn to its end. Resolves when the turn settles. */
  readonly send: (text: string) => Promise<void>
  /** Stop the active turn and keep work that already settled. */
  readonly stop: () => Promise<void>
  /**
   * Answer a pending ask_user tool call. False means the question or selection is stale.
   * A promise, because the run that holds the question may live in the service worker.
   */
  readonly answerQuestion: (callId: string, optionIds: ReadonlyArray<string>) => Promise<boolean>
  readonly steps: () => ReadonlyArray<Step>
  /** The current or most recent turn phase. Text fields keep activity and answers separate. */
  readonly turn: () => TurnView
  readonly state: () => RunState
  /** What this page's run has cost so far. Stable between changes, like `steps()`. */
  readonly spend: () => Spend
  /** Called after any change to steps or state. Returns the unsubscribe. */
  readonly subscribe: (listener: () => void) => () => void
  /** Forget this tab's run: log, applied code, everything. */
  readonly reset: () => Promise<void>
  /** Drop this thread's chat. The page and site looks stay. */
  readonly clear: () => Promise<void>
  /** Take this page's restyle off. The chat and the site's look stay. */
  readonly forgetPage: () => Promise<void>
  /** Take this site's restyle off every page of the host. The chat stays. */
  readonly forgetSite: () => Promise<void>
  /**
   * The panel is done with this session: it switched provider, the page moved, or this
   * session was replaced. Everything the session holds outside the panel goes, and
   * everything it persisted stays, so opening the thread again finds it where it was.
   *
   * Optional, because a session that holds nothing outside the panel has nothing to give
   * back. A caller drops a session it disposed and never asks it anything again. Calling
   * it twice is allowed and does nothing the second time: the panel can reach the same
   * session under two keys, and a render can repeat.
   */
  readonly dispose?: () => Promise<void>
}

export interface SettingsStore {
  readonly read: () => Promise<Settings>
  readonly write: (patch: Partial<Settings>) => Promise<Settings>
  readonly subscribe: (listener: (settings: Settings) => void) => () => void
}
