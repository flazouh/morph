/**
 * The world a run acts on inside the extension: the tab's page, the site's design, the
 * skin compiler and the web, read by the worker.
 *
 * The panel builds it for an OpenRouter run; the service worker builds the same one for a
 * Cursor run, so both providers give the tools the same page.
 */

import { Effect, Layer } from "effect"
import { chromeDesigns, Designs } from "../agent/designs"
import { chromePage, Page, siteKey } from "../agent/page"
import { chromeWeb, type Web } from "../agent/web"
import type { World } from "../agent/world"
import { icons } from "../skin/icons"
import { sheets } from "../skin/sheets"
import { skinCompiler } from "../skin/service"

export interface PageTab {
  readonly id: number
  readonly url: string
}

/** `web` is how this context reaches the network: the card asks the worker, the worker reads itself. */
export const worldFor = (tab: PageTab, web: Layer.Layer<Web> = chromeWeb): Layer.Layer<World> =>
  Layer.mergeAll(chromePage(tab), chromeDesigns, skinCompiler(sheets, icons), web)

/** Takes this page's restyle off. */
export const forgetPageOf = (tab: PageTab): Promise<void> =>
  Effect.runPromise(Effect.flatMap(Page, (page) => page.forget()).pipe(Effect.provide(chromePage(tab))))

/** Takes the site's restyle off every page of the host, and forgets the site's design. */
export const forgetSiteOf = (tab: PageTab): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.flatMap(Page, (page) => page.forgetSite()).pipe(Effect.provide(chromePage(tab)))
      yield* Effect.flatMap(Designs, (designs) => designs.put(siteKey(tab.url), undefined)).pipe(
        Effect.provide(chromeDesigns)
      )
    })
  )
