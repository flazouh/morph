export type Fetch = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>

/** The request body is a chat request: a JSON object with `messages`. */
export const isChat = (body: unknown): body is { readonly messages: ReadonlyArray<unknown> } =>
  body !== null && typeof body === "object" && Array.isArray((body as { messages?: unknown }).messages)

/**
 * A transport that rewrites JSON request bodies on the way out. `rewrite` gets the parsed
 * body and returns it, or a new one; a body that is not JSON, or that comes back the same
 * reference, goes through untouched. The model binding builds the request; this is how
 * the run adds what the binding does not know about (screenshots, pricing).
 */
export const rewriting =
  (inner: Fetch, rewrite: (body: unknown) => unknown): Fetch =>
  (input, init) => {
    if (typeof init?.body !== "string") return inner(input, init)
    let parsed: unknown
    try {
      parsed = JSON.parse(init.body)
    } catch {
      return inner(input, init)
    }
    const next = rewrite(parsed)
    return next === parsed ? inner(input, init) : inner(input, { ...init, body: JSON.stringify(next) })
  }
