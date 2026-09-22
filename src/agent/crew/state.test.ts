import { describe, expect, test } from "bun:test"
import { applyOne, INITIAL_STATE, isTerminal, project } from "./state"
import type { CrewEvent } from "./events"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const spawn = (agentId: string, parentId: string | null = null, depth = 0): CrewEvent => ({
  type: "AgentSpawned",
  agentId,
  parentId,
  depth,
})

const status = (agentId: string, s: Parameters<typeof isTerminal>[0]): CrewEvent => ({
  type: "StatusChanged",
  agentId,
  status: s,
})

const msg = (
  messageId: string,
  fromId: string,
  toId: string,
  payload = "hi",
): CrewEvent => ({ type: "MessageQueued", messageId, fromId, toId, payload })

// ---------------------------------------------------------------------------
// isTerminal
// ---------------------------------------------------------------------------

describe("isTerminal", () => {
  test("done/failed/stopped are terminal", () => {
    expect(isTerminal("done")).toBe(true)
    expect(isTerminal("failed")).toBe(true)
    expect(isTerminal("stopped")).toBe(true)
  })

  test("working/waiting are not terminal", () => {
    expect(isTerminal("working")).toBe(false)
    expect(isTerminal("waiting")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// project / applyOne: empty log
// ---------------------------------------------------------------------------

describe("project on empty log", () => {
  test("returns initial state with no agents or spend", () => {
    const state = project([])
    expect(state.agents.size).toBe(0)
    expect(state.mailboxes.size).toBe(0)
    expect(state.spends.size).toBe(0)
    expect(state.stopped).toBe(false)
  })

  test("applyOne on initial state matches project of one event", () => {
    const event = spawn("a")
    expect(applyOne(INITIAL_STATE, event)).toEqual(project([event]))
  })
})

// ---------------------------------------------------------------------------
// AgentSpawned
// ---------------------------------------------------------------------------

describe("AgentSpawned", () => {
  test("single root agent appears with working status", () => {
    const state = project([spawn("a")])
    const agent = state.agents.get("a")
    expect(agent).toBeDefined()
    expect(agent?.status).toBe("working")
    expect(agent?.parentId).toBeNull()
    expect(agent?.depth).toBe(0)
    expect(agent?.output).toBeUndefined()
  })

  test("child agent carries parent id and depth", () => {
    const state = project([spawn("root"), spawn("child", "root", 1)])
    const child = state.agents.get("child")
    expect(child?.parentId).toBe("root")
    expect(child?.depth).toBe(1)
  })

  test("duplicate agentId silently replaces (projection does not validate)", () => {
    // The coordinator rejects duplicates; the projection just overwrites.
    const state = project([spawn("a"), spawn("a")])
    expect(state.agents.size).toBe(1)
  })

  test("many agents all appear", () => {
    const events: CrewEvent[] = ["a", "b", "c", "d"].map((id) => spawn(id))
    const state = project(events)
    expect(state.agents.size).toBe(4)
  })
})

// ---------------------------------------------------------------------------
// StatusChanged
// ---------------------------------------------------------------------------

describe("StatusChanged", () => {
  test("transitions agent to new status", () => {
    const state = project([spawn("a"), status("a", "done")])
    expect(state.agents.get("a")?.status).toBe("done")
  })

  test("StatusChanged for unknown agent is a no-op", () => {
    const state = project([status("ghost", "done")])
    expect(state.agents.size).toBe(0)
  })

  test("all five statuses round-trip", () => {
    for (const s of ["working", "waiting", "done", "failed", "stopped"] as const) {
      const state = project([spawn("a"), status("a", s)])
      expect(state.agents.get("a")?.status).toBe(s)
    }
  })
})

// ---------------------------------------------------------------------------
// MessageQueued / CursorAdvanced
// ---------------------------------------------------------------------------

describe("MessageQueued", () => {
  test("message appears in recipient mailbox", () => {
    const state = project([spawn("a"), spawn("b"), msg("m1", "a", "b", "hello")])
    const mailbox = state.mailboxes.get("b")
    expect(mailbox?.messages).toHaveLength(1)
    expect(mailbox?.messages[0]?.payload).toBe("hello")
    expect(mailbox?.messages[0]?.fromId).toBe("a")
    expect(mailbox?.cursor).toBe(0)
  })

  test("multiple messages to same recipient append in order", () => {
    const state = project([
      spawn("a"),
      spawn("b"),
      msg("m1", "a", "b", "first"),
      msg("m2", "a", "b", "second"),
      msg("m3", "a", "b", "third"),
    ])
    const messages = state.mailboxes.get("b")?.messages ?? []
    expect(messages.map((m) => m.payload)).toEqual(["first", "second", "third"])
  })

  test("messages to different recipients land in separate mailboxes", () => {
    const state = project([
      spawn("a"),
      spawn("b"),
      spawn("c"),
      msg("m1", "a", "b"),
      msg("m2", "a", "c"),
    ])
    expect(state.mailboxes.get("b")?.messages).toHaveLength(1)
    expect(state.mailboxes.get("c")?.messages).toHaveLength(1)
  })

  test("sender mailbox is not affected", () => {
    const state = project([spawn("a"), spawn("b"), msg("m1", "a", "b")])
    expect(state.mailboxes.get("a")).toBeUndefined()
  })
})

describe("CursorAdvanced", () => {
  test("cursor advances past read messages", () => {
    const state = project([
      spawn("a"),
      spawn("b"),
      msg("m1", "a", "b"),
      msg("m2", "a", "b"),
      { type: "CursorAdvanced", agentId: "b", cursor: 2 },
    ])
    expect(state.mailboxes.get("b")?.cursor).toBe(2)
  })

  test("CursorAdvanced for unknown agent is a no-op", () => {
    const state = project([{ type: "CursorAdvanced", agentId: "ghost", cursor: 5 }])
    expect(state.mailboxes.size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// OutputWritten
// ---------------------------------------------------------------------------

describe("OutputWritten", () => {
  test("output is stored on the agent record", () => {
    const state = project([
      spawn("a"),
      { type: "OutputWritten", agentId: "a", output: "result text" },
    ])
    expect(state.agents.get("a")?.output).toBe("result text")
  })

  test("OutputWritten for unknown agent is a no-op", () => {
    const state = project([{ type: "OutputWritten", agentId: "ghost", output: "x" }])
    expect(state.agents.size).toBe(0)
  })

  test("later write replaces earlier output", () => {
    const state = project([
      spawn("a"),
      { type: "OutputWritten", agentId: "a", output: "first" },
      { type: "OutputWritten", agentId: "a", output: "second" },
    ])
    expect(state.agents.get("a")?.output).toBe("second")
  })
})

// ---------------------------------------------------------------------------
// SpendRecorded
// ---------------------------------------------------------------------------

describe("SpendRecorded", () => {
  test("spend accumulates per agent", () => {
    const state = project([
      spawn("a"),
      { type: "SpendRecorded", agentId: "a", amount: 1.5 },
      { type: "SpendRecorded", agentId: "a", amount: 0.5 },
    ])
    expect(state.spends.get("a")).toBeCloseTo(2.0)
  })

  test("spend is independent per agent", () => {
    const state = project([
      spawn("a"),
      spawn("b"),
      { type: "SpendRecorded", agentId: "a", amount: 3 },
      { type: "SpendRecorded", agentId: "b", amount: 7 },
    ])
    expect(state.spends.get("a")).toBe(3)
    expect(state.spends.get("b")).toBe(7)
  })
})

// ---------------------------------------------------------------------------
// CrewStopped
// ---------------------------------------------------------------------------

describe("CrewStopped", () => {
  test("sets stopped flag and marks all non-terminal agents stopped", () => {
    const state = project([
      spawn("a"),
      spawn("b"),
      status("b", "done"),
      { type: "CrewStopped" },
    ])
    expect(state.stopped).toBe(true)
    expect(state.agents.get("a")?.status).toBe("stopped")
    expect(state.agents.get("b")?.status).toBe("done")
  })

  test("second CrewStopped is idempotent", () => {
    const events: CrewEvent[] = [spawn("a"), { type: "CrewStopped" }, { type: "CrewStopped" }]
    const state = project(events)
    expect(state.stopped).toBe(true)
    expect(state.agents.get("a")?.status).toBe("stopped")
  })

  test("empty crew stopped has no agents to mark", () => {
    const state = project([{ type: "CrewStopped" }])
    expect(state.stopped).toBe(true)
    expect(state.agents.size).toBe(0)
  })
})
