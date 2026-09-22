/**
 * Reading a document over the web for a redesign, in the one place in Morph that may.
 *
 * A page's own network is bound by its origin: a skin on cineswellington.com cannot ask
 * an API on another host, so a rating, a feed or a JSON endpoint is out of its reach. The
 * service worker holds the extension's own host permissions and is not bound that way.
 *
 * So the agent's `fetch_url` tool asks the worker, and a skin on the page asks through
 * `window.__beui.fetch`, which the content script carries to the worker. Both get the same
 * read: GET only, without the reader's cookies, text and JSON only, cut at a fixed size.
 * That is what keeps the worker from being a proxy for anything more than public text.
 */
import { Effect, Option, Schema } from "effect"

export const WebAccept = Schema.Literals(["text", "json"])
export type WebAccept = typeof WebAccept.Type

export const WebAsk = Schema.Struct({
  type: Schema.Literal("fetchWeb"),
  url: Schema.String,
  /** What to say in `Accept`. Defaults to text; `json` asks for JSON and leaves the body as its text. */
  accept: Schema.optionalKey(WebAccept)
})
export type WebAsk = typeof WebAsk.Type

/** What a read gives back: the status as the server sent it, and the body as text. */
export const WebPage = Schema.Struct({
  url: Schema.String,
  status: Schema.Number,
  contentType: Schema.String,
  body: Schema.String,
  /** True when the body was cut at `WEB_LIMITS.bodyChars`. */
  truncated: Schema.Boolean
})
export type WebPage = typeof WebPage.Type

export const WebAnswer = Schema.Union([
  Schema.Struct({ type: Schema.Literal("webFetched"), page: WebPage }),
  Schema.Struct({ type: Schema.Literal("webFailed"), message: Schema.String })
])
export type WebAnswer = typeof WebAnswer.Type

const askOf = Schema.decodeUnknownOption(WebAsk)
const answerOf = Schema.decodeUnknownOption(WebAnswer)

export const decodeWebAsk = (value: unknown): WebAsk | undefined => Option.getOrUndefined(askOf(value))
export const decodeWebAnswer = (value: unknown): WebAnswer | undefined => Option.getOrUndefined(answerOf(value))

/** The read did not give a document. `message` is one line the caller may show; nothing of the response travels in it. */
export class WebFailure extends Schema.TaggedError<WebFailure>()("WebFailure", { message: Schema.String }) {}

export const WEB_LIMITS = {
  /** The most of a body that travels: enough for a JSON endpoint or an article, not a whole site. */
  bodyChars: 100_000,
  /** How long one read may take before it is a failure. */
  timeoutMs: 15_000
} as const

const TEXT_TYPES = ["text/", "application/json", "application/xml", "application/javascript", "application/ld+json"]
const isText = (contentType: string): boolean =>
  TEXT_TYPES.some((prefix) => contentType.startsWith(prefix)) || /^application\/[a-z.+-]+\+(json|xml)/.test(contentType)

/** Only the web: no extension pages, no files, no chrome:// pages. */
export const WebUrl = Schema.URLFromString.pipe(
  Schema.check(Schema.makeFilter((url: URL) => url.protocol === "https:" || url.protocol === "http:", { title: "webUrl" }))
)
const webUrlOf = Schema.decodeUnknownOption(WebUrl)
export const isWebUrl = (url: string): boolean => Option.isSome(webUrlOf(url))

const ONLY_HTTP = "only http and https addresses can be fetched"

/**
 * The read itself, for the worker to run. Without the reader's cookies: a request whose
 * address a model or a page chose must not be one that carries their session. A non-2xx
 * answer is still an answer; the caller sees the status and decides.
 */
export const readWeb = (fetcher: typeof fetch) =>
  Effect.fn("web.read")(function* (url: string, accept: WebAccept = "text"): Effect.fn.Return<WebPage, WebFailure> {
    if (!isWebUrl(url)) return yield* new WebFailure({ message: ONLY_HTTP })
    const response = yield* Effect.tryPromise({
      try: () =>
        fetcher(url, {
          method: "GET",
          headers: { Accept: accept === "json" ? "application/json" : "text/html, text/plain, application/json;q=0.9, */*;q=0.5" },
          credentials: "omit",
          redirect: "follow",
          referrerPolicy: "no-referrer",
          signal: AbortSignal.timeout(WEB_LIMITS.timeoutMs)
        }),
      catch: (cause) =>
        new WebFailure({ message: cause instanceof Error && cause.name === "TimeoutError" ? "the request timed out" : "the request failed" })
    })
    const contentType = (response.headers.get("content-type") ?? "").toLowerCase()
    if (contentType !== "" && !isText(contentType)) {
      return yield* new WebFailure({ message: `the answer is ${contentType.split(";")[0]}, not text or JSON` })
    }
    const text = yield* Effect.tryPromise({ try: () => response.text(), catch: () => new WebFailure({ message: "the body could not be read" }) })
    const truncated = text.length > WEB_LIMITS.bodyChars
    return {
      url: response.url === "" ? url : response.url,
      status: response.status,
      contentType,
      body: truncated ? text.slice(0, WEB_LIMITS.bodyChars) : text,
      truncated
    }
  })

/** Who is asking: one of Morph's own pages (the panel), or a content script on a tab. */
export interface WebSender {
  readonly url?: string
  readonly tab?: { readonly url?: string }
}

export const NOT_A_MORPH_PAGE = "this page wears no Morph, so it cannot fetch through Morph"

/**
 * Whether an ask may be served. Morph's own pages always may: that is the agent's tool. A
 * page may only while it wears a Morph, since `window.__beui.fetch` is readable by any
 * script on the page and the worker must not be every site's proxy. `wears` says whether
 * the tab's page has a registration.
 */
export const webSenderAllowed = async (sender: WebSender, extensionOrigin: string, wears: (url: string) => Promise<boolean>): Promise<boolean> => {
  if (sender.url !== undefined && sender.url.startsWith(extensionOrigin)) return true
  const url = sender.tab?.url
  if (url === undefined) return false
  return wears(url)
}

/** The worker's side of the ask. */
export const webHandler =
  (fetcher: typeof fetch, allowed: (sender: WebSender) => Promise<boolean> = () => Promise.resolve(true)) =>
  async (message: WebAsk, sender: WebSender = {}): Promise<WebAnswer> => {
    if (!(await allowed(sender))) return { type: "webFailed", message: NOT_A_MORPH_PAGE }
    return Effect.runPromise(
      readWeb(fetcher)(message.url, message.accept).pipe(
        Effect.map((page): WebAnswer => ({ type: "webFetched", page })),
        Effect.catchTag("WebFailure", (failure) => Effect.succeed<WebAnswer>({ type: "webFailed", message: failure.message }))
      )
    )
  }
