/**
 * The content script's half of `window.__beui.fetch`.
 *
 * The kit runs in the page's world, where there is no chrome.runtime to ask. So it posts
 * the ask to its own window (kit/web.ts), this world, which shares the window, carries it
 * to the worker (bridge/web.ts), and posts the answer back under the ask's id.
 *
 * Any script on the page can post the same message. That is why the worker serves a tab
 * only while the page wears a Morph (webSenderAllowed), and why the read itself carries no
 * cookies and hands back text only.
 */
import { Option, Schema } from "effect"
import { decodeWebAnswer, WebAccept, type WebAnswer, type WebAsk } from "./web"
import { PAGE_WEB_ANSWER, PAGE_WEB_ASK, type PageWebAnswer } from "../kit/web-messages"

/** What the page's world posts: a fetchWeb ask with an id to match the answer by. */
const PageWebAsk = Schema.Struct({
  morph: Schema.Literal(PAGE_WEB_ASK),
  id: Schema.String,
  url: Schema.String,
  accept: Schema.optionalKey(WebAccept)
})

const pageAskOf = Schema.decodeUnknownOption(PageWebAsk)

/** The window as this half needs it: hear itself, post to itself. */
export type BridgeWindow = Pick<Window, "postMessage" | "addEventListener" | "removeEventListener">

/**
 * Every fetchWeb ask the window posts goes to `send` (the worker), and the answer comes
 * back on the same window under the ask's id. Returns the function that stops listening.
 */
export const relayWebAsks = (win: BridgeWindow, send: (ask: WebAsk) => Promise<unknown>): (() => void) => {
  const onMessage = (event: MessageEvent): void => {
    if (event.source !== win) return
    const decoded = pageAskOf(event.data)
    if (Option.isNone(decoded)) return
    const { id, url, accept } = decoded.value
    const ask: WebAsk = { type: "fetchWeb", url, ...(accept === undefined ? {} : { accept }) }
    void send(ask)
      .then(
        (answer): WebAnswer => decodeWebAnswer(answer) ?? { type: "webFailed", message: "the extension gave no answer" },
        (): WebAnswer => ({ type: "webFailed", message: "the request could not reach the extension" })
      )
      .then((answer) => {
        const reply: PageWebAnswer = { morph: PAGE_WEB_ANSWER, id, answer }
        win.postMessage(reply, "*")
      })
  }
  win.addEventListener("message", onMessage as EventListener)
  return () => win.removeEventListener("message", onMessage as EventListener)
}
