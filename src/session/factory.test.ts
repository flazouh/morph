import { describe, expect, test } from "bun:test"
import { DEFAULT_SETTINGS, type Session } from "./contract"
import { openProviderSession } from "./factory"

const named = (threadId: string): Session =>
  ({
    threadId,
    url: "https://x.test/page",
    steps: () => [],
    state: () => "idle",
    spend: () => ({ input: 0, output: 0, cost: 0, requests: 0 }),
    subscribe: () => () => {},
    send: async () => {},
    stop: async () => {},
    reset: async () => {},
    clear: async () => {},
    forgetPage: async () => {},
    forgetSite: async () => {}
  }) as unknown as Session

describe("provider session factory", () => {
  test("the Cursor provider opens the Cursor session and never the OpenRouter one", async () => {
    let openRouter = 0
    const session = await openProviderSession(
      { ...DEFAULT_SETTINGS, provider: "cursor" },
      {
        openrouter: async () => {
          openRouter += 1
          return named("openrouter")
        },
        cursor: async () => named("cursor")
      }
    )

    expect(session.threadId).toBe("cursor")
    expect(openRouter).toBe(0)
  })

  test("every other provider keeps the OpenRouter session", async () => {
    let cursor = 0
    const session = await openProviderSession(
      { ...DEFAULT_SETTINGS, provider: "openrouter" },
      {
        openrouter: async () => named("openrouter"),
        cursor: async () => {
          cursor += 1
          return named("cursor")
        }
      }
    )

    expect(session.threadId).toBe("openrouter")
    expect(cursor).toBe(0)
  })
})
