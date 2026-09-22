/**
 * CrewRuntime: panel-scoped orchestrator around a Crew coordinator.
 */

import { describe, expect, test } from "bun:test"
import { MAX_AGENTS, MAX_DEPTH } from "./events"
import { createCrew } from "./coordinator"
import { createCrewRuntime } from "./runtime"
import type { ChildHandle, StartChild } from "./runtime"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Deferred<T> {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Drains all pending microtasks and at least one macrotask round. */
const drain = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/** A startChild that resolves immediately with the given output. */
function immediateChild(output = "ok"): StartChild {
  return async () => ({
    completion: Promise.resolve(output),
    stop: async () => {},
  })
}

/** A counter-based unique ID factory. */
function makeCounter(): () => string {
  let n = 0
  return () => `id-${n++}`
}

/** Standard setup: crew with root agent, runtime wired up. */
function setup(startChild: StartChild = immediateChild()) {
  const crew = createCrew()
  crew.spawnAgent("root", null)
  const runtime = createCrewRuntime(crew, makeCounter(), startChild)
  return { crew, runtime }
}

// ---------------------------------------------------------------------------
// spawn
// ---------------------------------------------------------------------------

describe("spawn", () => {
  test("returns immediately with child id before startChild resolves", () => {
    const d = deferred<string>()
    const startChild: StartChild = async () => ({
      completion: d.promise,
      stop: async () => {},
    })
    const { crew, runtime } = setup(startChild)

    const child = runtime.spawn("root", "do work")

    // synchronous: agent is already in the crew
    expect(crew.state().agents.has(child.id)).toBe(true)
    expect(crew.state().agents.get(child.id)?.status).toBe("working")
    expect(child.id).toBeDefined()
    expect(child.parentId).toBe("root")
    expect(child.brief).toBe("do work")
    expect(child.title).toBeUndefined()
    expect(child.target).toBeUndefined()
  })

  test("forwards optional title and target", () => {
    const { runtime } = setup()
    const child = runtime.spawn("root", "brief", "My Title", "main")
    expect(child.title).toBe("My Title")
    expect(child.target).toBe("main")
  })

  test("on completion, writes output then sets status done", async () => {
    const { crew, runtime } = setup(immediateChild("the answer"))
    const child = runtime.spawn("root", "brief")

    await drain()

    expect(crew.state().agents.get(child.id)?.output).toBe("the answer")
    expect(crew.state().agents.get(child.id)?.status).toBe("done")
  })

  test("on rejection, sets status failed and writes error output", async () => {
    const startChild: StartChild = async () => ({
      completion: Promise.reject(new Error("boom")),
      stop: async () => {},
    })
    const { crew, runtime } = setup(startChild)
    const child = runtime.spawn("root", "brief")

    await drain()

    expect(crew.state().agents.get(child.id)?.status).toBe("failed")
    const out = crew.state().agents.get(child.id)?.output
    expect(out).toContain("boom")
  })

  test("no unhandled rejection when completion rejects", async () => {
    // If this test completes without an unhandled rejection crashing the
    // process, the runtime swallowed the rejection correctly.
    const startChild: StartChild = async () => ({
      completion: Promise.reject(new Error("silent fail")),
      stop: async () => {},
    })
    const { runtime } = setup(startChild)
    runtime.spawn("root", "brief")
    await drain()
    // reaching here is the assertion
    expect(true).toBe(true)
  })

  test("respects MAX_AGENTS limit from crew", () => {
    const { runtime } = setup()
    // root is 1 agent; we can add MAX_AGENTS - 1 = 3 more
    for (let i = 1; i < MAX_AGENTS; i++) runtime.spawn("root", `child ${i}`)
    expect(() => runtime.spawn("root", "one too many")).toThrow()
  })

  test("respects MAX_DEPTH limit from crew", () => {
    const { runtime } = setup()
    const child = runtime.spawn("root", "depth 1") // depth 1
    const grand = runtime.spawn(child.id, "depth 2") // depth 2 = MAX_DEPTH, ok
    expect(() => runtime.spawn(grand.id, "depth 3")).toThrow()
  })

  test("nested spawn: grandchild has depth 2 and correct parentId", () => {
    const { crew, runtime } = setup()
    const child = runtime.spawn("root", "child")
    const grand = runtime.spawn(child.id, "grandchild")

    expect(crew.state().agents.get(grand.id)?.depth).toBe(2)
    expect(crew.state().agents.get(grand.id)?.parentId).toBe(child.id)
  })
})

// ---------------------------------------------------------------------------
// True parallelism
// ---------------------------------------------------------------------------

describe("parallelism", () => {
  test("two deferred children both start before either resolves", async () => {
    const d1 = deferred<string>()
    const d2 = deferred<string>()
    const started: string[] = []
    let call = 0

    const startChild: StartChild = async (childId) => {
      started.push(childId)
      const comp = call === 0 ? d1.promise : d2.promise
      call++
      return { completion: comp, stop: async () => {} }
    }

    const { crew, runtime } = setup(startChild)
    const c1 = runtime.spawn("root", "child 1")
    const c2 = runtime.spawn("root", "child 2")

    // Let both startChild async bodies execute
    await Promise.resolve()
    await Promise.resolve()

    // Both started before either resolved
    expect(started).toHaveLength(2)
    expect(started).toContain(c1.id)
    expect(started).toContain(c2.id)

    // Resolve both
    d1.resolve("out-1")
    d2.resolve("out-2")

    await crew.awaitAgents([c1.id, c2.id])

    expect(crew.state().agents.get(c1.id)?.status).toBe("done")
    expect(crew.state().agents.get(c2.id)?.status).toBe("done")
  })
})

// ---------------------------------------------------------------------------
// awaitAgents
// ---------------------------------------------------------------------------

describe("awaitAgents", () => {
  test("delegates to crew's subscription-based awaitAgents (no polling)", async () => {
    const d = deferred<string>()
    const startChild: StartChild = async () => ({
      completion: d.promise,
      stop: async () => {},
    })
    const { crew, runtime } = setup(startChild)
    const child = runtime.spawn("root", "brief")

    let resolved = false
    const waiting = runtime.awaitAgents([child.id]).then((r) => {
      resolved = true
      return r
    })

    await Promise.resolve()
    expect(resolved).toBe(false) // still pending

    d.resolve("finished")
    const result = await waiting

    expect(result.ready).toBe(true)
    expect(result.outputs.get(child.id)).toBe("finished")
  })

  test("resolves immediately when all agents are already terminal", async () => {
    const { crew, runtime } = setup(immediateChild("done"))
    const child = runtime.spawn("root", "brief")

    await drain()

    const result = await runtime.awaitAgents([child.id])
    expect(result.ready).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// send / read (all-to-all mailboxes)
// ---------------------------------------------------------------------------

describe("send / read", () => {
  test("send queues a message; read returns it", () => {
    const { runtime } = setup()
    const child = runtime.spawn("root", "brief")

    runtime.send("root", child.id, "hello from root")

    const msgs = runtime.read(child.id)
    expect(msgs).toHaveLength(1)
    expect(msgs[0]?.payload).toBe("hello from root")
  })

  test("second read after no new messages returns empty", () => {
    const { runtime } = setup()
    const child = runtime.spawn("root", "brief")

    runtime.send("root", child.id, "msg")
    runtime.read(child.id)

    expect(runtime.read(child.id)).toHaveLength(0)
  })

  test("all-to-all: child can send to root and root can read it", () => {
    const { runtime } = setup()
    const child = runtime.spawn("root", "brief")

    runtime.send(child.id, "root", "reply from child")

    const msgs = runtime.read("root")
    expect(msgs[0]?.payload).toBe("reply from child")
  })

  test("send does not auto-run recipient", () => {
    const { crew, runtime } = setup()
    const child = runtime.spawn("root", "brief")

    const before = crew.state().agents.get(child.id)?.status
    runtime.send("root", child.id, "ping")
    const after = crew.state().agents.get(child.id)?.status

    expect(before).toBe("working")
    expect(after).toBe("working")
  })
})

test("setStatus exposes waiting and working states to the crew", () => {
  const { crew, runtime } = setup()
  runtime.setStatus("root", "waiting")
  expect(crew.state().agents.get("root")?.status).toBe("waiting")
  runtime.setStatus("root", "working")
  expect(crew.state().agents.get("root")?.status).toBe("working")
})

test("spend from all bot logs rolls up to one crew total", () => {
  const { runtime } = setup()
  runtime.recordSpend("root", 0.02)
  expect(runtime.totalSpend()).toBe(0.02)
})

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

describe("stop", () => {
  test("blocks new spawns after stop", async () => {
    const { runtime } = setup()
    await runtime.stop()
    expect(() => runtime.spawn("root", "new")).toThrow()
  })

  test("propagates stop() to all live handles", async () => {
    const stopped: string[] = []
    const d = deferred<string>()

    const startChild: StartChild = async (childId) => ({
      completion: d.promise, // never resolves spontaneously
      stop: async () => {
        stopped.push(childId)
      },
    })

    const { runtime } = setup(startChild)
    const child = runtime.spawn("root", "brief")

    // Wait for the handle to be established in liveHandles
    await Promise.resolve()
    await Promise.resolve()

    await runtime.stop()

    expect(stopped).toContain(child.id)
  })

  test("propagates stop() to all live handles from multiple concurrent spawns", async () => {
    const stopped: string[] = []
    const d = deferred<string>()

    const startChild: StartChild = async (childId) => ({
      completion: d.promise,
      stop: async () => {
        stopped.push(childId)
      },
    })

    const { runtime } = setup(startChild)
    const c1 = runtime.spawn("root", "child 1")
    const c2 = runtime.spawn("root", "child 2")

    await Promise.resolve()
    await Promise.resolve()

    await runtime.stop()

    expect(stopped).toContain(c1.id)
    expect(stopped).toContain(c2.id)
  })

  test("stops a child whose handle arrives after stop starts", async () => {
    const handle = deferred<ChildHandle>()
    const stopped: string[] = []
    const { runtime } = setup(async (childId) => {
      const child = await handle.promise
      return { ...child, stop: async () => {
        stopped.push(childId)
        await child.stop()
      } }
    })
    const child = runtime.spawn("root", "slow start")
    const stopping = runtime.stop()

    handle.resolve({ completion: new Promise<string>(() => {}), stop: async () => {} })
    await stopping

    expect(stopped).toEqual([child.id])
  })
})

// ---------------------------------------------------------------------------
// subscribe
// ---------------------------------------------------------------------------

describe("subscribe", () => {
  test("exposes crew changes via subscription", () => {
    const { runtime } = setup()
    let calls = 0
    const unsub = runtime.subscribe(() => {
      calls++
    })
    runtime.spawn("root", "brief") // fires AgentSpawned → cb called
    unsub()
    expect(calls).toBeGreaterThanOrEqual(1)
  })

  test("unsubscribe stops further notifications", () => {
    const { runtime } = setup()
    let calls = 0
    const unsub = runtime.subscribe(() => {
      calls++
    })
    runtime.spawn("root", "brief")
    const after = calls
    unsub()
    runtime.spawn("root", "brief 2")
    expect(calls).toBe(after)
  })
})
