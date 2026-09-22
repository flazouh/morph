export type ResizeCorner = "north-west" | "north-east" | "south-west" | "south-east"

export interface ChatRect {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

export interface ResizeBounds {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
  readonly minWidth: number
  readonly minHeight: number
}

export interface ResizeDelta {
  readonly x: number
  readonly y: number
}

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value))

/**
 * Return the rect to display when the settings panel is open in wide mode.
 * The stored placement is widened to at least settingsWidth and anchored to
 * the same right edge, clamped so the left edge stays inside the inset.
 * Returns the original placement object when no change is needed.
 */
export const resolveDisplayRect = (placement: ChatRect, settingsWidth: number, inset: number): ChatRect => {
  const width = Math.max(placement.width, settingsWidth)
  if (width === placement.width) return placement
  const right = placement.left + placement.width
  return {
    left: Math.max(inset, right - width),
    top: placement.top,
    width,
    height: placement.height
  }
}

export const applyRect = (element: HTMLElement, rect: ChatRect): void => {
  element.style.left = `${rect.left}px`
  element.style.top = `${rect.top}px`
  element.style.right = "auto"
  element.style.bottom = "auto"
  element.style.width = `${rect.width}px`
  element.style.height = `${rect.height}px`
  element.style.transform = "none"
}

export const moveRect = (start: ChatRect, delta: ResizeDelta, bounds: ResizeBounds): ChatRect => ({
  left: Math.round(clamp(start.left + delta.x, bounds.left, Math.max(bounds.left, bounds.right - start.width))),
  top: Math.round(clamp(start.top + delta.y, bounds.top, Math.max(bounds.top, bounds.bottom - start.height))),
  width: start.width,
  height: start.height
})

export const resizeRect = (
  start: ChatRect,
  delta: ResizeDelta,
  corner: ResizeCorner,
  bounds: ResizeBounds
): ChatRect => {
  let left = start.left
  let top = start.top
  let right = start.left + start.width
  let bottom = start.top + start.height
  const minWidth = Math.min(bounds.minWidth, bounds.right - bounds.left)
  const minHeight = Math.min(bounds.minHeight, bounds.bottom - bounds.top)

  if (corner.endsWith("west")) {
    left = clamp(start.left + delta.x, bounds.left, right - minWidth)
  } else {
    right = clamp(right + delta.x, left + minWidth, bounds.right)
  }

  if (corner.startsWith("north")) {
    top = clamp(start.top + delta.y, bounds.top, bottom - minHeight)
  } else {
    bottom = clamp(bottom + delta.y, top + minHeight, bounds.bottom)
  }

  return {
    left: Math.round(left),
    top: Math.round(top),
    width: Math.round(right - left),
    height: Math.round(bottom - top)
  }
}
