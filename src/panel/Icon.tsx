import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react"

export interface IconProps {
  icon: IconSvgElement
  /** Pixels. The panel's icons are 14 to 16; the brand mark is larger. */
  size?: number
  className?: string
}

/** One icon set for the whole panel: Hugeicons, stroke 1.5, the line weight the type sits well with. */
export function Icon({ icon, size = 15, className }: IconProps) {
  return <HugeiconsIcon icon={icon} size={size} strokeWidth={1.5} className={className} aria-hidden="true" />
}
