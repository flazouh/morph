import type { Step } from "../session/contract"
import { isChat, rewriting, type Fetch } from "./wire"

const deltaOf = (chunk: unknown): Record<string, unknown> | undefined => {
  if (chunk === null || typeof chunk !== "object") return undefined
  const choices = (chunk as { choices?: unknown }).choices
  const first = Array.isArray(choices) ? choices[0] : undefined
  if (first === null || typeof first !== "object") return undefined
  const delta = (first as { delta?: unknown }).delta
  if (delta === null || typeof delta !== "object") return undefined
  return delta as Record<string, unknown>
}

/** The thinking text on one OpenRouter (or Kimi) stream chunk. Empty when the chunk is answer or tools. */
export const reasoningOf = (chunk: unknown): string => {
  const d = deltaOf(chunk)
  if (d === undefined) return ""
  if (typeof d.reasoning_content === "string" && d.reasoning_content !== "") return d.reasoning_content
  if (typeof d.reasoning === "string" && d.reasoning !== "") return d.reasoning
  if (Array.isArray(d.reasoning_details)) {
    for (const item of d.reasoning_details) {
      if (item === null || typeof item !== "object") continue
      const row = item as Record<string, unknown>
      if (typeof row.text === "string" && row.text !== "") return row.text
      if (typeof row.summary === "string" && row.summary !== "") return row.summary
    }
  }
  return ""
}

/** The answer text on one stream chunk. Empty when the chunk is reasoning or tools. */
export const contentOf = (chunk: unknown): string => {
  const content = deltaOf(chunk)?.content
  return typeof content === "string" ? content : ""
}

/** Grow held thinking: append a delta, replace a snapshot of the full text, ignore a repeat. */
export const applyReasoning = (held: string, piece: string): string => {
  if (piece === "") return held
  if (held === "") return piece
  if (piece.startsWith(held)) return piece
  if (held.endsWith(piece)) return held
  return held + piece
}

const tapSse = (
  body: ReadableStream<Uint8Array>,
  onReasoning: (text: string) => void,
  onContent?: (text: string) => void
): ReadableStream<Uint8Array> => {
  const decoder = new TextDecoder()
  let rest = ""
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk)
        rest += decoder.decode(chunk, { stream: true })
        const lines = rest.split("\n")
        rest = lines.pop() ?? ""
        for (const line of lines) {
          if (!line.startsWith("data:")) continue
          const data = line.slice(5).trim()
          if (data === "" || data === "[DONE]") continue
          try {
            const parsed = JSON.parse(data)
            const reasoning = reasoningOf(parsed)
            if (reasoning !== "") onReasoning(reasoning)
            const content = contentOf(parsed)
            if (content !== "") onContent?.(content)
          } catch {
            // A broken line is left for the model binding; we do not invent thinking from it.
          }
        }
      }
    })
  )
}

/**
 * Ask OpenRouter for reasoning tokens, and call `onDelta` as they stream. The original
 * bytes still reach the model binding, which does not read this field.
 */
export const withReasoning =
  (inner: Fetch, onDelta: (text: string) => void, onContent?: (text: string) => void): Fetch =>
  async (input, init) => {
    const ask = rewriting(inner, (body) => {
      if (!isChat(body) || (body as { reasoning?: unknown }).reasoning !== undefined) return body
      return { ...(body as object), reasoning: { enabled: true } }
    })
    const response = await ask(input, init)
    if (response.body === null) return response
    return new Response(tapSse(response.body, onDelta, onContent), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    })
  }

/** Place the live thinking after the last user. Replace the same step as tokens arrive. */
export const foldThinking = (steps: ReadonlyArray<Step>, text: string, at: number): ReadonlyArray<Step> => {
  if (text.trim() === "") return steps
  let insert = 0
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i]?.kind === "user") {
      insert = i + 1
      break
    }
  }
  const current = steps[insert]
  if (current?.kind === "thinking") {
    if (current.text === text && current.at === at) return steps
    return [...steps.slice(0, insert), { kind: "thinking", text, at: current.at }, ...steps.slice(insert + 1)]
  }
  return [...steps.slice(0, insert), { kind: "thinking", text, at }, ...steps.slice(insert)]
}

/** Place the live answer at the end of the current turn. Replace it as tokens arrive. */
export const foldAnswer = (steps: ReadonlyArray<Step>, text: string, at: number): ReadonlyArray<Step> => {
  if (text.trim() === "") return steps
  let start = 0
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i]?.kind === "user") {
      start = i + 1
      break
    }
  }
  const last = steps[steps.length - 1]
  if (last?.kind === "assistant" && steps.length - 1 >= start) {
    if (last.text === text && last.at === at) return steps
    return [...steps.slice(0, -1), { kind: "assistant", text, at: last.at }]
  }
  return [...steps, { kind: "assistant", text, at }]
}
