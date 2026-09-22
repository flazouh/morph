import { Context, Effect, Layer } from "effect"
import type { Design } from "./design"

/**
 * Where a site's design is kept between visits: one design per host, outliving any page's
 * log and any reset. The agent reads it when a session opens, so a returning visit starts
 * from the site's tokens.
 */
export class Designs extends Context.Service<
  Designs,
  {
    readonly get: (host: string) => Effect.Effect<Design | undefined, DesignsFailure>
    /** `undefined` forgets the site's design. */
    readonly put: (host: string, design: Design | undefined) => Effect.Effect<void, DesignsFailure>
  }
>()("redesign/Designs") {}

export class DesignsFailure extends Error {
  readonly _tag = "DesignsFailure"
  constructor(message: string) {
    super(message)
  }
}

const fail = (e: unknown): DesignsFailure => new DesignsFailure(e instanceof Error ? e.message : String(e))

const KEY = "designs"

/** The binding for the extension: `chrome.storage.local`, keyed by host. */
export const chromeDesigns: Layer.Layer<Designs> = Layer.succeed(Designs, {
  get: (host) =>
    Effect.tryPromise({
      try: async () => {
        const all = ((await chrome.storage.local.get(KEY))[KEY] as Record<string, Design> | undefined) ?? {}
        return all[host]
      },
      catch: fail
    }),
  put: (host, design) =>
    Effect.tryPromise({
      try: async () => {
        const all = ((await chrome.storage.local.get(KEY))[KEY] as Record<string, Design> | undefined) ?? {}
        if (design === undefined) delete all[host]
        else all[host] = design
        await chrome.storage.local.set({ [KEY]: all })
      },
      catch: fail
    })
})

/** For tests: the given record is the store, so a test reads what the agent wrote. */
export const memoryDesigns = (all: Record<string, Design> = {}): Layer.Layer<Designs> =>
  Layer.succeed(Designs, {
    get: (host) => Effect.sync(() => all[host]),
    put: (host, design) =>
      Effect.sync(() => {
        if (design === undefined) delete all[host]
        else all[host] = design
      })
  })
