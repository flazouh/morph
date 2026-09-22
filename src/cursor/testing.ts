/**
 * The harness the Cursor tests share.
 *
 * A scripted Cloud Agents fetch plays Cursor, an in-memory relay link plays the bridge,
 * and fake world layers play the page. Nothing here is imported by shipped code: it exists
 * so the session tests and the background proxy tests drive the same seam the same way.
 */

import { Effect, Exit, Layer, Queue, Scope } from "effect"
import { Designs } from "../agent/designs"
import { Page } from "../agent/page"
import { Compiler } from "../skin/service"
import { memoryWeb } from "../agent/web"
import { DEFAULT_SETTINGS, type Session, type Settings, type Step } from "../session/contract"
import { RelayConnectionError, RelayLink, RelayThreadOwnership, type RelayConnection } from "../relay/extension"
import { BridgeId, ResumeSecret, type SocketInbound, type SocketOutbound } from "../relay/protocol"
import { CursorClient, type CursorFetch } from "./api"
import { forgetCursorThread, makeCursorSession, type CursorSessionOptions } from "./session"
import {
  CursorStorageError,
  cursorStoreLayer,
  memoryCursorStepStorage,
  memoryCursorStorage,
  type CursorStepStorage,
  type CursorStorage
} from "./state"

export const BRIDGE_ID = "11111111-1111-4111-8111-111111111111"
export const TOKEN = "22222222-2222-4222-8222-222222222222"
export const MCP_URL = `https://relay.test/mcp/${BRIDGE_ID}`
export const PAGE = "https://x.test/page"

const worldWith = () =>
  Layer.mergeAll(
  Layer.succeed(Page, {
    read: () =>
      Effect.succeed({
        url: PAGE,
        title: "x",
        viewport: { width: 1, height: 1 },
        stylesheets: [],
        outline: "body",
        nodes: 1,
        truncated: false
      }),
    styles: () => Effect.succeed([]),
    text: () => Effect.succeed([]),
    tokens: () => Effect.succeed({ theme: null, tokens: {} }),
    style: () => Effect.void,
    design: () => Effect.void,
    run: () => Effect.succeed(null),
    skin: () => Effect.void,
    kit: () => Effect.void,
    look: () => Effect.succeed("data:image/jpeg;base64,"),
    forget: () => Effect.void,
    forgetSite: () => Effect.void
  }),
  Layer.succeed(Designs, { get: () => Effect.succeed(undefined), put: () => Effect.void }),
  Layer.succeed(Compiler, { compile: () => Effect.succeed({ js: "", css: "", icons: {} }) }),
  memoryWeb()
)

export const world = worldWith()

/** Waits for a view the test expects, so no test sleeps for a fixed time. */
export const until = async (ready: () => boolean, what = "the session view", ms = 2_000): Promise<void> => {
  const start = Date.now()
  while (!ready()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(2)
  }
}

/** Fails loudly instead of hanging the suite when work never settles. */
export const within = async <A>(work: Promise<A>, what: string, ms = 2_000): Promise<A> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms)
  })
  try {
    return await Promise.race([work, guard])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export interface Call {
  readonly url: string
  readonly method: string
  readonly headers: Record<string, string>
  readonly body: unknown
}

export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })

export const sse = (text: string) =>
  new Response(text, { status: 200, headers: { "Content-Type": "text/event-stream" } })

/**
 * An SSE body the test writes into while the run is live.
 *
 * `respond` takes the request signal, the way a browser fetch does: an abort ends the
 * body with an error, so a pending read rejects instead of waiting forever.
 */
export const liveStream = () => {
  let push: (chunk: string) => void = () => {}
  let close: () => void = () => {}
  let fail: (error: Error) => void = () => {}
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder()
      const guard = (act: () => void) => {
        try {
          act()
        } catch {
          // The body already ended. A second ending is not news.
        }
      }
      push = (chunk) => guard(() => controller.enqueue(encoder.encode(chunk)))
      close = () => guard(() => controller.close())
      fail = (error) => guard(() => controller.error(error))
    }
  })
  return {
    respond: (signal?: AbortSignal): Response => {
      signal?.addEventListener("abort", () => fail(new Error("The user aborted a request.")), {
        once: true
      })
      return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } })
    },
    push: (chunk: string) => push(chunk),
    close: () => close(),
    /** Breaks the body mid-read, the way a dead connection does. */
    fail: (error: Error) => fail(error)
  }
}

