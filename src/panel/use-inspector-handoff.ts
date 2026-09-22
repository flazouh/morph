import { useEffect, useRef } from "react"
import { isHostToPanelInspectorMessage, type PanelToHostInspectorAck } from "@/overlay/messages"
import { chromeValidatePanelSession } from "@/overlay/panel-attest"
import { readPanelNonce } from "@/overlay/panel-session"
import type { Session } from "@/session"

export interface InspectorHandoffOptions {
  readonly embedded: boolean
  readonly session: Session | null
  readonly working: boolean
  readonly onSend: (text: string) => void
  readonly onSteer: (text: string) => void
  /** Injected in tests. Defaults to asking the service worker about this frame's nonce. */
  readonly validateSession?: (nonce: string) => Promise<boolean>
}

/** How many accepted hand-off request IDs the panel remembers before dropping the oldest. */
export const HANDOFF_SEEN_IDS_LIMIT = 64

export const handoffAckTargetOrigin = (origin: string): string => (origin === "null" ? "*" : origin)

const postAck = (ack: PanelToHostInspectorAck, origin: string): void => {
  window.parent.postMessage(ack, handoffAckTargetOrigin(origin))
}

const rememberRequestId = (seen: Set<string>, requestId: string): void => {
  seen.add(requestId)
  while (seen.size > HANDOFF_SEEN_IDS_LIMIT) {
    const oldest = seen.values().next().value
    if (oldest === undefined) break
    seen.delete(oldest)
  }
}

interface LatestHandlers {
  readonly session: Session | null
  readonly working: boolean
  readonly onSend: (text: string) => void
  readonly onSteer: (text: string) => void
  readonly validateSession: (nonce: string) => Promise<boolean>
}

/**
 * Accepts a host hand-off when the nonce matches this frame's URL secret, and only after
 * the service worker confirms that Morph's own content host registered that nonce for
 * this tab. `panel.html` is web accessible, so a hostile page can frame it with a nonce
 * it chose itself and post a matching message; matching a self-chosen hash proves
 * nothing, and such a panel never reaches `onSend` or `onSteer`.
 */
export const useInspectorHandoff = ({
  embedded,
  session,
  working,
  onSend,
  onSteer,
  validateSession = chromeValidatePanelSession
}: InspectorHandoffOptions): void => {
  // One ref for every prop the message listener needs at delivery time, so the listener
  // effect below only depends on `embedded` and never reinstalls its `message` listener
  // just because the reader started typing or a new session mounted.
  const latestRef = useRef<LatestHandlers>({ session, working, onSend, onSteer, validateSession })
  const seenRef = useRef<Set<string> | null>(null)

  useEffect(() => {
    latestRef.current = { session, working, onSend, onSteer, validateSession }
  }, [session, working, onSend, onSteer, validateSession])

  useEffect(() => {
    if (!embedded) return
    const nonce = readPanelNonce(window.location)
    if (nonce === null) return

    const onMessage = (event: MessageEvent): void => {
      if (event.source !== window.parent || !isHostToPanelInspectorMessage(event.data)) return
      if (event.data.nonce !== nonce) return
      const latest = latestRef.current
      if (latest.session === null) return

      const seen = seenRef.current
      if (seen?.has(event.data.requestId)) {
        postAck({ type: "inspectorHandoffAck", requestId: event.data.requestId }, event.origin)
        return
      }

      rememberRequestId(seenRef.current ?? (seenRef.current = new Set()), event.data.requestId)
      postAck({ type: "inspectorHandoffAck", requestId: event.data.requestId }, event.origin)

      if (latest.working) latest.onSteer(event.data.prompt)
      else latest.onSend(event.data.prompt)
    }

    // The listener goes on only after the worker vouches for this nonce. A check that
    // says no, or one that cannot be made at all, leaves this panel silent.
    let wanted = true
    void latestRef.current.validateSession(nonce).then(
      (attested) => {
        if (wanted && attested) window.addEventListener("message", onMessage)
      },
      () => {}
    )
    return () => {
      wanted = false
      window.removeEventListener("message", onMessage)
    }
  }, [embedded])
}
