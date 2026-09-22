import { describe, expect, test } from "bun:test"
import { memoryThreads, recoverExtensionContext } from "./threads"
import type { ThreadStatus } from "./threads"

describe("chat threads", () => {
  test("an invalidated extension context reloads instead of leaving dead tabs visible", async () => {
    let reloads = 0
    let settled = false
    const operation = recoverExtensionContext(
      async () => {
        throw new Error("Extension context invalidated.")
      },
      () => {
        reloads += 1
      }
    )
    void operation.finally(() => {
      settled = true
    })

    await Promise.resolve()
    await Promise.resolve()
    expect(reloads).toBe(1)
    expect(settled).toBe(false)
  })

  test("a normal storage error still rejects", async () => {
    let reloads = 0
    const operation = recoverExtensionContext(
      async () => {
        throw new Error("Storage failed.")
      },
      () => {
        reloads += 1
      }
    )

    await expect(operation).rejects.toThrow("Storage failed.")
    expect(reloads).toBe(0)
  })

  test("the first site thread keeps the old page log and stays selected across page navigation", async () => {
    const threads = memoryThreads()

    const first = await threads.state("https://example.com/products?sort=new")
    const nextPage = await threads.state("https://example.com/cart")

    expect(first).toEqual({
      site: "https://example.com",
      selected: "https://example.com/products",
      items: [{ id: "https://example.com/products", title: "Current chat", createdAt: 0 }]
    })
    expect(nextPage).toEqual(first)
  })

  test("a site can create, select, and name separate threads without mixing another site", async () => {
    const ids = ["thread-two"]
    const threads = memoryThreads(() => ids.shift() ?? "unexpected")
    await threads.state("https://example.com/products")

    const created = await threads.create("https://example.com")
    await threads.name("https://example.com", created.id, "  Make   checkout calmer and much easier to scan  ")
    const example = await threads.state("https://example.com/checkout")
    const other = await threads.state("https://other.test/")

    expect(example.selected).toBe("thread-two")
    expect(example.items).toEqual([
      { id: "https://example.com/products", title: "Current chat", createdAt: 0 },
      { id: "thread-two", title: "Make checkout calmer and…", createdAt: 1 }
    ])
    expect(other.items).toEqual([{ id: "https://other.test/", title: "Current chat", createdAt: 2 }])
  })

  test("old page logs become site tabs instead of becoming inaccessible", async () => {
    const threads = memoryThreads()
    const state = await threads.state("https://example.com/products", [
      "https://example.com/",
      "https://example.com/products",
      "https://other.test/account",
      "thread-without-a-url"
    ])

    expect(state.selected).toBe("https://example.com/products")
    expect(state.items.map(({ id, title }) => ({ id, title }))).toEqual([
      { id: "https://example.com/", title: "Home" },
      { id: "https://example.com/products", title: "Products" }
    ])
  })

  test("thread names keep whole emoji and malformed legacy paths cannot block the panel", async () => {
    const threads = memoryThreads(() => "emoji-thread")
    await threads.state("https://example.com/", ["https://example.com/%E0%A4%A"])
    const thread = await threads.create("https://example.com")
    await threads.name("https://example.com", thread.id, "🎨".repeat(30))
    const state = await threads.state("https://example.com/")
    const title = state.items.find((item) => item.id === thread.id)?.title ?? ""

    expect([...title]).toHaveLength(25)
    expect(title.endsWith("…")).toBe(true)
  })

  test("removing a thread selects its neighbor and keeps the other site intact", async () => {
    const ids = ["thread-two", "thread-three"]
    const threads = memoryThreads(() => ids.shift() ?? "unexpected")
    await threads.state("https://example.com/products")
    await threads.create("https://example.com")
    await threads.create("https://example.com")
    await threads.select("https://example.com", "thread-two")
    const other = await threads.state("https://other.test/")

    const after = await threads.remove("https://example.com", "thread-two")

    expect(after.selected).toBe("https://example.com/products")
    expect(after.items.map((item) => item.id)).toEqual(["https://example.com/products", "thread-three"])
    expect((await threads.state("https://other.test/")).items).toEqual(other.items)
  })

  test("removing the last thread leaves a fresh empty chat", async () => {
    const threads = memoryThreads(() => "fresh")
    const first = await threads.state("https://example.com/products")

    const after = await threads.remove("https://example.com", first.selected)

    expect(after.items).toEqual([{ id: "fresh", title: "New chat", createdAt: 1 }])
    expect(after.selected).toBe("fresh")
  })
})

