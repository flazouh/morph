import css from "./kit.css?inline"
import palette from "../styles/palette.css?inline"
import { loadFonts } from "./fonts"
import { createKit } from "./mount"
import { SHEETS } from "./tokens"

/**
 * The kit as a page script: one stylesheet for the shadow roots, the palette on the
 * page's :root, and the mount API on `window.__beui`. Loading it twice is harmless.
 */
declare global {
  interface Window {
    __beui?: ReturnType<typeof createKit> & { readonly version: string }
    /** The extension's `fonts/` URL, set by the script that runs before the kit (see ASSETS in persisted.ts). */
    __beuiAssets?: string
  }
}

export const startKit = (): void => {
if (window.__beui === undefined) {
  const sheet = new CSSStyleSheet()
  sheet.replaceSync(css)
  // The palette goes on the page too, so the page's own rules and the components share
  // one set of tokens. It is the first of three sheets (see SHEETS): the site's design
  // overrides it, and the redesign stylesheet comes last.
  if (document.getElementById(SHEETS.palette) === null) {
    const style = document.createElement("style")
    style.id = SHEETS.palette
    style.textContent = palette
    document.documentElement.prepend(style)
  }
  if (typeof window.__beuiAssets === "string") loadFonts(document, window.__beuiAssets)
  window.__beui = { ...createKit(sheet), version: __KIT_VERSION__ }
}
}
