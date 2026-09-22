/**
 * The page's half of `window.__beui.fetch`: post the ask to the window, wait for the answer
 * that carries the ask's id. The content script (bridge/web-page.ts) does the rest.
 *
 * This runs in the page's world as part of the kit, so it imports no Effect: the kit is a
 * page script every redesigned page loads. The one message it reads is matched by an id it
 * minted itself a moment before, and only its `type` and one field are read.
 */
import type { WebPage } from "../bridge/web"
import { PAGE_WEB_ANSWER, PAGE_WEB_ASK, type PageWebAnswer } from "./web-messages"

/** The window as this half needs it: post to itself, hear itself. */
export type PageWindow = Pick<Window, "postMessage" | "addEventListener" | "removeEventListener">

/** A little past the worker's own timeout, so the worker's answer wins when it comes. */
export const PAGE_FETCH_TIMEOUT_MS = 20_000

export interface PageFetchOptions {
  readonly accept?: "text" | "json"
}

const isAnswerFor = (id: string, data: unknown): data is PageWebAnswer => {
  const record = data as Partial<PageWebAnswer> | null
  return record !== null && typeof record === "object" && record.morph === PAGE_WEB_ANSWER && record.id === id && record.answer !== undefined
}

/**
 * `fetch(url, { accept })` resolves with the document the worker read, or rejects with the
 * worker's one-line reason.
 */
export const pageWebFetch =
  (win: PageWindow, timeoutMs: number = PAGE_FETCH_TIMEOUT_MS) =>
  (url: string, options: PageFetchOptions = {}): Promise<WebPage> =>
    new Promise<WebPage>((resolve, reject) => {
      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
      const stop = (): void => {
        clearTimeout(timer)
        win.removeEventListener("message", onMessage as EventListener)
      }
      const onMessage = (event: MessageEvent): void => {
        if (event.source !== win || !isAnswerFor(id, event.data)) return
        stop()
        const { answer } = event.data
        if (answer.type === "webFetched") resolve(answer.page)
        else reject(new Error(`__beui.fetch: ${answer.message}`))
      }
      const timer = setTimeout(() => {
        stop()
        reject(new Error("__beui.fetch: no answer from Morph; is the extension on?"))
      }, timeoutMs)
      win.addEventListener("message", onMessage as EventListener)
      win.postMessage({ morph: PAGE_WEB_ASK, id, url, ...(options.accept === undefined ? {} : { accept: options.accept }) }, "*")
    })