/** One complete run: running, one assistant message, a result and the closing event. */
export const done = (status: string, text: string) =>
  sse(
    `event: status\ndata: {"runId":"run-1","status":"RUNNING"}\n\n` +
      `id: 1\nevent: assistant\ndata: ${JSON.stringify({ text })}\n\n` +
      `id: 2\nevent: result\ndata: ${JSON.stringify({ runId: "run-1", status, text })}\n\n` +
      `id: 3\nevent: done\ndata: {}\n\n`
  )

export interface Script {
  readonly createAgent?: (body: unknown, signal?: AbortSignal) => Response | Promise<Response>
  readonly createRun?: (body: unknown, signal?: AbortSignal) => Response | Promise<Response>
  readonly stream?: (signal?: AbortSignal) => Response
  readonly getRun?: (signal?: AbortSignal) => Response | Promise<Response>
  readonly getAgent?: (signal?: AbortSignal) => Response | Promise<Response>
  readonly usage?: (signal?: AbortSignal) => Response | Promise<Response>
  readonly cancel?: () => Response | Promise<Response>
  readonly archive?: () => Response
}

export const scripted = (script: Script, calls: Array<Call>): CursorFetch => {
  return (input, init) => {
    const url = String(input)
    const method = init?.method ?? "GET"
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
    const headers = Object.fromEntries(new Headers(init?.headers as HeadersInit | undefined).entries())
    calls.push({ url, method, headers, body })
    if (url.endsWith("/stream")) {
      const signal = init?.signal ?? undefined
      if (signal?.aborted === true) {
        return Promise.reject(new Error("The user aborted a request."))
      }
      return Promise.resolve((script.stream ?? (() => done("FINISHED", "Done.")))(signal))
    }
    if (url.endsWith("/usage")) {
      const signal = init?.signal ?? undefined
      return Promise.resolve(
        (script.usage ?? (() =>
          json(200, {
            totalUsage: {
              inputTokens: 0,
              outputTokens: 0,
              cacheWriteTokens: 0,
              cacheReadTokens: 0,
              totalTokens: 0
            },
            runs: []
          })))(signal)
      )
    }
    if (url.endsWith("/cancel")) return Promise.resolve((script.cancel ?? (() => json(200, { id: "run-1" })))())
    if (url.endsWith("/archive")) return Promise.resolve((script.archive ?? (() => json(200, { id: "bc-1" })))())
    if (url.endsWith("/runs")) {
      return Promise.resolve(
        (script.createRun ?? (() => json(200, { run: { id: "run-2", status: "CREATING" } })))(body, init?.signal ?? undefined)
      )
    }
    // Get A Run: GET /v1/agents/{id}/runs/{runId}. The default answers not-found, so a
    // broken stream without a scripted run record takes the gone path.
    if (method === "GET" && url.includes("/runs/")) {
      return Promise.resolve(
        (script.getRun ?? (() => json(404, { error: { code: "run_not_found", message: "Run not found." } })))(
          init?.signal ?? undefined
        )
      )
    }
    // Get An Agent: GET /v1/agents/{id}. The default is an idle agent holding no run, so
    // a busy refusal without a scripted agent falls back to the plain error step.
    if (method === "GET" && url.includes("/v1/agents/")) {
      return Promise.resolve(
        (script.getAgent ?? (() => json(200, { id: "bc-1", status: "IDLE" })))(init?.signal ?? undefined)
      )
    }
    return Promise.resolve(
      (script.createAgent ?? (() => json(200, { agent: { id: "bc-1" }, run: { id: "run-1", status: "CREATING" } })))(body, init?.signal ?? undefined)
    )
  }
}

export interface Bridge {
  readonly incoming: Queue.Queue<SocketOutbound, RelayConnectionError>
  readonly sent: Array<SocketInbound>
  /** Ends this connection the way a closed socket does. */
  readonly drop: () => void
  /** True once the connection's scope closed: the socket a real link would have released. */
  closed: boolean
}

export interface Identity {
  readonly bridgeId: string
  readonly token: string
  readonly mcpUrl: string
}

export const IDENTITY: Identity = { bridgeId: BRIDGE_ID, token: TOKEN, mcpUrl: MCP_URL }

const NEXT_BRIDGE_ID = "33333333-3333-4333-8333-333333333333"
const NEXT_TOKEN = "44444444-4444-4444-8444-444444444444"

/** The identity a restarted relay mints for the same thread. */
export const NEXT_IDENTITY: Identity = {
  bridgeId: NEXT_BRIDGE_ID,
  token: NEXT_TOKEN,
  mcpUrl: `https://relay.test/mcp/${NEXT_BRIDGE_ID}`
}

