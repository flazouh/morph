/** Ask the tab under the toolbar click to show or hide the in-page card. */

import { ask, unanswered } from "../bridge/messaging"
import { isCrewAsk, type CrewAsk, type OverlayAsk } from "./messages"

type PageOverlayAsk = OverlayAsk | CrewAsk

export interface TabPort {
  readonly send: (tabId: number, message: PageOverlayAsk) => Promise<void>
  readonly inject: (tabId: number) => Promise<void>
}

/** The real tab: an overlay or crew ask to the content host on that tab. */
export const chromeTabSend: TabPort["send"] = async (tabId, message) => {
  await (isCrewAsk(message) ? ask("crew", message, { tabId }) : ask("overlay", message, { tabId }))
}

export const sendOrInject = async (tabId: number, message: OverlayAsk, port: TabPort): Promise<void> => {
  try {
    await port.send(tabId, message)
  } catch (e) {
    if (!unanswered(e)) throw e
    await port.inject(tabId)
    await port.send(tabId, message)
  }
}

/** Hide the card for one action (a screenshot), then put it back even if the action fails. */
export const withChatHidden = async <A>(tabId: number, port: Pick<TabPort, "send">, action: () => Promise<A>): Promise<A> => {
  for (const message of [{ type: "hideChat" }, { type: "hideCrewBots" }] as const) {
    try {
      await port.send(tabId, message)
    } catch {
      // No content script, or the overlay is not on this page.
    }
  }
  try {
    return await action()
  } finally {
    for (const message of [{ type: "showCrewBots" }, { type: "showChat" }] as const) {
      try {
        await port.send(tabId, message)
      } catch {
        // Same: nothing to restore.
      }
    }
  }
}
