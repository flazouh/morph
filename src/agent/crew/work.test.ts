/**
 * Tests for parallel-agent work coordination primitives.
 */

import { describe, expect, test } from "bun:test"
import { createWork, WorkError, type Capability } from "./work"
import { createCrew } from "./coordinator"
import type { Script } from "../applied"
import type { SkinFiles } from "../../skin/compile"
import { Effect, Fiber } from "effect"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const setup = () => {
  const crew = createCrew()
  crew.spawnAgent("a", null)
  const work = createWork(crew)
  return { crew, work }
}

const multi = () => {
  const crew = createCrew()
  crew.spawnAgent("a", null)
  crew.spawnAgent("b", null)
  crew.spawnAgent("c", null)
  const work = createWork(crew)
  return { crew, work }
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

describe("empty state", () => {
  test("no claims initially", () => {
    const { work } = setup()
    expect(work.claims()).toHaveLength(0)
  })

  test("composed returns empty Applied", () => {
    const { work } = setup()
    const a = work.composed()
    expect(a.css).toBeUndefined()
    expect(a.script).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Single CSS claim
// ---------------------------------------------------------------------------

describe("one css claim", () => {
  test("claim then writeCss appears in composed", () => {
    const { work } = setup()
    work.claim("a", "css", ".foo")
    work.writeCss("a", ".foo", ".foo { color: red; }")
    expect(work.composed().css).toContain(".foo { color: red; }")
  })

  test("composed CSS contains agent boundary comments", () => {
    const { work } = setup()
    work.claim("a", "css", ".foo")
    work.writeCss("a", ".foo", ".foo { color: red; }")
    const css = work.composed().css!
    expect(css).toContain("/* agent:a */")
    expect(css).toContain("/* /agent:a */")
  })

  test("claim without writeCss: composed has no css", () => {
    const { work } = setup()
    work.claim("a", "css", ".foo")
    expect(work.composed().css).toBeUndefined()
  })

  test("claims() includes the claim", () => {
    const { work } = setup()
    work.claim("a", "css", ".foo")
    const c = work.claims()
    expect(c).toHaveLength(1)
    expect(c[0]!.agentId).toBe("a")
    expect(c[0]!.capability).toBe("css")
    expect(c[0]!.selector).toBe(".foo")
  })
})

// ---------------------------------------------------------------------------
// Many CSS claims
// ---------------------------------------------------------------------------

describe("many css claims", () => {
  test("two agents compose in claim order", () => {
    const { work } = multi()
    work.claim("a", "css", ".foo")
    work.claim("b", "css", ".bar")
    work.writeCss("a", ".foo", "A")
    work.writeCss("b", ".bar", "B")
    const css = work.composed().css!
    expect(css.indexOf("/* agent:a */")).toBeLessThan(css.indexOf("/* agent:b */"))
  })

  test("claims() returns all claims sorted by order", () => {
    const { work } = multi()
    work.claim("a", "css", ".foo")
    work.claim("b", "css", ".bar")
    work.claim("c", "css", ".baz")
    const c = work.claims()
    expect(c).toHaveLength(3)
    expect(c[0]!.order).toBeLessThan(c[1]!.order)
    expect(c[1]!.order).toBeLessThan(c[2]!.order)
  })

  test("three fragments appear in the CSS in claim order", () => {
    const { work } = multi()
    work.claim("a", "css", ".foo")
    work.claim("b", "css", ".bar")
    work.claim("c", "css", ".baz")
    work.writeCss("a", ".foo", "A")
    work.writeCss("b", ".bar", "B")
    work.writeCss("c", ".baz", "C")
    const css = work.composed().css!
    expect(css.indexOf("A")).toBeLessThan(css.indexOf("B"))
    expect(css.indexOf("B")).toBeLessThan(css.indexOf("C"))
  })
})

// ---------------------------------------------------------------------------
// CSS selector overlap / conflict
// ---------------------------------------------------------------------------

describe("css overlap rejection", () => {
  test("rejects duplicate selector", () => {
    const { work } = multi()
    work.claim("a", "css", ".foo")
    expect(() => work.claim("b", "css", ".foo")).toThrow(WorkError)
  })

  test("rejects prefix conflict (.foo vs .foo .bar)", () => {
    const { work } = multi()
    work.claim("a", "css", ".foo")
    expect(() => work.claim("b", "css", ".foo .bar")).toThrow(WorkError)
  })

  test("rejects reverse prefix (.foo .bar vs .foo)", () => {
    const { work } = multi()
    work.claim("a", "css", ".foo .bar")
    expect(() => work.claim("b", "css", ".foo")).toThrow(WorkError)
  })

  test(":root conflicts with any selector", () => {
    const { work } = multi()
    work.claim("a", "css", ".foo")
    expect(() => work.claim("b", "css", ":root")).toThrow(WorkError)
  })

  test("body conflicts with any selector", () => {
    const { work } = multi()
    work.claim("a", "css", ".bar")
    expect(() => work.claim("b", "css", "body")).toThrow(WorkError)
  })

  test("* conflicts with any selector", () => {
    const { work } = multi()
    work.claim("a", "css", ".baz")
    expect(() => work.claim("b", "css", "*")).toThrow(WorkError)
  })

  test("any selector conflicts with :root held first", () => {
    const { work } = multi()
    work.claim("a", "css", ":root")
    expect(() => work.claim("b", "css", ".foo")).toThrow(WorkError)
  })

  test("non-overlapping selectors both succeed", () => {
    const { work } = multi()
    work.claim("a", "css", ".foo")
    expect(() => work.claim("b", "css", ".bar")).not.toThrow()
    expect(() => work.claim("c", "css", "#baz")).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Exclusivity (script / design)
// ---------------------------------------------------------------------------

describe("exclusivity", () => {
  test("two agents cannot both hold script", () => {
    const { work } = multi()
    work.claim("a", "script")
    expect(() => work.claim("b", "script")).toThrow(WorkError)
  })

  test("two agents cannot both hold design", () => {
    const { work } = multi()
    work.claim("a", "design")
    expect(() => work.claim("b", "design")).toThrow(WorkError)
  })

  test("script claim does not block css claim", () => {
    const { work } = multi()
    work.claim("a", "script")
    expect(() => work.claim("b", "css", ".foo")).not.toThrow()
  })

  test("same agent cannot duplicate-claim design", () => {
    const { work } = setup()
    work.claim("a", "design")
    expect(() => work.claim("a", "design")).toThrow(WorkError)
  })

  test("same agent may hold different capabilities (script + design)", () => {
    const { work } = setup()
    work.claim("a", "script")
    expect(() => work.claim("a", "design")).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Release and reclaim
// ---------------------------------------------------------------------------

describe("release and reclaim", () => {
  test("released css claim disappears from claims()", () => {
    const { work } = setup()
    work.claim("a", "css", ".foo")
    work.release("a", "css", ".foo")
    expect(work.claims()).toHaveLength(0)
  })

  test("released CSS claim keeps its successful fragment for the composed stylesheet", () => {
    const { work } = setup()
    work.claim("a", "css", ".foo")
    work.writeCss("a", ".foo", ".foo { color: red; }")
    work.release("a", "css", ".foo")
    expect(work.composed().css).toContain(".foo { color: red; }")
  })

  test("another agent can claim the released selector", () => {
    const { work } = multi()
    work.claim("a", "css", ".foo")
    work.release("a", "css", ".foo")
    expect(() => work.claim("b", "css", ".foo")).not.toThrow()
  })

  test("a new write to a released selector replaces its prior fragment", () => {
    const { work } = multi()
    work.claim("a", "css", ".foo")
    work.writeCss("a", ".foo", "A")
    work.release("a", "css", ".foo")
    work.claim("b", "css", ".foo")
    work.writeCss("b", ".foo", "B")
    work.settleCss("b", ".foo")
    expect(work.composed().css).not.toContain("\nA\n")
    expect(work.composed().css).toContain("\nB\n")
  })

  test("settling a scoped write keeps released base and token fragments", () => {
    const { work } = multi()
    work.claim("a", "css", ":root")
    work.writeCss("a", ":root", "TOKENS")
    work.release("a", "css", ":root")
    work.claim("b", "css", ".hero")
    work.writeCss("b", ".hero", "HERO")
    work.settleCss("b", ".hero")

    expect(work.composed().css).toContain("TOKENS")
    expect(work.composed().css).toContain("HERO")
  })

  test("released exclusive capability can be reclaimed", () => {
    const { work } = multi()
    work.claim("a", "script")
    work.release("a", "script")
    expect(() => work.claim("b", "script")).not.toThrow()
  })

  test("released script stays in composed until another script replaces it", () => {
    const { work } = setup()
    work.claim("a", "script")
    work.writeScript("a", { kind: "js", source: "1" })
    work.release("a", "script")
    expect(work.composed().script).toBe("1")
  })

  test("release is a noop for a non-existent claim", () => {
    const { work } = setup()
    expect(() => work.release("a", "css", ".ghost")).not.toThrow()
  })

  test("releasing one of two css claims keeps both successful fragments", () => {
    const { work } = multi()
    work.claim("a", "css", ".foo")
    work.claim("b", "css", ".bar")
    work.writeCss("a", ".foo", "A")
    work.writeCss("b", ".bar", "B")
    work.release("a", "css", ".foo")
    const css = work.composed().css!
    expect(css).toContain("A")
    expect(css).toContain("B")
  })
})

test("a terminal bot releases its claims but keeps its successful artifacts", () => {
  const { crew, work } = multi()
  work.claim("a", "css", ".foo")
  work.writeCss("a", ".foo", "A")
  crew.setStatus("a", "done")

  expect(work.claims()).toHaveLength(0)
  expect(work.composed().css).toContain("\nA\n")
  expect(() => work.claim("b", "css", ".foo")).not.toThrow()
})

// ---------------------------------------------------------------------------
// Stop invalidates claims
// ---------------------------------------------------------------------------

describe("stop invalidates claims", () => {
  test("stopping crew clears all claims", () => {
    const { crew, work } = setup()
    work.claim("a", "css", ".foo")
    work.claim("a", "design")
    crew.stop()
    expect(work.claims()).toHaveLength(0)
  })

  test("composed is empty after stop", () => {
    const { crew, work } = setup()
    work.claim("a", "css", ".foo")
    work.writeCss("a", ".foo", ".foo { color: red; }")
    crew.stop()
    expect(work.composed().css).toBeUndefined()
  })

  test("claim throws after crew stops", () => {
    const { crew, work } = multi()
    crew.stop()
    expect(() => work.claim("a", "css", ".foo")).toThrow(WorkError)
  })

  test("stopped crew with script: composed has no script", () => {
    const { crew, work } = setup()
    work.claim("a", "script")
    work.writeScript("a", { kind: "js", source: "x" })
    crew.stop()
    expect(work.composed().script).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Rejected claims
// ---------------------------------------------------------------------------

describe("rejected claims", () => {
  test("unknown agent is rejected", () => {
    const { work } = setup()
    expect(() => work.claim("nobody", "css", ".foo")).toThrow(WorkError)
  })

  test("terminal agent is rejected", () => {
    const { crew, work } = setup()
    crew.setStatus("a", "done")
    expect(() => work.claim("a", "css", ".foo")).toThrow(WorkError)
  })

  test("failed agent is rejected", () => {
    const { crew, work } = setup()
    crew.setStatus("a", "failed")
    expect(() => work.claim("a", "script")).toThrow(WorkError)
  })

  test("stopped agent is rejected", () => {
    const { crew, work } = multi()
    crew.setStatus("a", "stopped")
    expect(() => work.claim("a", "design")).toThrow(WorkError)
  })

  test("css without selector is rejected", () => {
    const { work } = setup()
    expect(() => work.claim("a", "css" as Capability)).toThrow(WorkError)
  })

  test("script with selector is rejected", () => {
    const { work } = setup()
    expect(() => work.claim("a", "script", ".foo")).toThrow(WorkError)
  })

  test("design with selector is rejected", () => {
    const { work } = setup()
    expect(() => work.claim("a", "design", ".foo")).toThrow(WorkError)
  })

  test("writeCss without a prior claim throws", () => {
    const { work } = setup()
    expect(() => work.writeCss("a", ".foo", ".foo {}")).toThrow(WorkError)
  })

  test("writeScript without a prior claim throws", () => {
    const { work } = setup()
    expect(() => work.writeScript("a", { kind: "js", source: "" })).toThrow(WorkError)
  })
})

// ---------------------------------------------------------------------------
// Deterministic write queue order
// ---------------------------------------------------------------------------

describe("write serialization", () => {
  test("serialized writes run in request order", async () => {
    const { work } = setup()
    const order: number[] = []
    await Effect.runPromise(
      Effect.all([
        work.serialize(Effect.sync(() => { order.push(1) })),
        work.serialize(Effect.sync(() => { order.push(2) })),
        work.serialize(Effect.sync(() => { order.push(3) }))
      ], { concurrency: "unbounded" })
    )
    expect(order).toEqual([1, 2, 3])
  })

  test("failed write does not block later writes", async () => {
    const { work } = setup()
    const order: number[] = []
    await Effect.runPromise(
      Effect.all([
        Effect.ignore(work.serialize(Effect.fail(new Error("fail")))),
        work.serialize(Effect.sync(() => { order.push(2) }))
      ], { concurrency: "unbounded" })
    )
    expect(order).toEqual([2])
  })

  test("failed write keeps its typed error", async () => {
    const { work } = setup()
    const err = new Error("boom")
    const failure = await Effect.runPromise(Effect.flip(work.serialize(Effect.fail(err))))
    expect(failure).toBe(err)
  })

  test("a stopped crew rejects new writes before they enter the queue", async () => {
    const { crew, work } = setup()
    crew.stop()
    await expect(Effect.runPromise(work.serialize(Effect.succeed("late")))).rejects.toThrow("crew is stopped")
  })

  test("interrupting serialized work releases the permit and keeps waiting work interrupted", async () => {
    const { work } = setup()
    let waitingRan = false
    let laterRan = false
    await Effect.runPromise(
      Effect.gen(function*() {
        const active = yield* Effect.forkChild(work.serialize(Effect.never))
        yield* Effect.yieldNow
        const waiting = yield* Effect.forkChild(
          work.serialize(Effect.sync(() => {
            waitingRan = true
          }))
        )
        yield* Effect.yieldNow
        yield* Fiber.interrupt(waiting)
        yield* Fiber.interrupt(active)
        yield* work.serialize(Effect.sync(() => {
          laterRan = true
        }))
      })
    )
    expect(waitingRan).toBe(false)
    expect(laterRan).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// CSS replacement and removal
// ---------------------------------------------------------------------------

describe("CSS replacement", () => {
  test("writeCss replaces only the calling agent's fragment", () => {
    const { work } = multi()
    work.claim("a", "css", ".foo")
    work.claim("b", "css", ".bar")
    work.writeCss("a", ".foo", "A1")
    work.writeCss("b", ".bar", "B1")
    work.writeCss("a", ".foo", "A2")
    const css = work.composed().css!
    expect(css).toContain("A2")
    expect(css).not.toContain("A1")
    expect(css).toContain("B1")
  })

  test("update preserves claim order in composed CSS", () => {
    const { work } = multi()
    work.claim("a", "css", ".foo")
    work.claim("b", "css", ".bar")
    work.writeCss("a", ".foo", "A")
    work.writeCss("b", ".bar", "B")
    work.writeCss("a", ".foo", "A-updated")
    const css = work.composed().css!
    expect(css.indexOf("/* agent:a */")).toBeLessThan(css.indexOf("/* agent:b */"))
  })

  test("releasing one agent's CSS keeps all successful fragments", () => {
    const { work } = multi()
    work.claim("a", "css", ".foo")
    work.claim("b", "css", ".bar")
    work.writeCss("a", ".foo", "A")
    work.writeCss("b", ".bar", "B")
    work.release("a", "css", ".foo")
    const css = work.composed().css!
    expect(css).toContain("/* agent:a */")
    expect(css).toContain("/* agent:b */")
    expect(css).toContain("B")
  })
})

// ---------------------------------------------------------------------------
// JS and skin script
// ---------------------------------------------------------------------------

describe("script types", () => {
  test("js script appears in composed", () => {
    const { work } = setup()
    work.claim("a", "script")
    const s: Script = { kind: "js", source: "console.log('hello')" }
    work.writeScript("a", s)
    expect(work.composed().script).toBe("console.log('hello')")
  })

  test("skin script appears in composed with its files", () => {
    const { work } = setup()
    work.claim("a", "script")
    const files: SkinFiles = { "page.tsx": "<App />" }
    const s: Script = { kind: "skin", files }
    work.writeScript("a", s)
    const composed = work.composed()
    expect(composed.script).toBeUndefined()
    expect(composed.skin).toEqual(files)
  })

  test("script does not appear in composed until writeScript is called", () => {
    const { work } = setup()
    work.claim("a", "script")
    expect(work.composed().script).toBeUndefined()
  })

  test("script is replaced when writeScript is called again", () => {
    const { work } = setup()
    work.claim("a", "script")
    work.writeScript("a", { kind: "js", source: "v1" })
    work.writeScript("a", { kind: "js", source: "v2" })
    expect(work.composed().script).toBe("v2")
  })
})