/** What the test does to the relay while the session runs. Read on every connect. */
export interface RelayControl {
  /** Connecting fails while this is true. */
  fails?: boolean
  /** A reconnect is refused, the way a restarted relay refuses an unknown bridge. */
  unknownBridge?: boolean
  /** Identities handed out in order. The last one repeats. */
  identities?: Array<Identity>
  /** Connect attempts, failed ones included. */
  attempts?: number
}

const mint = (control: RelayControl): Identity => {
  const queued = control.identities
  if (queued === undefined || queued.length === 0) return IDENTITY
  return queued.length === 1 ? queued[0]! : queued.shift()!
}

/** A relay link the test steers: it mints identities, refuses, drops, and forgets bridges. */
export const relayLink = (bridges: Array<Bridge>, control: RelayControl = {}) =>
  Layer.succeed(RelayLink, {
    connect: () =>
      Effect.gen(function* () {
        control.attempts = (control.attempts ?? 0) + 1
        if (control.fails === true) {
          return yield* new RelayConnectionError({ detail: "Could not connect to the relay" })
        }
        const incoming = yield* Queue.make<SocketOutbound, RelayConnectionError>()
        const sent: Array<SocketInbound> = []
        const bridge: Bridge = {
          incoming,
          sent,
          drop: () =>
            Effect.runFork(
              Queue.fail(incoming, new RelayConnectionError({ detail: "The relay WebSocket closed" }))
            ),
          closed: false
        }
        bridges.push(bridge)
        // A real link closes the socket when the connection's scope closes. Recording it
        // here is how a test can see that a released session let its socket go.
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            bridge.closed = true
          })
        )
        return {
          receive: Queue.take(incoming),
          send: (message: SocketInbound) =>
            Effect.gen(function* () {
              sent.push(message)
              if (message.type !== "register" && message.type !== "reconnect") return
              if (message.type === "reconnect" && control.unknownBridge === true) {
                return yield* Queue.offer(incoming, {
                  type: "error",
                  error: "Bridge does not exist"
                })
              }
              const identity = mint(control)
              yield* Queue.offer(incoming, {
                type: "registered",
                bridgeId: BridgeId.make(identity.bridgeId),
                token: ResumeSecret.make(identity.token),
                mcpUrl: identity.mcpUrl
              })
            })
        } satisfies RelayConnection
      })
  })

export interface Opened {
  readonly session: Session
  readonly calls: Array<Call>
  readonly bridges: Array<Bridge>
  readonly close: () => Promise<void>
}

export interface OpenOptions {
  readonly script?: Script
  readonly settings?: Partial<Settings>
  readonly storage?: CursorStorage
  readonly relayFails?: boolean
  readonly tabId?: number
  readonly threadId?: string
  readonly calls?: Array<Call>
  readonly bridges?: Array<Bridge>
  readonly relay?: RelayControl
  /** Where the step history goes. Defaults to memory. */
  readonly stepStorage?: CursorStepStorage
  /** Told about a persisted read or write that did not happen. */
  readonly onStorageFailure?: (failure: CursorStorageError) => Effect.Effect<void>
  /** How long a send waits for the first relay registration. */
  readonly relayReadyMs?: number
  /** How often an open run pings the relay to keep the service worker alive. */
  readonly heartbeatMs?: number
  /** How often a run whose stream broke is followed through its record. */
  readonly followEveryMs?: number
  readonly retryStreamAfterMs?: number
  readonly busyRetryMs?: number
  /** Where the page's own redesign publishes to. Absent, the thread gets no publish tools. */
  readonly publisher?: CursorSessionOptions["publisher"]
}

/**
 * The step store that belongs to one metadata store.
 *
 * A test that reopens a thread hands the same metadata storage to two sessions and
 * expects the second to read what the first wrote. The steps live in their own record
 * now, so they have to travel with it.
 */
const stepStores = new WeakMap<CursorStorage, CursorStepStorage>()

const stepsFor = (metadata: CursorStorage): CursorStepStorage => {
  const existing = stepStores.get(metadata)
  if (existing !== undefined) return existing
  const created = memoryCursorStepStorage()
  stepStores.set(metadata, created)
  return created
}

/** A step store that holds real records, and fails the next few calls on request. */
export interface FlakySteps extends CursorStepStorage {
  /** Fail this many of the next loads, then answer from the records again. */
  readonly failLoads: (count: number) => void
  /** Fail this many of the next saves, leaving the records as they were. */
  readonly failSaves: (count: number) => void
  /** What the store holds for a thread. The proof a refused write changed nothing. */
  readonly peek: (threadId: string) => ReadonlyArray<unknown> | undefined
}

