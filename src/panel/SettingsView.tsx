import type { IconSvgElement } from "@hugeicons/react"
import { useEffect, useState } from "react"
import { Button } from "@/components/motion/button"
import { Input, type InputClassNames } from "@/components/motion/input"
import type { FontSize, Provider, Settings, ThemeChoice } from "@/session/contract"
import type { SkillsStore } from "@/skills/contract"
import { cn } from "@/lib/utils"
import { Icon } from "./Icon"
import { SkillsSection } from "./SkillsSection"
import {
  ArrowLeft01Icon,
  ArtificialIntelligence01Icon,
  CheckListIcon,
  PaintBrush01Icon
} from "./icons"
import { loadCursorModels as defaultLoadCursorModels, type CatalogModel } from "./models"

export interface SettingsViewProps {
  settings: Settings
  skills: SkillsStore
  onChange: (patch: Partial<Settings>) => void
  onBack: () => void
  loadCursorModels?: (key: string) => Promise<ReadonlyArray<CatalogModel>>
}

type SectionId = "appearance" | "provider" | "skills"

interface Section {
  readonly id: SectionId
  readonly label: string
  readonly icon: IconSvgElement
}

const SECTIONS: ReadonlyArray<Section> = [
  { id: "appearance", label: "Appearance", icon: PaintBrush01Icon },
  { id: "provider", label: "AI provider", icon: ArtificialIntelligence01Icon },
  { id: "skills", label: "Skills", icon: CheckListIcon }
]

const field: InputClassNames = {
  label: "px-0 text-xs text-muted-foreground",
  field: "h-9 rounded-lg border-0 bg-card focus-within:ring-2 focus-within:ring-ring/60",
  input: "text-[13px] pl-2.5 pr-2.5 font-mono"
}

