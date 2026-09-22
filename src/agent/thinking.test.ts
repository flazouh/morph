import { describe, expect, test } from "bun:test"
import { applyReasoning, contentOf, foldAnswer, foldThinking, reasoningOf, withReasoning } from "./thinking"
import type { Step } from "../session/contract"

describe("reasoningOf", () => {
  test("reads the OpenRouter and Kimi fields on a stream chunk", () => {
    expect(reasoningOf({ choices: [{ delta: { reasoning: "a" } }] })).toBe("a")
    expect(reasoningOf({ choices: [{ delta: { reasoning_content: "b" } }] })).toBe("b")
    expect(reasoningOf({ choices: [{ delta: { reasoning_details: [{ type: "reasoning.text", text: "c" }] } }] })).toBe("c")
    expect(reasoningOf({ choices: [{ delta: { content: "hi" } }] })).toBe("")
    expect(reasoningOf(null)).toBe("")
    expect(reasoningOf({ choices: [{ delta: { reasoning: "Compact", reasoning_content: "Compact" } }] })).toBe("Compact")
  })
})

describe("applyReasoning", () => {
  test("appends a delta, replaces when the chunk is the full text so far, and drops a repeat", () => {
    expect(applyReasoning("", "Compact")).toBe("Compact")
    expect(applyReasoning("Compact", " design")).toBe("Compact design")
    expect(applyReasoning("Compact", "Compact design")).toBe("Compact design")
    expect(applyReasoning("Compact design", " design")).toBe("Compact design")
  })
})

describe("contentOf", () => {
  test("reads answer text and ignores reasoning, tools, and empty chunks", () => {
    expect(contentOf({ choices: [{ delta: { content: "Hi" } }] })).toBe("Hi")
    expect(contentOf({ choices: [{ delta: { content: "" } }] })).toBe("")
    expect(contentOf({ choices: [{ delta: { reasoning_content: "think" } }] })).toBe("")
    expect(contentOf({ choices: [{ delta: { content: null } }] })).toBe("")
    expect(contentOf(null)).toBe("")
    expect(contentOf({ choices: [] })).toBe("")
  })
})

describe("foldAnswer", () => {
  const user: Step = { kind: "user", text: "dark", at: 1 }
  const tool: Step = { kind: "tool", callId: "c1", name: "read_page", input: {}, at: 2 }
  const prior: Step = { kind: "assistant", text: "Reading first.", at: 3 }

  test("grows the trailing assistant step, and appends after tools", () => {
    expect(foldAnswer([user, tool], "", 4)).toEqual([user, tool])
    const first = foldAnswer([user, tool], "Ap", 4)
    expect(first).toEqual([user, tool, { kind: "assistant", text: "Ap", at: 4 }])
    expect(foldAnswer(first, "Applied.", 5)).toEqual([user, tool, { kind: "assistant", text: "Applied.", at: 4 }])
    expect(foldAnswer([user, prior, tool], "Done.", 6)).toEqual([
      user,
      prior,
      tool,
      { kind: "assistant", text: "Done.", at: 6 }
    ])
  })
})

describe("foldThinking", () => {
  const user: Step = { kind: "user", text: "dark", at: 1 }
  const tool: Step = { kind: "tool", callId: "c1", name: "read_page", input: {}, at: 2 }
  const answer: Step = { kind: "assistant", text: "done", at: 3 }

  test("puts thinking after the last user, and replaces it as tokens arrive", () => {
    expect(foldThinking([user, tool, answer], "", 4)).toEqual([user, tool, answer])
    const first = foldThinking([user, tool], "The list is dense.", 4)
    expect(first).toEqual([user, { kind: "thinking", text: "The list is dense.", at: 4 }, tool])
    expect(foldThinking(first, "The list is dense. Restyle it.", 4)).toEqual([
      user,
      { kind: "thinking", text: "The list is dense. Restyle it.", at: 4 },
      tool
    ])
  })
})

describe("withReasoning", () => {
  test("asks OpenRouter for reasoning and forwards each reasoning delta", async () => {
    const bodies: unknown[] = []
    const sse = [
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "Look" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: " at body" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`,
      "data: [DONE]\n\n"
    ].join("")
    const inner = (_: unknown, init?: RequestInit) => {
      bodies.push(init?.body)
      return Promise.resolve(new Response(sse, { headers: { "Content-Type": "text/event-stream" } }))
    }
    const deltas: string[] = []
    const wrapped = withReasoning(inner as never, (text) => deltas.push(text))
    const response = await wrapped("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "moonshotai/kimi-k3", messages: [] })
    })
    expect(JSON.parse(String(bodies.at(-1)))).toEqual({
      model: "moonshotai/kimi-k3",
      messages: [],
      reasoning: { enabled: true }
    })
    expect(await response.text()).toContain("ok")
    expect(deltas.join("")).toBe("Look at body")
  })

  test("forwards answer tokens apart from reasoning", async () => {
    const sse = [
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "Look" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Ap" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "plied." } }] })}\n\n`,
      "data: [DONE]\n\n"
    ].join("")
    const inner = () => Promise.resolve(new Response(sse, { headers: { "Content-Type": "text/event-stream" } }))
    const thinking: string[] = []
    const answer: string[] = []
    const wrapped = withReasoning(inner as never, (text) => thinking.push(text), (text) => answer.push(text))
    const response = await wrapped("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "moonshotai/kimi-k3", messages: [] })
    })
    expect(await response.text()).toContain("plied.")
    expect(thinking).toEqual(["Look"])
    expect(answer).toEqual(["Ap", "plied."])
  })
})
