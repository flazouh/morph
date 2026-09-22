/**
 * Which palette a page gets. The panel follows the OS, but a page has its own colours:
 * a light site under a dark OS must not get near-white text. So the kit reads the
 * page's background and writes the answer to `<html data-beui-theme="light|dark">`,
 * which palette.css keys on. A script may set the attribute itself; the kit then
 * leaves it alone.
 */

export type Theme = "light" | "dark"

export const THEME_ATTR = "data-beui-theme"

const isTheme = (v: string | null): v is Theme => v === "light" || v === "dark"

/**
 * Relative luminance of any CSS colour, or undefined when it is transparent or unknown.
 * The browser parses the colour: a 1x1 canvas turns `oklch(...)`, `lab(...)`, `rgb(...)`
 * and names alike into one sRGB pixel.
 */
export const luminanceOf = (color: string, canvas: HTMLCanvasElement = document.createElement("canvas")): number | undefined => {
  canvas.width = 1
  canvas.height = 1
  const ctx = canvas.getContext("2d")
  if (ctx === null) return undefined
  ctx.clearRect(0, 0, 1, 1)
  ctx.fillStyle = color
  ctx.fillRect(0, 0, 1, 1)
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data
  if (a === undefined || a === 0) return undefined
  const lin = (c: number | undefined) => {
    const v = (c ?? 0) / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/** The theme a page wants, from the first painted background behind its content. */
export const themeOf = (doc: Document, luminance: (color: string) => number | undefined = luminanceOf): Theme => {
  for (const el of [doc.body, doc.documentElement]) {
    if (el === null) continue
    const l = luminance(getComputedStyle(el).backgroundColor)
    if (l !== undefined) return l < 0.18 ? "dark" : "light"
  }
  return "light"
}

/**
 * Keeps `<html data-beui-theme>` in step with the page. `refresh()` recomputes from the
 * page unless a script set the attribute to something the kit did not write, so a
 * redesign that darkens the page after load is picked up at the next mount.
 */
export type ThemeKeeper = ReturnType<typeof themeKeeper>

export const themeKeeper = (doc: Document) => {
  let written: Theme | undefined
  const refresh = (): Theme => {
    const current = doc.documentElement.getAttribute(THEME_ATTR)
    if (isTheme(current) && current !== written) return current
    if (doc.body === null) return isTheme(current) ? current : "light"
    written = themeOf(doc)
    doc.documentElement.setAttribute(THEME_ATTR, written)
    return written
  }
  if (doc.body === null) doc.addEventListener("DOMContentLoaded", () => refresh(), { once: true })
  else refresh()
  return { refresh }
}
