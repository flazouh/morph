/**
 * Typed views of the six editable CSS values. The controller keeps one plain-text field
 * per property as the source of truth; these helpers decide which richer control a value
 * can safely drive, and how a rich control writes back without changing the property's
 * unit or escaping the CSS-value safety rule.
 */

import type { StyleProperty } from "./model"

export interface NumericValue {
  readonly amount: number
  readonly unit: string
  /** The same length in CSS pixels, which is the slider's one unit across every property. */
  readonly px: number
}

export interface ColorTokenValue {
  readonly name: string
  readonly value: string
}

// A slider owns only absolute lengths. Relative units such as `%`, `vh`, and `vw` stay
// text-only because a fixed pixel range cannot represent them faithfully.
const LENGTH_PATTERN = /^(-?(?:\d+|\d*\.\d+))(px|rem|em)?$/

/** The fallback root-font basis for `rem` and `em` lengths when a page has no readable root size. */
const ROOT_FONT_PX = 16

const toPx = (amount: number, unit: string, rootFontPx: number): number =>
  unit === "rem" || unit === "em" ? amount * rootFontPx : amount

const fromPx = (px: number, unit: string, rootFontPx: number): number =>
  unit === "rem" || unit === "em" ? px / rootFontPx : px

/** A single length a slider can own. Multi-part values such as `8px 12px` stay text-only. */
export const parseLength = (value: string, rootFontPx = ROOT_FONT_PX): NumericValue | null => {
  const text = value.trim()
  if (text === "0") return { amount: 0, unit: "px", px: 0 }
  const match = text.match(LENGTH_PATTERN)
  if (match === null) return null
  const amount = Number(match[1])
  const unit = match[2] ?? "px"
  return { amount, unit, px: toPx(amount, unit, rootFontPx) }
}

/** The value a slider writes back: the same unit the field already had. */
export const formatLength = (px: number, unit: string, rootFontPx = ROOT_FONT_PX): string =>
  `${fromPx(px, unit, rootFontPx)}${unit}`

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))

const channelToHex = (value: number): string => clamp(Math.round(value), 0, 255).toString(16).padStart(2, "0")

/** The sRGB hex an `<input type="color">` accepts, or `null` for a color outside that model. */
export const colorToHex = (value: string): string | null => {
  const text = value.trim().toLowerCase()

  const short = text.match(/^#([0-9a-f]{3})$/)
  if (short !== null) {
    return `#${Array.from(short[1]!, (character) => `${character}${character}`).join("")}`
  }
  if (/^#[0-9a-f]{6}$/.test(text)) return text

  const rgb = text.match(/^rgba?\(([^)]+)\)$/)
  if (rgb === null) return null
  const parts = rgb[1]!.split(",").map((part) => part.trim())
  if (parts.length !== 3) return null
  const channels = parts.map((part) => Number(part))
  if (channels.some((channel) => !Number.isFinite(channel) || channel < 0 || channel > 255)) return null
  return `#${channels.map(channelToHex).join("")}`
}

const VAR_REFERENCE = /^var\(\s*(--[\w-]+)\s*(?:,[\s\S]*)?\)$/

/** A bare `var(--token)` color reference, or `null` for a direct or compound value. */
export const colorTokenReference = (value: string): string | null => {
  const name = value.trim().match(VAR_REFERENCE)?.[1]
  return name === undefined ? null : name
}

/** The resolved color behind a token reference, when the page's token list knows it. */
export const resolveColorToken = (
  name: string,
  tokens: ReadonlyArray<ColorTokenValue>
): string | null => tokens.find((token) => token.name === name)?.value ?? null

/** The hex a color picker should show for a field value, following one token reference. */
export const pickerHexFor = (
  value: string,
  tokens: ReadonlyArray<ColorTokenValue>
): string | null => {
  const direct = colorToHex(value)
  if (direct !== null) return direct
  const reference = colorTokenReference(value)
  if (reference === null) return null
  const resolved = resolveColorToken(reference, tokens)
  return resolved === null ? null : colorToHex(resolved)
}

/** Slider bounds for one property, wide enough for direct manipulation without inviting absurd values. */
export const sliderRangeFor = (property: StyleProperty): { readonly min: number; readonly max: number; readonly step: number } => {
  switch (property) {
    case "padding":
    case "margin":
      return { min: 0, max: 96, step: 1 }
    case "border-radius":
      return { min: 0, max: 48, step: 1 }
    case "font-size":
      return { min: 8, max: 48, step: 0.25 }
    default:
      return { min: 0, max: 100, step: 1 }
  }
}
