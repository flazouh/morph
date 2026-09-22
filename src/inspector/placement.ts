/**
 * Where the inspector panel sits in the viewport: whichever fixed corner keeps
 * the panel off the selected element. A pure function of two rects, so the
 * choice is testable without a real layout.
 */

export interface Size {
  readonly width: number
  readonly height: number
}

export interface Rect {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

export type PanelCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right"

/** Bottom-right first: it matches the chat card's own default corner. */
const CORNER_PRIORITY: ReadonlyArray<PanelCorner> = ["bottom-right", "bottom-left", "top-right", "top-left"]

const rectForCorner = (corner: PanelCorner, viewport: Size, panel: Size, inset: number): Rect => ({
  left: corner.endsWith("left") ? inset : viewport.width - inset - panel.width,
  top: corner.startsWith("top") ? inset : viewport.height - inset - panel.height,
  width: panel.width,
  height: panel.height
})

const overlaps = (a: Rect, b: Rect): boolean =>
  a.left < b.left + b.width &&
  a.left + a.width > b.left &&
  a.top < b.top + b.height &&
  a.top + a.height > b.top

/** The first corner, in priority order, whose panel rect does not cover the target. */
export const pickCorner = (target: Rect, viewport: Size, panel: Size, inset: number): PanelCorner => {
  for (const corner of CORNER_PRIORITY) {
    if (!overlaps(rectForCorner(corner, viewport, panel, inset), target)) return corner
  }
  return CORNER_PRIORITY[0] ?? "bottom-right"
}

/** Fixed-position offsets for a corner: the two facing edges get a value, the other two stay "auto". */
export const cornerStyle = (corner: PanelCorner, inset: number): Record<"top" | "right" | "bottom" | "left", string> => ({
  top: corner.startsWith("top") ? `${inset}px` : "auto",
  right: corner.endsWith("right") ? `${inset}px` : "auto",
  bottom: corner.startsWith("top") ? "auto" : `${inset}px`,
  left: corner.endsWith("left") ? `${inset}px` : "auto"
})
