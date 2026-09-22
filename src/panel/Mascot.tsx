import { MORPH_LOGO, MORPH_LOGO_VIEWBOX } from "@/brand/morph"
import { MASCOT_SHAPES, type MascotShapeName } from "@/brand/mascot-shapes"

const NAMES = Object.keys(MASCOT_SHAPES) as ReadonlyArray<MascotShapeName>
const COLORS = ["#E02988", "#FF9800", "#009957", "#804EE0"] as const

export interface ThreadMascotIdentity {
  readonly seed: string
  readonly variant?: number
}

type MascotShapeProps = {
  readonly name: MascotShapeName
  readonly color: string
  readonly x: number
  readonly y: number
  readonly size: number
}

function MascotShape({ name, color, x, y, size }: MascotShapeProps) {
  const shape = MASCOT_SHAPES[name]
  const [body, ...eyes] = shape.d.split(" M")
  return (
    <svg x={x} y={y} width={size} height={size} viewBox="-15 -15 259 259" overflow="visible">
      <g transform={shape.transform}>
        <path data-shape={name} d={body} fill={color} />
        <g data-stripe-eyes fill="#111111">
          {eyes.map((eye) => (
            <path key={eye} d={`M${eye}`} />
          ))}
        </g>
      </g>
    </svg>
  )
}

const numberOf = (seed: string): number => {
  let value = 0
  for (const character of seed) value = (value * 31 + character.charCodeAt(0)) >>> 0
  return value
}

/** One stable mascot identity for a crew bot, wherever that bot appears. */
export const botMascot = (seed: string): ThreadMascotIdentity => ({ seed, variant: numberOf(seed) })

export function ThreadMascot({
  seed,
  variant,
  size = 18,
  label
}: ThreadMascotIdentity & { readonly size?: number; readonly label?: string }) {
  const number = variant ?? numberOf(seed)
  return (
    <svg
      role={label === undefined ? undefined : "img"}
      aria-label={label}
      aria-hidden={label === undefined}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className="shrink-0"
    >
      <MascotShape
        name={NAMES[number % NAMES.length] ?? "blob"}
        color={COLORS[(number * 3 + 1) % COLORS.length] ?? COLORS[0]}
        x={0}
        y={0}
        size={size}
      />
    </svg>
  )
}

export function MorphMascots({ height = 24, label }: { readonly height?: number; readonly label?: string }) {
  return (
    <svg
      viewBox={MORPH_LOGO_VIEWBOX}
      width={height * 1.32}
      height={height}
      role={label === undefined ? undefined : "img"}
      aria-label={label}
      aria-hidden={label === undefined}
    >
      {MORPH_LOGO.map((mascot) => (
        <MascotShape key={mascot.name} {...mascot} />
      ))}
    </svg>
  )
}
