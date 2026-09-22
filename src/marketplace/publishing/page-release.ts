/**
 * A page redesign, made ready to publish: its source compiled the way the server will
 * compile it, its scope read from the tab it is on, and the two pictures a reader compares.
 *
 * The extension side of a root release. The service worker binds this to Chrome; tests bind
 * it to a fake tab and count what was shown and hidden.
 */
import { SHEETS } from "../../kit/tokens"
import type { CompiledPackage } from "../compiler/compile"
import { checkPageSource, PAGE_SCRIPT, PAGE_STYLE } from "../compiler/page"
import type { PackageSource } from "../compiler/source"
import type { PageRelease, PublishPreview } from "./client"

export interface PageTab {
  readonly url: string
  readonly active: boolean
  readonly windowId: number
}

export interface PageReleasePorts {
  readonly tab: (tabId: number) => Promise<PageTab>
  /** Whether the page at this URL still wears a redesign of its own. */
  readonly wears: (url: string) => Promise<boolean>
  readonly compile: (source: PackageSource) => Promise<CompiledPackage>
  /** Run `code` in the page's own world, now. */
  readonly execute: (tabId: number, code: string) => Promise<void>
  /** A picture of the visible tab of `windowId`, as a PNG data URL. */
  readonly capture: (windowId: number) => Promise<string>
  /** The PNG as the release carries it: WebP bytes and their digest. */
  readonly preview: (png: string) => Promise<PublishPreview>
  /** Run `action` with the in-page chat out of the picture. */
  readonly withChatHidden: <A>(tabId: number, action: () => Promise<A>) => Promise<A>
}

export interface PagePreviews {
  readonly before: PublishPreview
  readonly after: PublishPreview
}

const SHEET_IDS = [SHEETS.design, SHEETS.styles]

/**
 * The page as it was before the redesign, as far as the page can show it without a reload:
 * the redesign's stylesheets off and the skin unmounted. A persisted `page.js` has already
 * changed the DOM and stays; its before picture is the page without the styles and the skin.
 */
export const HIDE_REDESIGN = `for (const id of ${JSON.stringify(SHEET_IDS)}) { const sheet = document.getElementById(id); if (sheet) sheet.disabled = true }
window.__beui?.unskin?.()`

/** The redesign back on: the sheets on again, and the skin script run again where there is one. */
export const showRedesign = (source: PackageSource, compiled: CompiledPackage): string =>
  `for (const id of ${JSON.stringify(SHEET_IDS)}) { const sheet = document.getElementById(id); if (sheet) sheet.disabled = false }` +
  (source.entry === PAGE_SCRIPT || source.entry === PAGE_STYLE ? "" : `\n${compiled.script}`)

/**
 * The page scope a release names: this origin and the paths the package covers, in order,
 * and nothing about the query. The paths come from the redesign itself, since a thread may
 * have skinned several pages of the site; the tab only says which origin they are on, and
 * which path to name when the caller gives none.
 */
export const pageScopeOf = (url: string, paths?: ReadonlyArray<string>): PageRelease["scope"] => {
  const location = new URL(url)
  const named = paths === undefined || paths.length === 0 ? [location.pathname] : [...paths]
  return { kind: "page", origin: location.origin, paths: [...new Set(named)].sort() }
}

/**
 * After, then before, then the redesign back, with the chat hidden throughout. The after
 * picture comes first because it is the page as it is; the before picture costs a change
 * to the page, which is undone before anything else happens, whether or not it worked.
 */
const capturePreviews = async (ports: PageReleasePorts, tabId: number, tab: PageTab, source: PackageSource, compiled: CompiledPackage): Promise<PagePreviews> =>
  ports.withChatHidden(tabId, async () => {
    const afterPng = await ports.capture(tab.windowId)
    let beforePng: string
    try {
      await ports.execute(tabId, HIDE_REDESIGN)
      beforePng = await ports.capture(tab.windowId)
    } finally {
      await ports.execute(tabId, showRedesign(source, compiled))
    }
    const [before, after] = await Promise.all([ports.preview(beforePng), ports.preview(afterPng)])
    return { before, after }
  })

/**
 * The release for the page in `tabId`, or an error that says what stopped it. The tab has
 * to be in front, since the pictures are of the visible tab; the source has to pass the
 * page contract, since the server will refuse one that does not.
 */
export const preparePageRelease = async (
  ports: PageReleasePorts,
  tabId: number,
  input: PackageSource,
  /** The paths the package covers. Omitted, the release covers the tab's own path. */
  paths?: ReadonlyArray<string>
): Promise<{ readonly release: PageRelease; readonly previews: PagePreviews }> => {
  const source = checkPageSource(input)
  const tab = await ports.tab(tabId)
  if (!tab.active) throw new Error("keep the Morph page active while its release previews are captured")
  // The pictures are of the page as it is now, so a page the reader has since undressed
  // would ship an after picture of a bare page beside code that redesigns it.
  if (!(await ports.wears(tab.url))) {
    throw new Error("this page no longer wears the redesign; apply it again before publishing")
  }
  const compiled = await ports.compile(source)
  const previews = await capturePreviews(ports, tabId, tab, source, compiled)
  return {
    release: { scope: pageScopeOf(tab.url, paths), source, compiled: { sources: compiled.sources, artifacts: compiled.artifacts } },
    previews
  }
}