/** The whole panel becomes the settings workspace: a fixed section list, then the chosen section. */
export function SettingsView({
  settings,
  skills,
  onChange,
  onBack,
  loadCursorModels = defaultLoadCursorModels
}: SettingsViewProps) {
  const [section, setSection] = useState<SectionId>("appearance")

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <div className="flex h-10 shrink-0 items-center px-2">
        <Button variant="ghost" size="sm" onClick={onBack} aria-label="Back to chat">
          <Icon icon={ArrowLeft01Icon} size={14} />
          Back to chat
        </Button>
      </div>
      <div className="flex min-h-0 flex-1">
        <nav
          aria-label="Settings sections"
          className="flex w-12 shrink-0 flex-col gap-0.5 bg-card/40 p-2 min-[480px]:w-36"
        >
          {SECTIONS.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-label={item.label}
              title={item.label}
              onClick={() => setSection(item.id)}
              aria-current={section === item.id ? "page" : undefined}
              className={cn(
                "flex items-center justify-center gap-2 rounded-lg px-2 py-2 text-left text-[13px] outline-none transition-colors min-[480px]:justify-start min-[480px]:px-2.5",
                "focus-visible:ring-2 focus-visible:ring-ring/60",
                section === item.id
                  ? "bg-card font-medium text-foreground"
                  : "text-muted-foreground hover:bg-card/60 hover:text-foreground"
              )}
            >
              <Icon icon={item.icon} size={15} className="shrink-0" />
              <span className="hidden min-[480px]:inline">{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="min-w-0 flex-1 overflow-y-auto p-3 min-[480px]:p-4">
          {section === "appearance" ? <AppearanceSection settings={settings} onChange={onChange} /> : null}
          {section === "provider" ? (
            <ProviderSection settings={settings} onChange={onChange} loadCursorModels={loadCursorModels} />
          ) : null}
          {section === "skills" ? <SkillsSection store={skills} /> : null}
        </div>
      </div>
    </div>
  )
}

interface SectionProps {
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
}

interface ProviderSectionProps extends SectionProps {
  loadCursorModels: (key: string) => Promise<ReadonlyArray<CatalogModel>>
}

function SectionHeading({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="mb-4 flex flex-col gap-0.5">
      <h2 className="text-sm font-medium text-foreground">{title}</h2>
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  )
}

interface Choice<T extends string> {
  readonly value: T
  readonly label: string
}

/** A small segmented control: one row of buttons, the active one pressed. */
function Segmented<T extends string>({
  label,
  value,
  choices,
  onSelect
}: {
  label: string
  value: T
  choices: ReadonlyArray<Choice<T>>
  onSelect: (value: T) => void
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="px-0 text-xs text-muted-foreground">{label}</span>
      <div role="group" aria-label={label} className="flex gap-1 rounded-lg bg-card p-1">
        {choices.map((choice) => (
          <button
            key={choice.value}
            type="button"
            aria-pressed={value === choice.value}
            onClick={() => onSelect(choice.value)}
            className={cn(
              "flex-1 rounded-md px-2.5 py-1.5 text-[13px] outline-none transition-colors",
              "focus-visible:ring-2 focus-visible:ring-ring/60",
              value === choice.value
                ? "bg-background font-medium text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {choice.label}
          </button>
        ))}
      </div>
    </div>
  )
}

const THEMES: ReadonlyArray<Choice<ThemeChoice>> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" }
]

const FONT_SIZES: ReadonlyArray<Choice<FontSize>> = [
  { value: "small", label: "Small" },
  { value: "default", label: "Default" },
  { value: "large", label: "Large" }
]

const PROVIDERS: ReadonlyArray<Choice<Provider>> = [
  { value: "openrouter", label: "OpenRouter" },
  { value: "cursor", label: "Cursor" }
]

function AppearanceSection({ settings, onChange }: SectionProps) {
  return (
    <div className="flex flex-col gap-5">
      <SectionHeading title="Appearance" hint="How the panel looks." />
      <Segmented label="Theme" value={settings.theme} choices={THEMES} onSelect={(theme) => onChange({ theme })} />
      <Segmented
        label="Font size"
        value={settings.fontSize}
        choices={FONT_SIZES}
        onSelect={(fontSize) => onChange({ fontSize })}
      />
    </div>
  )
}

function ProviderSection({ settings, onChange, loadCursorModels }: ProviderSectionProps) {
  const [check, setCheck] = useState<{ kind: "idle" | "checking" | "success" | "error"; text: string }>({
    kind: "idle",
    text: ""
  })
  useEffect(() => {
    setCheck({ kind: "idle", text: "" })
  }, [settings.cursorKey])

  const checkConnection = async () => {
    setCheck({ kind: "checking", text: "Checking…" })
    try {
      const models = await loadCursorModels(settings.cursorKey)
      setCheck({ kind: "success", text: `Connected · ${models.length} ${models.length === 1 ? "model" : "models"}` })
    } catch (error) {
      setCheck({ kind: "error", text: error instanceof Error ? error.message : String(error) })
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <SectionHeading title="AI provider" hint="The key the panel calls the model with." />
      <Segmented label="Provider" value={settings.provider} choices={PROVIDERS} onSelect={(provider) => onChange({ provider })} />
      {settings.provider === "openrouter" ? (
        <Input
          label="OpenRouter key"
          type="password"
          autoComplete="off"
          value={settings.openRouterKey}
          onChange={(v) => onChange({ openRouterKey: v })}
          placeholder="sk-or-…"
          classNames={field}
        />
      ) : (
        <>
          <Input
            label="Cursor key"
            type="password"
            autoComplete="off"
            value={settings.cursorKey}
            onChange={(v) => onChange({ cursorKey: v })}
            placeholder="crsr_…"
            classNames={field}
          />
          <a
            href="https://cursor.com/dashboard/api"
            target="_blank"
            rel="noreferrer"
            className="w-fit text-xs text-foreground underline underline-offset-2"
          >
            Get a Cursor API key
          </a>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={check.kind === "checking"}
              onClick={() => void checkConnection()}
            >
              Check connection
            </Button>
            {check.kind === "idle" ? null : (
              <span
                role="status"
                aria-live="polite"
                className={cn("text-xs", check.kind === "error" ? "text-destructive" : "text-muted-foreground")}
              >
                {check.text}
              </span>
            )}
          </div>
        </>
      )}
    </div>
  )
}

