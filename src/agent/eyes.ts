/**
 * The agent's eyes. The harness carries text only: a tool answers with a value, the value
 * is journalled and rendered as a tool message. A screenshot is neither small enough for
 * the log nor a thing a tool message can hold on the wire. So a shot lives outside the
 * log, in memory, keyed by the call that took it, and rides into the request at the last
 * step: the fetch that leaves for the model gets a user message with the image, right
 * after the tool message that announced it. The log keeps a one-line note; a panel that
 * reloads has the note and no picture, which is the right trade.
 */

export type Shots = Map<string, string>

/** The `look` tool's answer: a picture the run takes out before the log sees the result. */
export class Shot {
  constructor(readonly image: string) {}
}

/** What the log holds in the picture's place: a note the model reads before the picture follows. */
export const SHOT_NOTE = { ok: true, image: "the screenshot follows as an image" } as const

/** The width a screenshot is scaled to before it goes to the model: enough to read a layout, cheap to send. */
export const LOOK_WIDTH = 1024

/**
 * A capture at the screen's own pixel density is large and the model does not need it.
 * The browser scales it here; a runtime without images (the tests) keeps it as it was.
 */
export const shrink = async (dataUrl: string, width: number = LOOK_WIDTH): Promise<string> => {
  if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas !== "function") return dataUrl
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob())
  if (bitmap.width <= width) return dataUrl
  const canvas = new OffscreenCanvas(width, Math.round((bitmap.height * width) / bitmap.width))
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.8 })
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

interface WireMessage {
  readonly role: string
  readonly tool_call_id?: string
  readonly content?: unknown
}

const OLDER = "(an earlier screenshot, no longer shown; the latest one is below)"

/**
 * The request body with the shots attached: after each tool message whose call took a
 * shot, a user message. The latest shot is the picture; the earlier ones are a line of
 * text, so a long session does not resend every frame it ever looked at.
 */
export const attachShots = (body: unknown, shots: ReadonlyMap<string, string>): unknown => {
  if (shots.size === 0 || typeof body !== "object" || body === null || !Array.isArray((body as { messages?: unknown }).messages)) return body
  const messages = (body as { messages: ReadonlyArray<WireMessage> }).messages
  const taken = messages.filter((m) => m.role === "tool" && m.tool_call_id !== undefined && shots.has(m.tool_call_id))
  const latest = taken[taken.length - 1]?.tool_call_id
  const out: Array<WireMessage> = []
  for (const m of messages) {
    out.push(m)
    if (m.role !== "tool" || m.tool_call_id === undefined) continue
    const shot = shots.get(m.tool_call_id)
    if (shot === undefined) continue
    out.push(
      m.tool_call_id === latest
        ? { role: "user", content: [{ type: "text", text: "The screenshot:" }, { type: "image_url", image_url: { url: shot } }] }
        : { role: "user", content: OLDER }
    )
  }
  return { ...(body as object), messages: out }
}

export type Fetch = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>

/** The transport with the shots attached to every request that carries messages. */
export const withShots =
  (inner: Fetch, shots: ReadonlyMap<string, string>): Fetch =>
  (input, init) => {
    if (typeof init?.body !== "string") return inner(input, init)
    let parsed: unknown
    try {
      parsed = JSON.parse(init.body)
    } catch {
      return inner(input, init)
    }
    const attached = attachShots(parsed, shots)
    return attached === parsed ? inner(input, init) : inner(input, { ...init, body: JSON.stringify(attached) })
  }
