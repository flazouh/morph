import { useState, type ReactNode } from "react"
import { AnimatedBadge, type AnimatedBadgeProps } from "@/components/motion/animated-badge"
import { BouncyAccordion, type BouncyAccordionItem } from "@/components/motion/bouncy-accordion"
import { Button, ButtonLink, type ButtonLinkProps, type ButtonProps } from "@/components/motion/button/base"
import { Checkbox, type CheckboxProps } from "@/components/motion/checkbox"
import { Input, type InputProps } from "@/components/motion/input"
import { Loader, type LoaderProps } from "@/components/motion/loader"
import { NumberTicker, type NumberTickerProps } from "@/components/motion/number-ticker"
import { RadioGroup, RadioGroupItem } from "@/components/motion/radio"
import { SelectContent, SelectItem, Select as SelectRoot, SelectTrigger, SelectValue } from "@/components/motion/select"
import { Switch, type SwitchProps } from "@/components/motion/switch"
import { TabsContent, TabsList, Tabs as TabsRoot, TabsTrigger } from "@/components/motion/tabs"
import { TextReveal, type TextRevealProps } from "@/components/motion/text-reveal"
import { TiltCard } from "@/components/motion/tilt-card"
import { Tooltip, type TooltipProps } from "@/components/motion/tooltip"
import { cn } from "@/lib/utils"
import { COMPONENTS, type ComponentName } from "./docs"

/**
 * The components the agent can mount on a page, each behind a flat props object that a
 * script can build. Stateful pieces (Switch, Tabs, Select...) keep their own state and
 * report changes through a callback, so the page script never holds React state.
 */

export type Props = Record<string, unknown>

export interface Entry {
  /** The host element the component is rendered into. */
  readonly box: { readonly tag: "span" | "div"; readonly display: "inline-block" | "block" }
  /** How the host meets the target when the script names no mode. Default "replace". */
  readonly mode?: "wrap"
  readonly render: (props: Props, children: ReactNode) => ReactNode
}

const INLINE = { tag: "span", display: "inline-block" } as const
const BLOCK = { tag: "div", display: "block" } as const

/**
 * The props the docs list for `name`, and nothing else, with no undefined values, so
 * a rest spread passes them on as they are. The values are the model's, so they are
 * trusted only as far as the doc line describes them; the cast is that trust.
 */
const forwarded = <P,>(name: ComponentName, props: Props): Partial<P> => {
  const out: Props = {}
  for (const key of COMPONENTS[name].props) if (props[key] !== undefined) out[key] = props[key]
  return out as Partial<P>
}

/** `value` when it is one of `choices`, else the first choice. */
const oneOf = <const T extends string>(value: unknown, choices: ReadonlyArray<T>): T =>
  (choices as ReadonlyArray<unknown>).includes(value) ? (value as T) : (choices[0] as T)

/** The records of `raw` that carry every one of `keys` as a string. Anything else is dropped. */
const listOf = <K extends string>(raw: unknown, keys: ReadonlyArray<K>): ReadonlyArray<Record<K, string> & Record<string, unknown>> =>
  Array.isArray(raw)
    ? raw.filter(
        (item): item is Record<K, string> & Record<string, unknown> =>
          typeof item === "object" && item !== null && keys.every((k) => typeof (item as Record<string, unknown>)[k] === "string")
      )
    : []

type Change<T> = ((value: T) => void) | undefined

const StatefulSwitch = (props: Props) => {
  const { checked: initial, onChange, ...rest } = forwarded<SwitchProps & { onChange?: Change<boolean> }>("Switch", props)
  const [checked, setChecked] = useState(initial === true)
  return (
    <Switch
      {...rest}
      checked={checked}
      onCheckedChange={(next) => {
        setChecked(next)
        onChange?.(next)
      }}
    />
  )
}

const StatefulCheckbox = (props: Props) => {
  const { checked: initial, onChange, ...rest } = forwarded<CheckboxProps & { onChange?: Change<boolean> }>("Checkbox", props)
  const [checked, setChecked] = useState(initial === true)
  return (
    <Checkbox
      {...rest}
      checked={checked}
      onCheckedChange={(next) => {
        setChecked(next)
        onChange?.(next)
      }}
    />
  )
}

const OPTION = ["value", "label"] as const

const Radio = (props: Props) => {
  const { options: raw, initial, orientation, onChange, ...rest } = forwarded<{ options: unknown; initial: string; orientation: string; onChange: Change<string>; className: string }>("Radio", props)
  const options = listOf(raw, OPTION)
  return (
    <RadioGroup
      {...rest}
      defaultValue={initial ?? options[0]?.value ?? ""}
      orientation={oneOf(orientation, ["vertical", "horizontal"])}
      onValueChange={(v) => onChange?.(v)}
    >
      {options.map((o) => (
        <RadioGroupItem key={o.value} value={o.value} label={o.label} />
      ))}
    </RadioGroup>
  )
}

