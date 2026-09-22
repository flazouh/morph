import { Option, Schema } from "effect"
import { ICONS_ASSET } from "../kit/module-ids"
import type { IconSet, Icons } from "./compile"
import { PackedIconSet, unpackIconSet } from "./icon-codec"

const decodeIconSet = Schema.decodeUnknownOption(PackedIconSet)

/**
 * The Hugeicons free set, 14,000 named exports, as a packed JSON asset the build writes
 * next to the manifest (see wxt.config.ts and icon-codec.ts). A fetch, not an `import()`:
 * the compile runs in the service worker for a Cursor run, and Chrome refuses dynamic
 * import there. Seen live on 2026-09-12 as `window is not defined`, Vite's preload helper
 * masking that refusal.
 *
 * The set loads on the first skin that imports from it and stays in memory for the life
 * of the context. A load that fails is not kept, so the next skin tries again.
 */
/** What the loader needs of fetch. */
export type Load = (url: string) => Promise<Response>

export const iconsFrom = (url: () => string, load: Load = (at) => fetch(at)): Icons => {
  let loaded: Promise<IconSet> | undefined
  const read = async (): Promise<IconSet> => {
    const at = url()
    const response = await load(at)
    if (!response.ok) throw new Error(`the icon set at ${at} did not load: HTTP ${response.status}`)
    const decoded = decodeIconSet(await response.json())
    if (Option.isNone(decoded)) throw new Error(`the icon set at ${at} is not a packed icon set`)
    return unpackIconSet(decoded.value)
  }
  return () => {
    if (loaded === undefined) {
      const attempt = read()
      loaded = attempt
      attempt.catch(() => {
        if (loaded === attempt) loaded = undefined
      })
    }
    return loaded
  }
}

/** The extension's binding, panel and service worker alike, for skins and marketplace packages. */
export const icons: Icons = iconsFrom(() => chrome.runtime.getURL(ICONS_ASSET))
