import { describe, expect, test } from "bun:test"
import { inspectorCss } from "./panel-style"

const PANEL_SIZE = { width: 280, height: 360 }
/** The panel's own background; both checked colors sit directly on it. */
const PANEL_BACKGROUND = "#1c1c1c"

/** WCAG 2.x relative luminance and contrast ratio, computed from plain hex colors. */
const srgbToLinear = (channel: number): number => {
  const normalized = channel / 255
  return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
}

const relativeLuminance = (hex: string): number => {
  const value = hex.replace("#", "")
  const r = Number.parseInt(value.slice(0, 2), 16)
  const g = Number.parseInt(value.slice(2, 4), 16)
  const b = Number.parseInt(value.slice(4, 6), 16)
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b)
}

const contrastRatio = (a: string, b: string): number => {
  const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x)
  return (lighter! + 0.05) / (darker! + 0.05)
}

const colorOf = (css: string, selector: string): string => {
  const escaped = selector.replace(/[.[\]]/g, "\\$&")
  const match = css.match(new RegExp(`${escaped}\\s*\\{[^}]*?[^-]color:\\s*(#[0-9a-fA-F]{3,8})`))
  if (match === null) throw new Error(`no color declaration found for ${selector}`)
  return match[1]!
}

describe("inspectorCss contrast", () => {
  const css = inspectorCss(PANEL_SIZE)

  test("the warning text meets WCAG AA contrast (4.5:1) against the panel background", () => {
    const ratio = contrastRatio(colorOf(css, ".mi-warning"), PANEL_BACKGROUND)
    expect(ratio).toBeGreaterThanOrEqual(4.5)
  })

  test("the discard action's text meets WCAG AA contrast (4.5:1) against the panel background", () => {
    const ratio = contrastRatio(colorOf(css, ".mi-action[data-mi-discard]"), PANEL_BACKGROUND)
    expect(ratio).toBeGreaterThanOrEqual(4.5)
  })

  test("the remove control's hovered (destructive) color meets WCAG AA contrast (4.5:1)", () => {
    const ratio = contrastRatio(colorOf(css, ".mi-remove:hover"), PANEL_BACKGROUND)
    expect(ratio).toBeGreaterThanOrEqual(4.5)
  })

  test("Morph red is still present as a non-text cue on the discard action", () => {
    expect(css).toContain("rgba(238, 52, 59, 0.4)")
  })

  test("empty status chrome is removed while the live region stays mounted", () => {
    expect(css).toContain(".mi-status:empty")
    expect(css).toMatch(/\.mi-status:empty[\s\S]*?padding:\s*0/)
    expect(css).toMatch(/\.mi-status:empty[\s\S]*?border:\s*0/)
    expect(css).toMatch(/\.mi-status:empty[\s\S]*?background:\s*transparent/)
  })
})
