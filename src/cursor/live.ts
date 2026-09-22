/**
 * The Cursor host as the service worker runs it.
 *
 * One set of services is built once and shared by every thread, because thread ownership
 * and the relay link are worker-wide. Each thread then gets its own scope, so closing one
 * thread releases its socket, its tool server and its SSE reader, and no other thread's.
 */

import { Context, Effect, Exit, Layer, Scope } from "effect"
import { signal } from "../bridge/messaging"
import { RelayLink, RelayThreadOwnership } from "../relay/extension"
import { chromeSettings } from "../session/settings"
import { chromeLibraryMemory } from "../marketplace/library"
import { installedReleaseOn } from "../marketplace/sandbox/installed"
import { createExtensionPublisher } from "../marketplace/publishing/extension"
import type { PublisherAsk } from "../marketplace/publishing/messages"
import type { PagePublisher } from "../agent/page-publish-tools"
import { directWeb } from "../agent/web"
import { forgetPageOf, forgetSiteOf, worldFor, type PageTab } from "../session/world"
import { CursorClient } from "./api"
import { cursorHost, type CursorHost, type LiveCursorSession } from "./host"
import type { CursorUpdate } from "./messages"
import { forgetCursorThread, makeCursorSession } from "./session"
import { CursorStore } from "./state"
import { chromeCursorStore } from "./steps"

/** Morph's deployed relay. The cloud agent reaches the reader's browser through it. */
export const RELAY_URL = "https://morph-relay-production.up.railway.app"

type Services = CursorClient | CursorStore | RelayLink | RelayThreadOwnership

const SERVICES = Layer.mergeAll(
  CursorClient.layer,
  chromeCursorStore,
  RelayLink.webSocketLayer,
  RelayThreadOwnership.layer
)

const workerScope = Effect.runSync(Scope.make())
let built: Promise<Context.Context<Services>> | undefined

const services = (): Promise<Context.Context<Services>> => {
  built ??= Effect.runPromise(Scope.provide(Layer.build(SERVICES), workerScope))
  return built
}

/**
 * The page's own redesign publishes as a new package only when the page runs no installed
 * Morph. On an installed one, publishing would release another author's work under a new
 * name, so the thread gets no publish tools there.
 */
/**
 * The worker cannot ask itself. A Cursor thread runs its tools here, so its publisher calls
 * the worker's own handler in hand rather than sending a `publisher` message that only this
 * context listens for: Chrome never delivers a message back to its sender, and the call
 * died as "The message port closed before a response was received." The panel keeps the
 * message, since its publisher really is in another context.
 */
const publisherFor = async (tab: PageTab): Promise<PagePublisher | undefined> =>
  installedReleaseOn(await chromeLibraryMemory.read(), new URL(tab.url)) === undefined
    ? createExtensionPublisher(handlePublisher, tab.id)
    : undefined

const openCursorThread = async (input: {
  readonly threadId: string
  readonly url: string
  readonly tabId: number
}): Promise<LiveCursorSession> => {
  const context = await services()
  const scope = Effect.runSync(Scope.make())
  const tab: PageTab = { id: input.tabId, url: input.url }
  const read = () => chromeSettings.read()
  const publisher = await publisherFor(tab)
  const session = await Effect.runPromise(
    Scope.provide(
      Effect.provide(
        makeCursorSession({
          url: input.url,
          threadId: input.threadId,
          tabId: input.tabId,
          relayUrl: RELAY_URL,
          settings: read,
          world: worldFor(tab, directWeb(fetch)),
          forget: () => forgetPageOf(tab),
          forgetSite: () => forgetSiteOf(tab),
          ...(publisher === undefined ? {} : { publisher })
        }),
        context
      ),
      scope
    )
  )
  return {
    session,
    close: async () => {
      // A released thread stops its own run: nothing is left reading a stream no one owns.
      await session.stop().catch(() => undefined)
      await Effect.runPromise(Scope.close(scope, Exit.void))
    }
  }
}

const forgetThread = async (threadId: string): Promise<void> => {
  const context = await services()
  const settings = await chromeSettings.read()
  await Effect.runPromise(Effect.provide(forgetCursorThread(threadId, settings.cursorKey), context))
}

/** Every open panel hears the update. A push with no listener is not an error. */
const publish = (update: CursorUpdate): void => {
  signal("cursorUpdate", update)
}

let host: CursorHost | undefined
/** The worker's own publisher handler, given by the worker when it starts the host. */
let handlePublisher: ((ask: PublisherAsk) => Promise<unknown>) | undefined

export const liveCursorHost = (publisher: (ask: PublisherAsk) => Promise<unknown>): CursorHost => {
  handlePublisher = publisher
  return (host ??= cursorHost({ open: openCursorThread, forget: forgetThread, publish }))
}
