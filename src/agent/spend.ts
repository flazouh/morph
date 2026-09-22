import type { Event } from "@clavia/tardigrade/core/event"
import { usageOf } from "@clavia/tardigrade/usage"
import { Schema } from "effect"
import type { Fetch } from "./eyes"
import { Provider } from "./provider"

/**
 * What a page's run has cost so far, read from the log. The runtime stamps each model
 * attempt's spend on the event that answered it (`ToolCalled`, `TurnCompleted`,
 * `TurnFailed`), so the log is the bill.
 *
 * `usd` is the sum of the attempts the provider priced. An attempt with tokens but no
 * price (a stream cut before its usage chunk) adds tokens and nothing else; the panel
 * then shows a figure that is a floor, never an invention.
 */
export const Spend = Schema.Struct({
  provider: Provider,
  usd: Schema.Number,
  promptTokens: Schema.Number,
  completionTokens: Schema.Number,
  cacheReadTokens: Schema.Number,
  cacheWriteTokens: Schema.Number,
  /**
   * The provider's own total, when the provider states one. Cursor does, and it is not
   * the sum of the classes above: Cursor decides what a cache read counts for. Absent for
   * OpenRouter, and absent from a Cursor record written before Morph kept it, so a reader
   * falls back to the sum rather than showing nothing.
   */
  totalTokens: Schema.optionalKey(Schema.Number),
  /** How many attempts carried a price. Zero with tokens means the provider never said. */
  priced: Schema.Number
})
export type Spend = typeof Spend.Type

export const NO_SPEND: Spend = {
  provider: "openrouter",
  usd: 0,
  promptTokens: 0,
  completionTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  priced: 0
}

export const NO_CURSOR_SPEND: Spend = { ...NO_SPEND, provider: "cursor" }

export const sameSpend = (left: Spend, right: Spend): boolean =>
  left.provider === right.provider &&
  left.usd === right.usd &&
  left.promptTokens === right.promptTokens &&
  left.completionTokens === right.completionTokens &&
  left.cacheReadTokens === right.cacheReadTokens &&
  left.cacheWriteTokens === right.cacheWriteTokens &&
  left.totalTokens === right.totalTokens &&
  left.priced === right.priced

export const spendOf = (log: ReadonlyArray<Event>): Spend => {
  let usd = 0
  let promptTokens = 0
  let completionTokens = 0
  let priced = 0
  for (const event of log) {
    const carried = (event as { usage?: unknown }).usage
    if (carried === undefined) continue
    const usage = usageOf(carried)
    promptTokens += usage.promptTokens
    completionTokens += usage.completionTokens
    if (usage.costUsd !== undefined) {
      usd += usage.costUsd
      priced += 1
    }
  }
  return {
    provider: "openrouter",
    usd,
    promptTokens,
    completionTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    priced
  }
}

/**
 * OpenRouter prices a response only when asked: `usage: { include: true }` on the request
 * makes the final stream chunk carry `usage.cost`, which the runtime reads as the billed
 * figure. This wraps the transport so every chat request asks.
 */
export const withUsageAccounting =
  (inner: Fetch): Fetch =>
  (input, init) => {
    if (typeof init?.body !== "string") return inner(input, init)
    let parsed: unknown
    try {
      parsed = JSON.parse(init.body)
    } catch {
      return inner(input, init)
    }
    if (parsed === null || typeof parsed !== "object" || !("messages" in parsed)) return inner(input, init)
    return inner(input, { ...init, body: JSON.stringify({ ...parsed, usage: { include: true } }) })
  }
