import { Bot, ChevronDown } from "lucide-react"
import { useEffect, useId, useRef, useState } from "react"
import { MorphPopover, MorphPopoverContent, MorphPopoverTrigger } from "@/components/motion/popover-morph"
import { useFavicon } from "@/lib/hooks/use-favicon"
import { cn } from "@/lib/utils"
import {
  AA_SOURCE,
  matches,
  OPENROUTER_SOURCE,
  SORTS,
  sortLine,
  sortModels,
  type CatalogModel,
  type SortKey
} from "./models"
import { Icon } from "./Icon"
import {
  ArtificialIntelligence01Icon,
  DollarReceive01Icon,
  DollarSend01Icon,
  Robot01Icon,
  Sorting01Icon,
  SortingAZ01Icon,
  SourceCodeIcon,
  Tick02Icon
} from "./icons"
import type { IconSvgElement } from "@hugeicons/react"

const SORT_ICONS: Record<SortKey, IconSvgElement> = {
  intelligence: ArtificialIntelligence01Icon,
  coding: SourceCodeIcon,
  agentic: Robot01Icon,
  in: DollarReceive01Icon,
  out: DollarSend01Icon,
  name: SortingAZ01Icon
}

type ScoreField = "intelligence" | "coding" | "agentic"

const SCORE_FIELDS: Partial<Record<SortKey, { field: ScoreField; title: string }>> = {
  intelligence: { field: "intelligence", title: "Intelligence score" },
  coding: { field: "coding", title: "Coding score" },
  agentic: { field: "agentic", title: "Agentic score" }
}

const scoreMetric = (model: CatalogModel, sort: SortKey) => {
  const metric = SCORE_FIELDS[sort]
  if (metric === undefined) return undefined
  const value = model[metric.field]
  return value === undefined ? undefined : { value, title: metric.title }
}

const compactMoney = (money: string): string => money.replace(/\/M$/, "")

const PROVIDER_URLS: Readonly<Record<string, string>> = {
  anthropic: "https://www.anthropic.com",
  deepseek: "https://www.deepseek.com",
  google: "https://deepmind.google",
  meta: "https://www.meta.ai",
  mistralai: "https://mistral.ai",
  moonshotai: "https://www.moonshot.ai",
  openai: "https://openai.com",
  "x-ai": "https://x.ai",
  "z-ai": "https://chatglm.cn"
}

function ModelLogo({ model }: { model: string }) {
  const provider = model.split("/", 1)[0] ?? ""
  const favicon = useFavicon(PROVIDER_URLS[provider])

  if (!favicon.src) return <Bot className="size-3.5" />

  return (
    <img
      ref={favicon.ref}
      src={favicon.src}
      alt=""
      width={16}
      height={16}
      referrerPolicy="no-referrer"
      className="size-4 rounded-sm object-contain"
    />
  )
}

export interface ModelPickerProps {
  models: ReadonlyArray<CatalogModel>
  value: string
  onChange: (model: string) => void
  disabled?: boolean
}