/**
 * A step store with a transient failure in it.
 *
 * A store that always fails proves the diagnostic. It cannot prove the thing that costs a
 * reader their work: a store that fails once, is written to while it is unreadable, and
 * then works again. So this one holds real records, counts down the failures a test asks
 * for, and shows what survived.
 */
export const flakySteps = (
  initial: Record<string, ReadonlyArray<unknown>> = {}
): FlakySteps => {
  const records = new Map<string, ReadonlyArray<unknown>>(Object.entries(initial))
  const failing = { loads: 0, saves: 0 }
  return {
    load: (threadId) =>
      Effect.suspend(() => {
        if (failing.loads === 0) return Effect.sync(() => records.get(threadId))
        failing.loads -= 1
        return new CursorStorageError({ operation: "read", detail: "UnknownError" })
      }),
    save: (threadId, steps) =>
      Effect.suspend(() => {
        if (failing.saves === 0) {
          return Effect.sync(() => {
            records.set(threadId, steps)
          })
        }
        failing.saves -= 1
        return new CursorStorageError({ operation: "write", detail: "QuotaExceededError" })
      }),
    drop: (threadId) =>
      Effect.sync(() => {
        records.delete(threadId)
      }),
    failLoads: (count) => {
      failing.loads = count
    },
    failSaves: (count) => {
      failing.saves = count
    },
    peek: (threadId) => records.get(threadId)
  }
}

export const cursorSettings = (patch: Partial<Settings> = {}): Settings => ({
  ...DEFAULT_SETTINGS,
  provider: "cursor",
  cursorKey: "key-1",
  cursorModel: "composer-2",
  ...patch
})

/** Opens one live Cursor session on the scripted world, and hands back its own close. */
export const openCursorSession = async (options: OpenOptions = {}): Promise<Opened> => {
  const calls = options.calls ?? []
  const bridges = options.bridges ?? []
  const relay: RelayControl = options.relay ?? {}
  if (options.relayFails === true) relay.fails = true
  const metadata = options.storage ?? memoryCursorStorage()
  const scope = Effect.runSync(Scope.make())
  const session = await Effect.runPromise(
    Scope.provide(
      Effect.provide(
        makeCursorSession({
          url: PAGE,
          threadId: options.threadId ?? "thread-1",
          tabId: options.tabId ?? 1,
          relayUrl: "https://relay.test",
          settings: async () => cursorSettings(options.settings),
          world: worldWith(),
          forget: async () => {},
          forgetSite: async () => {},
          ...(options.publisher === undefined ? {} : { publisher: options.publisher }),
          relayReadyMs: options.relayReadyMs ?? 200,
          reconnectBaseDelayMs: 1,
          ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
          followEveryMs: options.followEveryMs ?? 20,
          retryStreamAfterMs: options.retryStreamAfterMs ?? 20,
          busyRetryMs: options.busyRetryMs ?? 5
        }),
        Layer.mergeAll(
          CursorClient.layerWith(scripted(options.script ?? {}, calls)),
          cursorStoreLayer(metadata, {
            steps: options.stepStorage ?? stepsFor(metadata),
            ...(options.onStorageFailure === undefined ? {} : { onFailure: options.onStorageFailure })
          }),
          relayLink(bridges, relay),
          RelayThreadOwnership.layer
        )
      ),
      scope
    )
  )
  return {
    session,
    calls,
    bridges,
    close: () => Effect.runPromise(Scope.close(scope, Exit.void))
  }
}

/** Archives and drops one thread's Cursor state on the scripted world, with no live session. */
export const forgetCursorThreadIn = (
  options: OpenOptions & { readonly threadId: string }
): Promise<void> =>
  Effect.runPromise(
    Effect.provide(
      forgetCursorThread(options.threadId, cursorSettings(options.settings).cursorKey),
      Layer.mergeAll(
        CursorClient.layerWith(scripted(options.script ?? {}, options.calls ?? [])),
        cursorStoreLayer(options.storage ?? memoryCursorStorage())
      )
    )
  )

export const kinds = (steps: ReadonlyArray<Step>): ReadonlyArray<string> => steps.map((step) => step.kind)

export const said = (steps: ReadonlyArray<Step>): ReadonlyArray<string> =>
  steps.map((step) => `${step.kind}:${"text" in step ? step.text : step.name}`)
