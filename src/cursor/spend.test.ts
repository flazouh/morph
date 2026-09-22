import { describe, expect, test } from "bun:test"
import { Effect, Queue } from "effect"
import { memoryCursorStorage } from "./state"
import {
  json,
  kinds,
  liveStream,
  openCursorSession,
  said,
  until,
  within,
  type OpenOptions
} from "./testing"

/**
 * What a Cursor thread costs, as the panel reads it.
 *
 * Cursor prices an agent, not a run, and it answers with a cumulative total. So the
 * assertions here are about a snapshot that replaces the one before it, survives a
 * reopen, and never blocks a run: the usage read is the last thing a turn does, and a
 * Stop or a closing scope has to return without waiting for it.
 */

const open = (options: OpenOptions = {}) => openCursorSession(options)

describe("cursor spend", () => {
  test("the first successful usage response becomes the Cursor spend snapshot", async () => {
    const opened = await open({
      script: {
        usage: () =>
          json(200, {
            totalUsage: {
              inputTokens: 120,
              outputTokens: 30,
              cacheReadTokens: 400,
              cacheWriteTokens: 50,
              totalTokens: 600
            },
            runs: []
          })
      }
    })

    await opened.session.send("one")

    expect(opened.session.spend()).toEqual({
      provider: "cursor",
      usd: 0,
      promptTokens: 120,
      completionTokens: 30,
      cacheReadTokens: 400,
      cacheWriteTokens: 50,
      totalTokens: 600,
      priced: 0
    })
    expect(opened.calls.some((call) => call.url.endsWith("/v1/agents/bc-1/usage"))).toBe(true)
    await opened.close()
  })

  test("a later cumulative usage response replaces the old snapshot instead of adding it", async () => {
    const totals = [
      { inputTokens: 120, outputTokens: 30, cacheReadTokens: 400, cacheWriteTokens: 50, totalTokens: 600 },
      { inputTokens: 180, outputTokens: 45, cacheReadTokens: 700, cacheWriteTokens: 75, totalTokens: 1000 }
    ]
    const opened = await open({
      script: {
        usage: () => json(200, { totalUsage: totals.shift(), runs: [] })
      }
    })

    await opened.session.send("one")
    await opened.session.send("two")

    expect(opened.session.spend()).toMatchObject({
      provider: "cursor",
      promptTokens: 180,
      completionTokens: 45,
      cacheReadTokens: 700,
      cacheWriteTokens: 75
    })
    await opened.close()
  })

  test("Cursor spend persists with the thread and a reopened panel reads it", async () => {
    const storage = memoryCursorStorage()
    const first = await open({
      storage,
      script: {
        usage: () =>
          json(200, {
            totalUsage: {
              inputTokens: 120,
              outputTokens: 30,
              cacheReadTokens: 400,
              cacheWriteTokens: 50,
              totalTokens: 600
            },
            runs: []
          })
      }
    })
    await first.session.send("one")
    await first.close()

    const second = await open({ storage })

    expect(second.session.spend()).toEqual({
      provider: "cursor",
      usd: 0,
      promptTokens: 120,
      completionTokens: 30,
      cacheReadTokens: 400,
      cacheWriteTokens: 50,
      totalTokens: 600,
      priced: 0
    })
    await second.close()
  })

  test("a usage failure keeps the previous spend object and adds no error step", async () => {
    let reads = 0
    const opened = await open({
      script: {
        usage: () => {
          reads += 1
          return reads === 1
            ? json(200, {
                totalUsage: {
                  inputTokens: 120,
                  outputTokens: 30,
                  cacheReadTokens: 400,
                  cacheWriteTokens: 50,
                  totalTokens: 600
                },
                runs: []
              })
            : json(500, {
                error: {
                  code: "internal_error",
                  message: "request req-secret failed for token sk-secret"
                }
              })
        }
      }
    })
    await opened.session.send("one")
    const before = opened.session.spend()
    expect(before.promptTokens).toBe(120)

    await opened.session.send("two")

    expect(opened.session.spend()).toBe(before)
    expect(kinds(opened.session.steps()).filter((kind) => kind === "error")).toEqual([])
    expect(said(opened.session.steps()).at(-1)).toBe("assistant:Done.")
    await opened.close()
  })

  test("an unchanged usage response keeps the spend reference and sends no spend notification", async () => {
    const opened = await open({
      script: {
        usage: () =>
          json(200, {
            totalUsage: {
              inputTokens: 120,
              outputTokens: 30,
              cacheReadTokens: 400,
              cacheWriteTokens: 50,
              totalTokens: 600
            },
            runs: []
          })
      }
    })
    let spendChanges = 0
    let last = opened.session.spend()
    opened.session.subscribe(() => {
      const next = opened.session.spend()
      if (next !== last) {
        spendChanges += 1
        last = next
      }
    })

    await opened.session.send("one")
    const afterFirst = opened.session.spend()
    await opened.session.send("two")

    expect(spendChanges).toBe(1)
    expect(opened.session.spend()).toBe(afterFirst)
    await opened.close()
  })

  test("Stop returns while the usage endpoint is stalled and keeps the prior spend object", async () => {
    const live = liveStream()
    const opened = await open({
      script: {
        stream: (signal) => live.respond(signal),
        usage: (signal) =>
          new Promise<Response>((_, reject) => {
            signal?.addEventListener("abort", () => reject(new Error("usage aborted")), {
              once: true
            })
          })
      }
    })
    const before = opened.session.spend()
    const sending = opened.session.send("one")
    await until(() => opened.session.state() === "working", "the working run")

    live.push(`event: result\ndata: {"runId":"run-1","status":"FINISHED","text":"Done."}\n\n`)
    live.close()
    await until(
      () => opened.calls.some((call) => call.url.endsWith("/usage")),
      "the stalled usage request"
    )

    await within(opened.session.stop(), "Stop during stalled usage")
    await within(sending, "the stopped send")

    expect(opened.session.spend()).toBe(before)
    expect(kinds(opened.session.steps()).filter((kind) => kind === "error")).toEqual([])
    expect(opened.session.state()).toBe("idle")
    await opened.close()
  })

  test("scope close returns while the usage endpoint is stalled", async () => {
    const live = liveStream()
    const opened = await open({
      script: {
        stream: (signal) => live.respond(signal),
        usage: (signal) =>
          new Promise<Response>((_, reject) => {
            signal?.addEventListener("abort", () => reject(new Error("usage aborted")), {
              once: true
            })
          })
      }
    })
    const before = opened.session.spend()
    const sending = opened.session.send("one")
    await until(() => opened.session.state() === "working", "the working run")

    live.push(`event: result\ndata: {"runId":"run-1","status":"FINISHED","text":"Done."}\n\n`)
    live.close()
    await until(
      () => opened.calls.some((call) => call.url.endsWith("/usage")),
      "the stalled usage request"
    )

    await within(opened.close(), "scope close during stalled usage")
    await within(sending, "the closed send")
    expect(opened.session.spend()).toBe(before)
  })

  test("the tool gate closes before a pending usage response resolves", async () => {
    const live = liveStream()
    let resolveUsage: ((response: Response) => void) | undefined
    const opened = await open({
      script: {
        stream: (signal) => live.respond(signal),
        usage: () =>
          new Promise<Response>((resolve) => {
            resolveUsage = resolve
          })
      }
    })
    const sending = opened.session.send("one")
    await until(() => opened.session.state() === "working", "the working run")
    await until(() => opened.bridges.length > 0, "the relay bridge")

    live.push(`event: result\ndata: {"runId":"run-1","status":"FINISHED","text":"Done."}\n\n`)
    live.close()
    await until(() => resolveUsage !== undefined, "the pending usage response")

    await Effect.runPromise(
      Queue.offer(opened.bridges[0]!.incoming, {
        type: "request",
        id: "after-run",
        method: "tools/call",
        params: { name: "apply_styles", arguments: { css: "body{color:red}" } }
      })
    )
    await until(
      () => opened.bridges[0]!.sent.some((message) => message.type === "response" && message.id === "after-run"),
      "the closed-gate answer"
    )
    const answer = opened.bridges[0]!.sent.find(
      (message) => message.type === "response" && message.id === "after-run"
    )!
    expect(JSON.stringify(answer)).toContain("outside an open run")
    expect(opened.session.state()).toBe("idle")

    resolveUsage!(
      json(200, {
        totalUsage: {
          inputTokens: 120,
          outputTokens: 30,
          cacheReadTokens: 400,
          cacheWriteTokens: 50,
          totalTokens: 600
        },
        runs: []
      })
    )
    await within(sending, "the usage refresh")
    expect(opened.session.spend().promptTokens).toBe(120)
    await opened.close()
  })

  test("a subscriber defect during spend publication cannot wedge run cleanup", async () => {
    const opened = await open({
      script: {
        usage: () =>
          json(200, {
            totalUsage: {
              inputTokens: 120,
              outputTokens: 30,
              cacheReadTokens: 400,
              cacheWriteTokens: 50,
              totalTokens: 600
            },
            runs: []
          })
      }
    })
    opened.session.subscribe(() => {
      if (opened.session.spend().promptTokens > 0) throw new Error("broken subscriber")
    })

    await opened.session.send("one")

    expect(opened.session.state()).toBe("idle")
    expect(opened.session.spend().promptTokens).toBe(120)
    await opened.close()
  })
})
