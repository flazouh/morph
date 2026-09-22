import { describe, expect, test } from "bun:test"
import { attachShots, withShots, SHOT_NOTE, type Fetch } from "./eyes"

const tool = (id: string) => ({ role: "tool", tool_call_id: id, content: JSON.stringify(SHOT_NOTE) })
const user = (text: string) => ({ role: "user", content: text })

describe("attaching screenshots to the wire", () => {
  test("the latest look becomes an image message after its tool message; earlier looks become a line", () => {
    const shots = new Map([
      ["c1", "data:image/jpeg;base64,ONE"],
      ["c3", "data:image/jpeg;base64,THREE"]
    ])
    const body = { model: "m", messages: [user("go"), tool("c1"), tool("c2"), tool("c3"), user("more")] }
    const out = attachShots(body, shots) as { model: string; messages: Array<{ role: string; tool_call_id?: string; content: unknown }> }
    expect(out.model).toBe("m")
    expect(out.messages.map((m) => m.role)).toEqual(["user", "tool", "user", "tool", "tool", "user", "user"])
    expect(out.messages[2]?.content).toBe("(an earlier screenshot, no longer shown; the latest one is below)")
    expect(out.messages[5]?.content).toEqual([
      { type: "text", text: "The screenshot:" },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,THREE" } }
    ])
    // The tool messages themselves are untouched: the provider needs them where they were.
    expect(out.messages[1]).toEqual(tool("c1"))
  })

  test("a shot for a call the request does not carry any more (compacted away) is simply not attached", () => {
    const out = attachShots({ messages: [user("go")] }, new Map([["gone", "data:image/jpeg;base64,X"]]))
    expect(out).toEqual({ messages: [user("go")] })
  })

  test("no shots, or a body without messages, comes back as the same object", () => {
    const body = { messages: [tool("c1")] }
    expect(attachShots(body, new Map())).toBe(body)
    const other = { input: "x" }
    expect(attachShots(other, new Map([["c1", "data:image/jpeg;base64,X"]]))).toBe(other)
    expect(attachShots("text", new Map([["c1", "data:image/jpeg;base64,X"]]))).toBe("text")
  })

  test("withShots rewrites only a JSON body with messages, and leaves every other request alone", async () => {
    const seen: Array<unknown> = []
    const inner: Fetch = async (_input, init) => {
      seen.push(init?.body)
      return new Response("ok")
    }
    const shots = new Map([["c1", "data:image/jpeg;base64,X"]])
    const f = withShots(inner, shots)
    await f("https://x", { method: "POST", body: JSON.stringify({ messages: [tool("c1")] }) })
    await f("https://x", { method: "POST", body: "not json" })
    await f("https://x", { method: "GET" })
    const first = JSON.parse(String(seen[0])) as { messages: Array<{ role: string }> }
    expect(first.messages.map((m) => m.role)).toEqual(["tool", "user"])
    expect(seen[1]).toBe("not json")
    expect(seen[2]).toBeUndefined()
  })
})
