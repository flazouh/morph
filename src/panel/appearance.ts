/**
 * The panel appearance: the palette and the text scale, driven by the stored settings.
 *
 * The palette is keyed by `data-beui-theme` on the document root (see palette.css). The
 * text scale is keyed by `data-font-size`, which a CSS `zoom` rule turns into a whole
 * panel scale (see globals.css). Both attributes sit on the same root so one controller
 * owns the panel look.
 */

import { useEffect } from "react"
import type { FontSize, Settings, ThemeChoice } from "@/session"

/** The palette to show: the explicit choice, or the OS palette while `system` is set. */
export const resolvedTheme = (theme: ThemeChoice, prefersDark: boolean): "light" | "dark" =>
  theme === "system" ? (prefersDark ? "dark" : "light") : theme

/** Write the palette and the text scale onto the document root. */
export const applyAppearance = (
  root: HTMLElement,
  theme: ThemeChoice,
  size: FontSize,
  prefersDark: boolean
): void => {
  root.setAttribute("data-beui-theme", resolvedTheme(theme, prefersDark))
  root.setAttribute("data-font-size", size)
}

const DARK_QUERY = "(prefers-color-scheme: dark)"

/**
 * Keep the document root in step with the stored appearance. While `system` is set, the
 * hook also follows OS palette changes; on any other choice it stops listening. It does
 * nothing until the store answers, so the initial paint from main.tsx stands.
 */
export const useAppearance = (settings: Settings | null): void => {
  const theme = settings?.theme
  const size = settings?.fontSize
  useEffect(() => {
    if (theme === undefined || size === undefined) return
    const root = document.documentElement
    const media = window.matchMedia(DARK_QUERY)
    const apply = () => applyAppearance(root, theme, size, media.matches)
    apply()
    if (theme !== "system") return
    media.addEventListener("change", apply)
    return () => media.removeEventListener("change", apply)
  }, [theme, size])
}
