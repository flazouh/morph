/**
 * Every message between Morph's extension contexts, typed once.
 *
 * The transport is `@webext-core/messaging`: one envelope `{ id, type, data, timestamp }`,
 * one listener per type per context, a thrown handler error travels back as a rejection,
 * and a message no handler claims rejects with "No response" instead of resolving to
 * `undefined`. The handler still sees Chrome's own `sender`, so the worker keeps judging
 * a message by the frame URL it came from.
 *
 * Three receivers, told apart by how a message is sent:
 * - the worker hears an `ask` sent with no tab, from the card or a content host;
 * - a content host hears an `ask` sent with its tab id;
 * - every open card hears a `signal` the worker sends, because Chrome fans
 *   `runtime.sendMessage` out to every extension page.
 *
 * Chrome never delivers a message to the context that sent it. A context that needs its
 * own service calls it (see `directWeb`); it does not message itself.
 *
 * The `Protocol` types what a sender promises. The data still crosses a process boundary,
 * so every `answer` decodes it with the family's own decoder before the handler sees it;
 * a shape the decoder refuses is thrown back to the sender as a rejection.
 *
 * The library's own generic is left at its default: TypeScript cannot hold the union of
 * every Schema-derived ask in this map inside one generic call (TS2590), so the typing
 * lives in the thin functions below instead.
 */

import { defineExtensionMessaging } from "@webext-core/messaging"
import type { CursorAnswer, CursorAsk, CursorUpdate } from "../cursor/messages"
import type { InspectorAnswer, InspectorAsk } from "../inspector/messages"
import type { PackageCompileAnswer, PackageCompileAsk } from "../marketplace/compiler/message"
import type { ForkPreviewAnswer, ForkPreviewAsk } from "../marketplace/forks/preview"
import type { ForkDraftAnswer, ForkDraftAsk, MarketplaceAnswer, MarketplaceAsk } from "../marketplace/messages"
import type {
  MarketplacePreviewAnswer,
  MarketplacePreviewAsk,
  PagePreviewAnswer,
  PagePreviewAsk
} from "../marketplace/preview"
import type { PublisherAnswer, PublisherAsk } from "../marketplace/publishing/messages"
import type { AssetAnswer, AssetAsk } from "../marketplace/sandbox/asset"
import type { CrewAsk, OverlayAsk, OverlaySignal } from "../overlay/messages"
import type { PanelSessionAnswer, PanelSessionAsk } from "../overlay/panel-attest"
import type { PageAnswer, PageAsk } from "./messages"
import type { UserScriptsAsk, UserScriptsStatus } from "./user-scripts"
import type { WebAnswer, WebAsk } from "./web"

/** The host's acknowledgement of a command that has no result. */
export interface Acknowledged {
  readonly type: "ok"
}

export interface Protocol {
  // Heard by the service worker.
  cursor(ask: CursorAsk): CursorAnswer
  panelSession(ask: PanelSessionAsk): PanelSessionAnswer
  userScripts(ask: UserScriptsAsk): UserScriptsStatus
  inspector(ask: InspectorAsk): InspectorAnswer
  asset(ask: AssetAsk): AssetAnswer
  fetchWeb(ask: WebAsk): WebAnswer
  packageCompile(ask: PackageCompileAsk): PackageCompileAnswer
  publisher(ask: PublisherAsk): PublisherAnswer
  forkDraft(ask: ForkDraftAsk): ForkDraftAnswer
  marketplacePreview(ask: MarketplacePreviewAsk): MarketplacePreviewAnswer
  marketplace(ask: MarketplaceAsk): MarketplaceAnswer
  overlaySignal(signal: OverlaySignal): void

  // Heard by a tab's content host.
  page(ask: PageAsk): PageAnswer
  pagePreview(ask: PagePreviewAsk): PagePreviewAnswer
  forkPreview(ask: ForkPreviewAsk): ForkPreviewAnswer
  overlay(ask: OverlayAsk): Acknowledged
  crew(ask: CrewAsk): Acknowledged

  // Heard by every open card.
  cursorUpdate(update: CursorUpdate): void
}

export type Kind = keyof Protocol
export type Data<K extends Kind> = Parameters<Protocol[K]>[0]
export type Answer<K extends Kind> = ReturnType<Protocol[K]>
/** The kinds with no answer: sent and forgotten. */
type Signal = { [K in Kind]: Answer<K> extends void ? K : never }[Kind]

/** What a handler learns about the message besides its data. */
export type Sender = chrome.runtime.MessageSender

const transport = defineExtensionMessaging()

/**
 * Sends an ask and waits for its answer. No tab means the worker; a tab means its content
 * host. Rejects when no listener claims the ask or the handler throws.
 */
export const ask = <K extends Kind>(type: K, data: Data<K>, target?: { readonly tabId: number }): Promise<Answer<K>> =>
  transport.sendMessage(type, data, target?.tabId)

/**
 * Sends and forgets: a signal has no answer, and the worker may be asleep with no one
 * listening, which is not an error the sender can act on.
 */
export const signal = <K extends Signal>(type: K, data: Data<K>): void => {
  void transport.sendMessage(type, data).catch(() => undefined)
}

/**
 * True when nobody was there to answer: a tab with no content script yet, or a worker
 * that was not listening. Chrome names the first on the worker path; the transport
 * reports the tab path as "No response", because it does not read `lastError` there.
 */
export const unanswered = (error: unknown): boolean =>
  error instanceof Error && (error.message === "No response" || error.message.includes("Receiving end does not exist"))

/** A family's decoder: its ask from the wire, or `undefined` for a shape it does not know. */
export type Decoder<K extends Kind> = (value: unknown) => Data<K> | undefined

/** The same, from a family whose decoder is a type guard. */
export const accepting =
  <K extends Kind>(accept: (value: unknown) => value is Data<K>): Decoder<K> =>
  (value) => (accept(value) ? value : undefined)

/**
 * Answers one kind of ask in this context. The data is decoded before the handler sees
 * it; a shape the decoder refuses rejects the sender, so a bad ask is heard, not silent.
 */
export const answer = <K extends Kind>(
  type: K,
  decode: Decoder<K>,
  handle: (data: Data<K>, sender: Sender) => Answer<K> | Promise<Answer<K>>
): (() => void) =>
  transport.onMessage(type, (message) => {
    const data = decode(message.data)
    if (data === undefined) throw new Error(`the ${type} ask was malformed`)
    return handle(data, message.sender)
  })

/** Forgets every handler in this context; for tests. */
export const forgetAnswers = (): void => transport.removeAllListeners()
