import { Deferred, Effect, Layer, Queue } from "effect"
import { Designs } from "../agent/designs"
import { Page, PageFailure } from "../agent/page"
import { Compiler } from "../skin/service"
import { memoryWeb } from "../agent/web"
import { CREW_TOOL_NAMES, MORPH_TOOL_NAMES, TOOL_NAMES, type ToolName } from "../agent/tool-names"
import { RelayLink, type RelayConnection, type RelayConnectionError } from "./extension"
import type { SocketInbound, SocketOutbound } from "./protocol"

/** Test doubles the relay tests share: a page world, an in-memory relay link, and a poll. */

/**
 * What a Cursor run offers the cloud agent: the canonical list without the tools that
 * need a context this side never builds. Crew bots and Morph drafts belong to an
 * OpenRouter run in the panel, so `toolsFor` drops them here.
 */
export type CursorToolName = Exclude<
  ToolName,
  (typeof CREW_TOOL_NAMES)[number] | (typeof MORPH_TOOL_NAMES)[number]
>
const NEEDS_A_CONTEXT = new Set<string>([...CREW_TOOL_NAMES, ...MORPH_TOOL_NAMES])
export const CURSOR_TOOL_NAMES: ReadonlyArray<CursorToolName> = TOOL_NAMES.filter(
  (name): name is CursorToolName => !NEEDS_A_CONTEXT.has(name)
)

export const fakeWorld = (
  events: string[] = [],
  options: {
    readonly lookError?: string
    readonly readGate?: Deferred.Deferred<void>
  } = {}
) =>
  Layer.mergeAll(
    Layer.succeed(Page, {
      read: (selector) =>
        Effect.gen(function* () {
          if (options.readGate !== undefined) yield* Deferred.await(options.readGate)
          events.push(`read:${selector ?? "body"}`)
          return {
            url: "https://example.com/products",
            title: "Products",
            viewport: { width: 1200, height: 800 },
            stylesheets: [],
            outline: "body\n  main Products",
            nodes: 2,
            truncated: false
          }
        }),
      styles: () => Effect.succeed([]),
      text: () => Effect.succeed(["Products"]),
      tokens: () => Effect.succeed({ theme: "light", tokens: {} }),
      style: (css) =>
        Effect.sync(() => {
          events.push(`style:${css}`)
        }),
      design: () => Effect.void,
      run: () => Effect.succeed(null),
      skin: () => Effect.void,
      kit: () => Effect.void,
      forget: () => Effect.void,
      forgetSite: () => Effect.void,
      look: () =>
        options.lookError === undefined
          ? Effect.succeed("data:image/jpeg;base64,aW1hZ2U=")
          : Effect.fail(new PageFailure(options.lookError))
    }),
    Layer.succeed(Designs, {
      get: () => Effect.succeed(undefined),
      put: () => Effect.void
    }),
    Layer.succeed(Compiler, {
      compile: () => Effect.succeed({ js: "", css: "", icons: {} })
    }),
    // One address answers, so a walk over every tool has a page to fetch.
    memoryWeb({ "https://example.com/data.json": '{"ok":true}' })
  )

export interface MemoryConnection {
  readonly incoming: Queue.Queue<SocketOutbound, RelayConnectionError>
  readonly sent: Array<SocketInbound>
}

/** A relay link the test reads and writes, one record per connection attempt. */
export const memoryLink = () => {
  const list: Array<MemoryConnection> = []
  const layer = Layer.succeed(RelayLink, {
    connect: () =>
      Effect.gen(function* () {
        const incoming = yield* Queue.make<SocketOutbound, RelayConnectionError>()
        const sent: Array<SocketInbound> = []
        list.push({ incoming, sent })
        return {
          receive: Queue.take(incoming),
          send: (message) => Effect.sync(() => sent.push(message))
        } satisfies RelayConnection
      })
  })
  return { list, layer }
}

/**
 * The call id `server.call` mints for an `ask_user`, the only thing a test needs to answer
 * it. Resolved from the start hook itself, so no timer guesses at when the call began.
 */
export const askUserCallId = () => {
  let resolve: (callId: string) => void = () => {}
  const callId = new Promise<string>((done) => {
    resolve = done
  })
  const onToolStart = (step: { readonly callId: string; readonly name: string }) =>
    Effect.sync(() => {
      if (step.name === "ask_user") resolve(step.callId)
    })
  return { callId, onToolStart }
}

export const waitUntil = async (
  ready: () => boolean | Promise<boolean>,
  what: string,
  ms = 2_000
): Promise<void> => {
  const start = Date.now()
  while (!(await ready())) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(1)
  }
}
