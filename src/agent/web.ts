import { Context, Effect, Layer, Predicate } from "effect"
import { ask } from "../bridge/messaging"
import { decodeWebAnswer, readWeb, WebFailure, type WebAccept, type WebAsk, type WebPage } from "../bridge/web"

export { WebFailure, type WebAccept, type WebPage } from "../bridge/web"

/**
 * The web as the tools see it: an address in, the document out, read by Morph's own
 * network and not the page's, so an origin the page cannot reach is still readable. The
 * extension binds it to the service worker (bridge/web.ts); tests bind it to a record.
 */
export class Web extends Context.Service<
  Web,
  {
    readonly fetch: (url: string, accept: WebAccept) => Effect.Effect<WebPage, WebFailure>
  }
>()("redesign/Web") {}

/**
 * The binding for the worker itself, where Cursor's tools run. Chrome never delivers
 * `runtime.sendMessage` to the context that sent it, so the worker asking itself would
 * wait on an answer that cannot come; it reads with its own fetch instead.
 */
export const directWeb = (fetcher: typeof fetch): Layer.Layer<Web> => Layer.succeed(Web, { fetch: readWeb(fetcher) })

/** The binding for the card: the ask goes to the service worker, the one context with host permissions. */
export const chromeWeb: Layer.Layer<Web> = Layer.succeed(Web, {
  fetch: Effect.fn("Web.fetch")(function* (url: string, accept: WebAccept): Effect.fn.Return<WebPage, WebFailure> {
    const message: WebAsk = { type: "fetchWeb", url, accept }
    const raw = yield* Effect.tryPromise({
      try: () => ask("fetchWeb", message),
      catch: () => new WebFailure({ message: "the request could not reach the extension" })
    })
    const answer = decodeWebAnswer(raw)
    if (answer === undefined) return yield* new WebFailure({ message: "the extension gave no answer" })
    if (answer.type === "webFailed") return yield* new WebFailure({ message: answer.message })
    return answer.page
  })
})

/** For tests: the given record is the web; an address not in it fails the way a dead host does. */
export const memoryWeb = (pages: Record<string, WebPage | string> = {}): Layer.Layer<Web> =>
  Layer.succeed(Web, {
    fetch: Effect.fnUntraced(function* (url: string, accept: WebAccept): Effect.fn.Return<WebPage, WebFailure> {
      const page = pages[url]
      if (page === undefined) return yield* new WebFailure({ message: "the request failed" })
      if (!Predicate.isString(page)) return page
      return { url, status: 200, contentType: accept === "json" ? "application/json" : "text/plain", body: page, truncated: false }
    })
  })
