import { describe, expect, test } from "bun:test"
import type { Event } from "@clavia/tardigrade/core/event"
import { NO_SPEND, spendOf, withUsageAccounting } from "./spend"

const ev = (usage?: unknown): Event => ({ type: "TurnCompleted", output: "", at: 1, ...(usage === undefined ? {} : { usage }) }) as Event

describe("spendOf", () => {
  test("an empty log, or one whose events carry no usage, costs nothing", () => {
    expect(spendOf([])).toEqual(NO_SPEND)
    expect(spendOf([{ type: "MessageReceived", id: "m", text: "hi", at: 1 } as Event])).toEqual(NO_SPEND)
  })

  test("prices sum across events; an attempt without a price adds its tokens only", () => {
    const log = [
      ev({ promptTokens: 100, completionTokens: 20, costUsd: 0.002, costSource: "provider" }),
      ev({ promptTokens: 50, completionTokens: 5 }),
      ev({ promptTokens: 200, completionTokens: 40, costUsd: 0.001, costSource: "table" })
    ]
    expect(spendOf(log)).toEqual({
      provider: "openrouter",
      usd: 0.003,
      promptTokens: 350,
      completionTokens: 65,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      priced: 2
    })
  })

  test("a malformed usage counts as zero, not as a crash", () => {
    expect(spendOf([ev("garbage"), ev({ costUsd: "free" }), ev(null)])).toEqual(NO_SPEND)
  })
})

describe("withUsageAccounting", () => {
  const seen: Array<unknown> = []
  const inner = (_: unknown, init?: RequestInit) => {
    seen.push(init?.body)
    return Promise.resolve(new Response("ok"))
  }
  const wrapped = withUsageAccounting(inner as never)

  test("asks OpenRouter to price a chat request", async () => {
    await wrapped("https://x", { method: "POST", body: JSON.stringify({ model: "m", messages: [] }) })
    expect(JSON.parse(String(seen.at(-1)))).toEqual({ model: "m", messages: [], usage: { include: true } })
  })

  test("leaves everything that is not a chat request alone", async () => {
    await wrapped("https://x", { method: "GET" })
    await wrapped("https://x", { method: "POST", body: "not json" })
    await wrapped("https://x", { method: "POST", body: JSON.stringify({ tree: [] }) })
    expect(seen.slice(-3)).toEqual([undefined, "not json", JSON.stringify({ tree: [] })])
  })
})
