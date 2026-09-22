/**
 * The two messages the page's world and the content script's world exchange over their
 * shared window for `window.__beui.fetch`. The kit bundle runs in every page, so this file
 * imports the bridge's types only: a type import is erased at build and pulls no Effect.
 */
import type { WebAnswer } from "../bridge/web"

export const PAGE_WEB_ASK = "morph:fetchWeb"
export const PAGE_WEB_ANSWER = "morph:webAnswer"

export interface PageWebAnswer {
  readonly morph: typeof PAGE_WEB_ANSWER
  readonly id: string
  readonly answer: WebAnswer
}