/** The beUI model control with Morph's searchable, sortable OpenRouter catalog. */
export function ModelPicker({ models, value, onChange, disabled = false }: ModelPickerProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [sort, setSort] = useState<SortKey>("intelligence")
  const [sortOpen, setSortOpen] = useState(false)
  const search = useRef<HTMLInputElement>(null)
  const sortRoot = useRef<HTMLDivElement>(null)
  const listId = useId()
  const current = models.find((model) => model.value === value)
  const shown = sortModels(
    models.filter((model) => matches(model, query)),
    sort
  )

  useEffect(() => {
    if (!open) return
    setQuery("")
    setSortOpen(false)
    search.current?.focus()
  }, [open])

  useEffect(() => {
    if (!sortOpen) return
    const onPointer = (event: PointerEvent) => {
      if (sortRoot.current !== null && !sortRoot.current.contains(event.target as Node)) setSortOpen(false)
    }
    window.addEventListener("pointerdown", onPointer)
    return () => window.removeEventListener("pointerdown", onPointer)
  }, [sortOpen])

  return (
    <MorphPopover
      open={open}
      onOpenChange={(next) => {
        if (!disabled) setOpen(next)
      }}
    >
      <MorphPopoverTrigger>
        <button
          type="button"
          disabled={disabled}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={listId}
          className="flex h-8 w-auto max-w-52 items-center gap-1.5 rounded-xl border-0 bg-transparent px-2 py-0 text-xs text-muted-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-50"
        >
          <span className="grid size-4 shrink-0 place-items-center">
            <ModelLogo model={current?.value ?? value} />
          </span>
          <span className="truncate">{current?.label ?? "Choose model"}</span>
          <ChevronDown className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-180")} />
        </button>
      </MorphPopoverTrigger>
      <MorphPopoverContent
        side="top"
        align="start"
        sideOffset={8}
        radius={12}
        className="flex max-h-[min(18rem,calc(100vh-1rem))] w-[min(22rem,calc(100vw-1rem))] flex-col border-0 bg-card p-1.5"
      >
        <div ref={sortRoot} className="relative mb-1">
          <div className="flex items-center gap-1">
            <input
              ref={search}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="Filter models"
              placeholder="Search models"
              className="h-8 min-w-0 flex-1 rounded-lg bg-muted/60 px-2.5 text-xs text-foreground outline-none placeholder:text-muted-foreground"
            />
            <button
              type="button"
              aria-label="Sort models"
              aria-haspopup="menu"
              aria-expanded={sortOpen}
              title="Sort models"
              onClick={() => setSortOpen((next) => !next)}
              className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted/60 text-foreground outline-none hover:bg-muted focus-visible:ring-2"
            >
              <Icon icon={Sorting01Icon} size={16} />
            </button>
          </div>
          {sortOpen ? (
            <div
              role="menu"
              aria-label="Sort by"
              className="absolute right-0 top-0 z-10 w-60 rounded-xl bg-background p-1 shadow-lg"
            >
              {SORTS.map((option) => {
                const selected = option.key === sort
                return (
                  <button
                    key={option.key}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setSort(option.key)
                      setSortOpen(false)
                    }}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left outline-none",
                      selected ? "bg-muted text-foreground" : "hover:bg-muted focus-visible:bg-muted"
                    )}
                  >
                    <Icon icon={SORT_ICONS[option.key]} size={14} className="text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate text-xs text-foreground">{option.label}</span>
                    {option.source !== undefined ? (
                      <span className="shrink-0 text-[10px] text-muted-foreground">{option.source.name}</span>
                    ) : null}
                    {selected ? <Icon icon={Tick02Icon} size={12} /> : null}
                  </button>
                )
              })}
            </div>
          ) : null}
        </div>
        <div id={listId} role="listbox" className="min-h-0 flex-1 overflow-y-auto scrollbar-hide">
          {shown.length === 0 ? (
            <p className="px-2.5 py-2 text-xs text-muted-foreground">No models match</p>
          ) : (
            shown.map((model) => {
              const selected = model.value === value
              const score = scoreMetric(model, sort)
              return (
                <button
                  key={model.value}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  aria-label={`${model.label}, ${sortLine(model, sort)}`}
                  onClick={() => {
                    onChange(model.value)
                    setOpen(false)
                  }}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left outline-none",
                    selected
                      ? "bg-foreground/[0.07] text-foreground"
                      : "hover:bg-foreground/[0.07] focus-visible:bg-foreground/[0.07]"
                  )}
                >
                  <span className="grid size-5 shrink-0 place-items-center text-muted-foreground">
                    <ModelLogo model={model.value} />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground">{model.label}</span>
                  <span className="flex shrink-0 items-center gap-2 font-mono text-[10px] tabular-nums">
                    {score !== undefined ? (
                      <span title={score.title} className="text-violet">
                        {score.value}
                      </span>
                    ) : null}
                    <span title="Input price" className="text-success">
                      {compactMoney(model.in)}
                    </span>
                    <span title="Output price" className="text-warning">
                      {compactMoney(model.out)}
                    </span>
                  </span>
                </button>
              )
            })
          )}
        </div>
        <p className="mt-1 flex flex-wrap items-center gap-x-1 px-2 text-[10px] text-muted-foreground">
          <span>Scores</span>
          <a href={AA_SOURCE.href} target="_blank" rel="noreferrer" className="text-foreground underline-offset-2 hover:underline">
            {AA_SOURCE.name}
          </a>
          <span>· Prices</span>
          <a href={OPENROUTER_SOURCE.href} target="_blank" rel="noreferrer" className="text-foreground underline-offset-2 hover:underline">
            {OPENROUTER_SOURCE.name}
          </a>
        </p>
      </MorphPopoverContent>
    </MorphPopover>
  )
}
