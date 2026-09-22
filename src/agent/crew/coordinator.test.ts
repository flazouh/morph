import { describe, expect, test } from "bun:test"
import { MAX_AGENTS, MAX_DEPTH } from "./events"
import { createCrew, CrewError } from "./coordinator"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const setup = () => {
  const crew = createCrew()
  return crew
}

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

describe("createCrew: empty", () => {
  test("starts with no agents, no messages, not stopped", () => {
    const crew = setup()
    const s = crew.state()
    expect(s.agents.size).toBe(0)
    expect(s.mailboxes.size).toBe(0)
    expect(s.stopped).toBe(false)
    expect(crew.totalSpend()).toBe(0)
    expect(crew.events()).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// spawnAgent
// ---------------------------------------------------------------------------

describe("spawnAgent", () => {
  test("spawns a root agent with working status", () => {
    const crew = setup()
    crew.spawnAgent("a", null)
    const agent = crew.state().agents.get("a")
    expect(agent?.status).toBe("working")
    expect(agent?.parentId).toBeNull()
    expect(agent?.depth).toBe(0)
  })

  test("spawns a child agent with correct depth", () => {
    const crew = setup()
    crew.spawnAgent("root", null)
    crew.spawnAgent("child", "root")
    expect(crew.state().agents.get("child")?.depth).toBe(1)
  })

  test("grandchild reaches depth 2", () => {
    const crew = setup()
    crew.spawnAgent("root", null)
    crew.spawnAgent("child", "root")
    crew.spawnAgent("grand", "child")
    expect(crew.state().agents.get("grand")?.depth).toBe(2)
  })

  test("throws when total agents would exceed MAX_AGENTS", () => {
    const crew = setup()
    for (let i = 0; i < MAX_AGENTS; i++) crew.spawnAgent(`a${i}`, null)
    expect(() => crew.spawnAgent("overflow", null)).toThrow(CrewError)
  })

  test("a finished bot frees one active slot for a new bot", () => {
    const crew = setup()
    crew.spawnAgent("root", null)
    crew.spawnAgent("a", "root")
    crew.spawnAgent("b", "root")
    crew.spawnAgent("c", "root")
    crew.setStatus("a", "done")

    expect(() => crew.spawnAgent("next", "root")).not.toThrow()
    expect(crew.state().agents.get("next")?.status).toBe("working")
  })

  test("MAX_AGENTS constant is 4", () => {
    expect(MAX_AGENTS).toBe(4)
  })

  test("throws on duplicate agent ID", () => {
    const crew = setup()
    crew.spawnAgent("a", null)
    expect(() => crew.spawnAgent("a", null)).toThrow(CrewError)
  })

  test("throws when depth would exceed MAX_DEPTH", () => {
    const crew = setup()
    crew.spawnAgent("d0", null)           // depth 0
    crew.spawnAgent("d1", "d0")           // depth 1
    crew.spawnAgent("d2", "d1")           // depth 2 = MAX_DEPTH, ok
    expect(() => crew.spawnAgent("d3", "d2")).toThrow(CrewError)
  })

  test("MAX_DEPTH constant is 2", () => {
    expect(MAX_DEPTH).toBe(2)
  })

  test("throws when parent is terminal", () => {
    const crew = setup()
    crew.spawnAgent("a", null)
    crew.setStatus("a", "done")
    expect(() => crew.spawnAgent("b", "a")).toThrow(CrewError)
  })

  test("throws when parent does not exist", () => {
    const crew = setup()
    expect(() => crew.spawnAgent("b", "ghost")).toThrow(CrewError)
  })

  test("throws after crew is stopped", () => {
    const crew = setup()
    crew.stop()
    expect(() => crew.spawnAgent("a", null)).toThrow(CrewError)
  })
})

// ---------------------------------------------------------------------------
// setStatus
// ---------------------------------------------------------------------------

describe("setStatus", () => {
  test("transitions an agent through all statuses", () => {
    const crew = setup()
    crew.spawnAgent("a", null)
    for (const s of ["waiting", "working", "done"] as const) {
      crew.setStatus("a", s)
      expect(crew.state().agents.get("a")?.status).toBe(s)
    }
  })

  test("throws for unknown agent", () => {
    const crew = setup()
    expect(() => crew.setStatus("ghost", "done")).toThrow(CrewError)
  })
})

// ---------------------------------------------------------------------------
// sendMessage / readMailbox
// ---------------------------------------------------------------------------

describe("sendMessage", () => {
  test("queues a message in recipient mailbox", () => {
    const crew = setup()
    crew.spawnAgent("a", null)
    crew.spawnAgent("b", null)
    crew.sendMessage("m1", "a", "b", "hello")
    const s = crew.state()
    expect(s.mailboxes.get("b")?.messages).toHaveLength(1)
    expect(s.mailboxes.get("b")?.messages[0]?.payload).toBe("hello")
  })

  test("does not trigger recipient execution", () => {
    const crew = setup()
    crew.spawnAgent("a", null)
    crew.spawnAgent("b", null)
    crew.sendMessage("m1", "a", "b", "ping")
    // Status remains working; no side-effect execution
    expect(crew.state().agents.get("b")?.status).toBe("working")
  })

  test("throws when crew is stopped", () => {
    const crew = setup()
    crew.spawnAgent("a", null)
    crew.spawnAgent("b", null)
    crew.stop()
    expect(() => crew.sendMessage("m1", "a", "b", "x")).toThrow(CrewError)
  })

  test("throws when sender does not exist", () => {
    const crew = setup()
    crew.spawnAgent("b", null)
    expect(() => crew.sendMessage("m1", "ghost", "b", "x")).toThrow(CrewError)
  })

  test("throws when recipient does not exist", () => {
    const crew = setup()
    crew.spawnAgent("a", null)
    expect(() => crew.sendMessage("m1", "a", "ghost", "x")).toThrow(CrewError)
  })

  test("a duplicate message ID is rejected before it reaches the mailbox", () => {
    const crew = setup()
    crew.spawnAgent("a", null)
    crew.spawnAgent("b", null)
    crew.sendMessage("dup", "a", "b", "first")
    expect(() => crew.sendMessage("dup", "a", "b", "second")).toThrow(
      'message "dup" already exists'
    )
    expect(crew.state().mailboxes.get("b")?.messages).toHaveLength(1)
  })
})

describe("readMailbox", () => {
  test("returns empty array when agent has no messages", () => {
    const crew = setup()
    crew.spawnAgent("a", null)
    expect(crew.readMailbox("a")).toEqual([])
  })

  test("returns empty array for unknown agent", () => {
    const crew = setup()
    expect(crew.readMailbox("ghost")).toEqual([])
  })

  test("returns unread messages in send order", () => {
    const crew = setup()
    crew.spawnAgent("a", null)
    crew.spawnAgent("b", null)
    crew.sendMessage("m1", "a", "b", "first")
    crew.sendMessage("m2", "a", "b", "second")
    const msgs = crew.readMailbox("b")
    expect(msgs.map((m) => m.payload)).toEqual(["first", "second"])
  })

  test("second read returns only messages sent after the first read", () => {
    const crew = setup()
    crew.spawnAgent("a", null)
    crew.spawnAgent("b", null)
    crew.sendMessage("m1", "a", "b", "old")
    crew.readMailbox("b")
    crew.sendMessage("m2", "a", "b", "new")
    const second = crew.readMailbox("b")
    expect(second.map((m) => m.payload)).toEqual(["new"])
  })

  test("third read with no new messages returns empty", () => {
    const crew = setup()
    crew.spawnAgent("a", null)
    crew.spawnAgent("b", null)
    crew.sendMessage("m1", "a", "b", "x")
    crew.readMailbox("b")
    expect(crew.readMailbox("b")).toEqual([])
  })

  test("cursor advances per-agent independently", () => {
    const crew = setup()
    crew.spawnAgent("a", null)
    crew.spawnAgent("b", null)
    crew.spawnAgent("c", null)
    crew.sendMessage("m1", "a", "b", "for-b")
    crew.sendMessage("m2", "a", "c", "for-c")
    crew.readMailbox("b")
    // c mailbox cursor not advanced
    const cMsgs = crew.readMailbox("c")
    expect(cMsgs.map((m) => m.payload)).toEqual(["for-c"])
  })

  test("reading advances state cursor event in log", () => {
    const crew = setup()
    crew.spawnAgent("a", null)
    crew.spawnAgent("b", null)
    crew.sendMessage("m1", "a", "b", "hi")
    const before = crew.events().length
    crew.readMailbox("b")
    expect(crew.events().length).toBe(before + 1)
    expect(crew.events().at(-1)?.type).toBe("CursorAdvanced")
  })

  test("read with no new messages does not append a CursorAdvanced event", () => {
    const crew = setup()
    crew.spawnAgent("a", null)
    const before = crew.events().length
    crew.readMailbox("a") // no messages
    expect(crew.events().length).toBe(before)
  })
})

// ---------------------------------------------------------------------------
// waitFor
// ---------------------------------------------------------------------------

describe("waitFor", () => {
  test("empty selection is immediately ready with no outputs", () => {
    const crew = setup()
    const result = crew.waitFor([])
    expect(result.ready).toBe(true)
    expect(result.outputs.size).toBe(0)
  })

  test("not ready while an agent is still working", () => {
    const crew = setup()
    crew.spawnAgent("a", null)
    expect(crew.waitFor(["a"]).ready).toBe(false)
  })

  test("not ready when one of many agents is non-terminal", () => {
    const crew = setup()
    crew.spawnAgent("a", null)
    crew.spawnAgent("b", null)
    crew.setStatus("a", "done")
    expect(crew.waitFor(["a", "b"]).ready).toBe(false)
  })

  test("ready when all selected agents are terminal", () => {
    const crew = setup()
    crew.spawnAgent("a", null)
    crew.spawnAgent("b", null)
    crew.setStatus("a", "done")
    crew.setStatus("b", "failed")
    const result = crew.waitFor(["a", "b"])
    expect(result.ready).toBe(true)
    expect(result.outputs.has("a")).toBe(true)
    expect(result.outputs.has("b")).toBe(true)
  })

  test("outputs map includes written output when ready", () => {
    const crew = setup()
    crew.spawnAgent("a", null)
    crew.writeOutput("a", "result")
    crew.setStatus("a", "done")
    const result = crew.waitFor(["a"])
    expect(result.ready).toBe(true)
    expect(result.outputs.get("a")).toBe("result")
  })

  test("output is undefined for terminal agent that never wrote", () => {
    const crew = setup()
    crew.spawnAgent("a", null)
    crew.setStatus("a", "done")
    const result = crew.waitFor(["a"])
    expect(result.ready).toBe(true)
    expect(result.outputs.get("a")).toBeUndefined()
  })

  test("not ready for unknown agent id", () => {
    const crew = setup()
    expect(crew.waitFor(["ghost"]).ready).toBe(false)
  })

  test("outputs are empty map when not ready", () => {
    const crew = setup()
    crew.spawnAgent("a", null)
    const result = crew.waitFor(["a"])
    expect(result.ready).toBe(false)
    expect(result.outputs.size).toBe(0)
  })
})

describe("awaitAgents", () => {
  test("resolves immediately when every selected agent is already terminal", async () => {
    const crew = setup()
    crew.spawnAgent("a", null)
    crew.writeOutput("a", "finished")
    crew.setStatus("a", "done")

    const result = await crew.awaitAgents(["a"])

    expect(result.outputs.get("a")).toBe("finished")
  })

  test("stays pending without polling and resolves when the last agent finishes", async () => {
    const crew = setup()
    crew.spawnAgent("a", null)
    crew.spawnAgent("b", null)
    let settled = false
    const waiting = crew.awaitAgents(["a", "b"]).then((result) => {
      settled = true
      return result
    })

    crew.writeOutput("a", "first")
    crew.setStatus("a", "done")
    await Promise.resolve()
    expect(settled).toBe(false)

    crew.writeOutput("b", "second")
    crew.setStatus("b", "done")
    const result = await waiting
    expect([...result.outputs]).toEqual([
      ["a", "first"],
      ["b", "second"],
    ])
  })
})

// ---------------------------------------------------------------------------
// writeOutput
// ---------------------------------------------------------------------------

describe("writeOutput", () => {
  test("stores output on agent", () => {
    const crew = setup()
    crew.spawnAgent("a", null)
    crew.writeOutput("a", "done text")
    expect(crew.state().agents.get("a")?.output).toBe("done text")
  })

  test("throws when crew is stopped", () => {
    const crew = setup()
    crew.spawnAgent("a", null)
    crew.stop()
    expect(() => crew.writeOutput("a", "x")).toThrow(CrewError)
  })

  test("throws for unknown agent", () => {
    const crew = setup()
    expect(() => crew.writeOutput("ghost", "x")).toThrow(CrewError)
  })
})

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

describe("stop", () => {
  test("marks crew stopped", () => {
    const crew = setup()
    crew.stop()
    expect(crew.state().stopped).toBe(true)
  })

  test("marks all non-terminal agents as stopped", () => {
    const crew = setup()
    crew.spawnAgent("a", null)
    crew.spawnAgent("b", null)
    crew.setStatus("b", "done")
    crew.stop()
    expect(crew.state().agents.get("a")?.status).toBe("stopped")
    expect(crew.state().agents.get("b")?.status).toBe("done")
  })

  test("is idempotent (second stop does not append another event)", () => {
    const crew = setup()
    crew.stop()
    const count = crew.events().length
    crew.stop()
    expect(crew.events().length).toBe(count)
  })

  test("blocks spawnAgent after stop", () => {
    const crew = setup()
    crew.stop()
    expect(() => crew.spawnAgent("a", null)).toThrow(CrewError)
  })

  test("blocks sendMessage after stop", () => {
    const crew = setup()
    crew.spawnAgent("a", null)
    crew.spawnAgent("b", null)
    crew.stop()
    expect(() => crew.sendMessage("m1", "a", "b", "x")).toThrow(CrewError)
  })

  test("blocks writeOutput after stop", () => {
    const crew = setup()
    crew.spawnAgent("a", null)
    crew.stop()
    expect(() => crew.writeOutput("a", "x")).toThrow(CrewError)
  })
})

// ---------------------------------------------------------------------------
// spend
// ---------------------------------------------------------------------------

describe("spend", () => {
  test("totalSpend is zero with no records", () => {
    const crew = setup()
    expect(crew.totalSpend()).toBe(0)
  })

  test("agentSpend returns 0 for agent with no records", () => {
    const crew = setup()
    crew.spawnAgent("a", null)
    expect(crew.agentSpend("a")).toBe(0)
  })

  test("accumulates spend per agent", () => {
    const crew = setup()
    crew.spawnAgent("a", null)
    crew.recordSpend("a", 1.0)
    crew.recordSpend("a", 0.5)
    expect(crew.agentSpend("a")).toBeCloseTo(1.5)
  })

  test("totalSpend sums across agents", () => {
    const crew = setup()
    crew.spawnAgent("a", null)
    crew.spawnAgent("b", null)
    crew.recordSpend("a", 3)
    crew.recordSpend("b", 7)
    expect(crew.totalSpend()).toBe(10)
  })

  test("throws recordSpend for unknown agent", () => {
    const crew = setup()
    expect(() => crew.recordSpend("ghost", 1)).toThrow(CrewError)
  })

  test("spend is not affected by stop", () => {
    const crew = setup()
    crew.spawnAgent("a", null)
    crew.recordSpend("a", 5)
    crew.stop()
    expect(crew.agentSpend("a")).toBe(5)
    expect(crew.totalSpend()).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// subscribe
// ---------------------------------------------------------------------------

describe("subscribe", () => {
  test("fires callback on every event", () => {
    const crew = setup()
    let calls = 0
    crew.subscribe(() => { calls++ })
    crew.spawnAgent("a", null)
    crew.setStatus("a", "done")
    expect(calls).toBe(2)
  })

  test("unsubscribe stops further callbacks", () => {
    const crew = setup()
    let calls = 0
    const unsub = crew.subscribe(() => { calls++ })
    crew.spawnAgent("a", null)
    unsub()
    crew.setStatus("a", "done")
    expect(calls).toBe(1)
  })

  test("multiple subscribers all fire", () => {
    const crew = setup()
    let a = 0
    let b = 0
    crew.subscribe(() => { a++ })
    crew.subscribe(() => { b++ })
    crew.spawnAgent("x", null)
    expect(a).toBe(1)
    expect(b).toBe(1)
  })

  test("subscriber receives current state via state() after callback", () => {
    const crew = setup()
    let seenStatus: string | undefined
    crew.subscribe(() => {
      seenStatus = crew.state().agents.get("a")?.status
    })
    crew.spawnAgent("a", null)
    expect(seenStatus).toBe("working")
  })
})

// ---------------------------------------------------------------------------
// events snapshot
// ---------------------------------------------------------------------------

describe("events()", () => {
  test("returns a snapshot; mutations to returned array do not affect internal log", () => {
    const crew = setup()
    crew.spawnAgent("a", null)
    const snap = crew.events() as Array<unknown>
    snap.push({ type: "fake" })
    expect(crew.events()).toHaveLength(1)
  })
})