const Select = (props: Props) => {
  const { options: raw, initial, placeholder, onChange, ...rest } = forwarded<{ options: unknown; initial: string; placeholder: string; onChange: Change<string>; className: string }>("Select", props)
  const options = listOf(raw, OPTION)
  return (
    <SelectRoot {...rest} {...(initial === undefined ? {} : { defaultValue: initial })} onValueChange={(v) => onChange?.(v)}>
      <SelectTrigger>
        <SelectValue placeholder={placeholder ?? "Choose"} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </SelectRoot>
  )
}

const Tabs = (props: Props) => {
  const { tabs: raw, initial, variant, onChange } = forwarded<{ tabs: unknown; initial: string; variant: string; onChange: Change<string> }>("Tabs", props)
  const tabs = listOf(raw, OPTION)
  return (
    <TabsRoot defaultValue={initial ?? tabs[0]?.value ?? ""} variant={oneOf(variant, ["pill", "underline"])} onValueChange={(v) => onChange?.(v)}>
      <TabsList>
        {tabs.map((t) => (
          <TabsTrigger key={t.value} value={t.value}>
            {t.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {tabs.map((t) =>
        typeof t.content === "string" ? (
          <TabsContent key={t.value} value={t.value}>
            {t.content}
          </TabsContent>
        ) : null
      )}
    </TabsRoot>
  )
}

const Accordion = (props: Props) => {
  const { items: raw, initial, onChange, ...rest } = forwarded<{ items: unknown; initial: string; onChange: Change<string | null>; className: string }>("Accordion", props)
  const items: BouncyAccordionItem[] = listOf(raw, ["id", "title"]).map((i) => ({
    id: i.id,
    title: i.title,
    ...(typeof i.description === "string" ? { description: i.description } : {})
  }))
  return <BouncyAccordion {...rest} items={items} defaultValue={initial ?? null} onValueChange={(v) => onChange?.(v)} />
}

const PADDING = { none: "p-0", sm: "p-3", md: "p-4", lg: "p-6" } as const

/** The wrapped element shows through the slot, with the card surface around it. */
const Card = (props: Props, children: ReactNode) => {
  const { tilt, glare, padding, className } = forwarded<{ tilt: boolean; glare: boolean; padding: string; className: string }>("Card", props)
  const surface = cn("rounded-[var(--radius)] border border-border bg-card text-card-foreground shadow-sm", PADDING[oneOf(padding, ["md", "none", "sm", "lg"])], className)
  return tilt === false ? (
    <div className={surface}>{children}</div>
  ) : (
    <TiltCard glare={glare !== false} className={surface}>
      {children}
    </TiltCard>
  )
}

const TEXT_TAGS = ["span", "h1", "h2", "h3", "p"] as const

const Text = (props: Props, children: ReactNode) => {
  const { text, split, as, className, ...rest } = forwarded<TextRevealProps & { text: string; as: string }>("Text", props)
  const fallback = typeof children === "string" ? children : ""
  return <TextReveal {...rest} text={text ?? fallback} split={oneOf(split, ["word", "char"])} as={oneOf(as, TEXT_TAGS)} className={cn("inline-block", className)} />
}

export const catalog: Record<ComponentName, Entry> = {
  Card: { box: BLOCK, mode: "wrap", render: Card },
  Button: {
    box: INLINE,
    render: (props, children) => {
      const p = forwarded<ButtonProps & ButtonLinkProps>("Button", props)
      return typeof p.href === "string" ? <ButtonLink {...p}>{children}</ButtonLink> : <Button {...p}>{children}</Button>
    }
  },
  Badge: {
    box: INLINE,
    render: (props, children) => <AnimatedBadge {...forwarded<AnimatedBadgeProps>("Badge", props)}>{children}</AnimatedBadge>
  },
  NumberTicker: {
    box: INLINE,
    render: (props) => {
      const { value, ...rest } = forwarded<NumberTickerProps>("NumberTicker", props)
      return <NumberTicker value={typeof value === "number" ? value : 0} {...rest} />
    }
  },
  Text: { box: INLINE, render: Text },
  Tooltip: {
    box: INLINE,
    render: (props, children) => {
      const { content, ...rest } = forwarded<TooltipProps>("Tooltip", props)
      return (
        <Tooltip content={content ?? ""} {...rest}>
          <span>{children}</span>
        </Tooltip>
      )
    }
  },
  Switch: { box: INLINE, render: (props) => <StatefulSwitch {...props} /> },
  Checkbox: { box: INLINE, render: (props) => <StatefulCheckbox {...props} /> },
  Radio: { box: BLOCK, render: (props) => <Radio {...props} /> },
  Select: { box: INLINE, render: (props) => <Select {...props} /> },
  Input: { box: INLINE, render: (props) => <Input {...forwarded<InputProps>("Input", props)} /> },
  Tabs: { box: BLOCK, render: (props) => <Tabs {...props} /> },
  Accordion: { box: BLOCK, render: (props) => <Accordion {...props} /> },
  Loader: { box: INLINE, render: (props) => <Loader {...forwarded<LoaderProps>("Loader", props)} /> }
}

export const render = (name: ComponentName, props: Props, children: ReactNode): ReactNode => catalog[name].render(props, children)