describe("crew thread metadata", () => {
  test("old flat records parse unchanged via memory seam", async () => {
    const threads = memoryThreads(undefined, {
      "https://example.com": {
        selected: "thread-1",
        items: [
          { id: "thread-1", title: "Old thread", createdAt: 100 },
          { id: "thread-2", title: "Another thread", createdAt: 200 }
        ]
      }
    })

    const state = await threads.state("https://example.com/")

    expect(state.selected).toBe("thread-1")
    expect(state.items).toEqual([
      { id: "thread-1", title: "Old thread", createdAt: 100 },
      { id: "thread-2", title: "Another thread", createdAt: 200 }
    ])
  })

  test("createChild adds a child thread without changing the current selection", async () => {
    const ids = ["parent", "child"]
    const threads = memoryThreads(() => ids.shift() ?? "unexpected")
    await threads.state("https://example.com/")
    const parent = await threads.create("https://example.com")
    await threads.select("https://example.com", parent.id)

    const child = await threads.createChild("https://example.com", parent.id, {
      title: "Delegate checkout audit",
      target: "#checkout-form"
    })

    const state = await threads.state("https://example.com/")
    expect(child.parentId).toBe(parent.id)
    expect(child.rootId).toBe(parent.id)
    expect(child.agentId).toBe(child.id)
    expect(child.target).toBe("#checkout-form")
    expect(child.title).toBe("Delegate checkout audit")
    expect(state.selected).toBe(parent.id)
    expect(state.items.some((item) => item.id === child.id)).toBe(true)
  })

  test("nested child inherits rootId from grandparent, not direct parent", async () => {
    const ids = ["root", "child", "grandchild"]
    const threads = memoryThreads(() => ids.shift() ?? "unexpected")
    await threads.state("https://example.com/")
    const root = await threads.create("https://example.com")
    const child = await threads.createChild("https://example.com", root.id, {})
    const grandchild = await threads.createChild("https://example.com", child.id, {})

    expect(child.rootId).toBe(root.id)
    expect(grandchild.rootId).toBe(root.id)
    expect(grandchild.parentId).toBe(child.id)
  })

  test("a stable agentId can be provided instead of defaulting to the thread id", async () => {
    const threads = memoryThreads(() => "child-id")
    await threads.state("https://example.com/")
    const parent = await threads.create("https://example.com")

    const child = await threads.createChild("https://example.com", parent.id, {
      agentId: "stable-agent-007"
    })

    expect(child.agentId).toBe("stable-agent-007")
    expect(child.id).toBe("child-id")
  })

  test("status updates the status field of an existing thread", async () => {
    const threads = memoryThreads(() => "task-thread")
    await threads.state("https://example.com/")
    const t = await threads.create("https://example.com")

    await threads.status("https://example.com", t.id, "working")
    const working = await threads.state("https://example.com/")
    expect(working.items.find((i) => i.id === t.id)?.status).toBe("working")

    await threads.status("https://example.com", t.id, "done")
    const done = await threads.state("https://example.com/")
    expect(done.items.find((i) => i.id === t.id)?.status).toBe("done")
  })

  test("removing a parent removes all descendants and selects a valid neighbor", async () => {
    const ids = ["root-a", "child-a1", "child-a2", "grandchild-a1", "root-b"]
    const threads = memoryThreads(() => ids.shift() ?? "unexpected")
    await threads.state("https://example.com/")
    const rootA = await threads.create("https://example.com")
    const childA1 = await threads.createChild("https://example.com", rootA.id, {})
    const childA2 = await threads.createChild("https://example.com", rootA.id, {})
    const grandchildA1 = await threads.createChild("https://example.com", childA1.id, {})
    const rootB = await threads.create("https://example.com")
    await threads.select("https://example.com", rootA.id)

    const after = await threads.remove("https://example.com", rootA.id)

    const afterIds = after.items.map((i) => i.id)
    expect(afterIds).not.toContain(rootA.id)
    expect(afterIds).not.toContain(childA1.id)
    expect(afterIds).not.toContain(childA2.id)
    expect(afterIds).not.toContain(grandchildA1.id)
    expect(afterIds).toContain(rootB.id)
    // The store picks the nearest surviving predecessor (left-first).
    // root-a is at index 1; its left neighbor is the initial page thread.
    expect(after.selected).toBe("https://example.com/")
  })

  test("removing a child removes only its own descendants and leaves siblings and parent intact", async () => {
    const ids = ["par", "c1", "c2", "gc1"]
    const threads = memoryThreads(() => ids.shift() ?? "unexpected")
    await threads.state("https://example.com/")
    const par = await threads.create("https://example.com")
    const c1 = await threads.createChild("https://example.com", par.id, {})
    const c2 = await threads.createChild("https://example.com", par.id, {})
    const gc1 = await threads.createChild("https://example.com", c1.id, {})
    await threads.select("https://example.com", par.id)

    const after = await threads.remove("https://example.com", c1.id)

    const afterIds = after.items.map((i) => i.id)
    expect(afterIds).toContain(par.id)
    expect(afterIds).not.toContain(c1.id)
    expect(afterIds).toContain(c2.id)
    expect(afterIds).not.toContain(gc1.id)
    expect(after.selected).toBe(par.id)
  })

  test("cascade remove does not touch threads on other sites", async () => {
    const ids = ["s1-par", "s1-child", "s2-thread"]
    const threads = memoryThreads(() => ids.shift() ?? "unexpected")
    await threads.state("https://site1.com/")
    await threads.state("https://site2.com/")
    const par = await threads.create("https://site1.com")
    await threads.createChild("https://site1.com", par.id, {})
    const s2Thread = await threads.create("https://site2.com")

    await threads.remove("https://site1.com", par.id)

    const s2State = await threads.state("https://site2.com/")
    expect(s2State.items.map((i) => i.id)).toContain(s2Thread.id)
  })

  test("malformed optional metadata fields are dropped or normalized when parsing", async () => {
    const threads = memoryThreads(undefined, {
      "https://example.com": {
        selected: "t1",
        items: [
          {
            id: "t1",
            title: "Thread",
            createdAt: 50,
            parentId: 999,
            rootId: null,
            agentId: "valid-agent",
            status: "invalid-status",
            target: true
          }
        ]
      }
    })

    const state = await threads.state("https://example.com/")
    const thread = state.items.find((i) => i.id === "t1")

    expect(thread).toBeDefined()
    expect(thread?.parentId).toBeUndefined()
    expect(thread?.rootId).toBeUndefined()
    expect(thread?.agentId).toBe("valid-agent")
    expect(thread?.status).toBeUndefined()
    expect(thread?.target).toBeUndefined()
  })
})
