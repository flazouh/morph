import { useEffect, useReducer, useState, type ReactNode } from "react"
import { Button } from "@/components/motion/button"
import { Input } from "@/components/motion/input"
import { DEFAULT_SETTINGS, type Settings } from "@/session/contract"
import { Composer } from "@/panel/Composer"
import { Header } from "@/panel/Header"
import { SettingsView } from "@/panel/SettingsView"
import { Transcript } from "@/panel/Transcript"
import { ChatTabs } from "@/panel/ChatTabs"
import { MODELS } from "@/panel/models"
import { NO_SPEND } from "@/agent/spend"
import type { PanelAction } from "@/overlay/messages"
import { CHAT_GEOMETRY, CHAT_LAYOUT } from "@/overlay/layout"
import { memorySkills } from "@/skills/store"
import { initialPreview, reducePreview, type PreviewState } from "./state"
import type { ChatThread, Step } from "@/session"
import { MorphMascots } from "@/panel/Mascot"
import { ChatLanguage } from "./ChatLanguage"

const TOKENS = [
  { name: "Background", variable: "--background" },
  { name: "Foreground", variable: "--foreground" },
  { name: "Card", variable: "--card" },
  { name: "Muted", variable: "--muted" },
  { name: "Accent", variable: "--accent" },
  { name: "Success", variable: "--success" },
  { name: "Warning", variable: "--warning" },
  { name: "Destructive", variable: "--destructive" }
] as const

const NAV = [
  { href: "#chat-window", label: "Chat window" },
  { href: "#chat-language", label: "Chat language" },
  { href: "#foundations", label: "Foundations" },
  { href: "#controls", label: "Controls" }
] as const

const PREVIEW_SKILLS = memorySkills()

const PREVIEW_STEPS: ReadonlyArray<Step> = [
  { kind: "user", text: "What should the first release include?", at: 1 },
  { kind: "assistant", text: "Start with the smallest workflow that still feels complete.", at: 2 },
  { kind: "user", text: "Include streaming and recovery states too.", at: 3 },
  { kind: "assistant", text: "Yes. Those states make the first version feel dependable.", at: 4 },
  { kind: "user", text: "How should we present tool results?", at: 5 },
  { kind: "assistant", text: "Keep results close to the action that produced them.", at: 6 },
  { kind: "user", text: "What about actions that need confirmation?", at: 7 },
  { kind: "assistant", text: "Pause the run, explain the impact, and ask before continuing.", at: 8 },
  { kind: "user", text: "Can the transcript stay easy to navigate?", at: 9 },
  { kind: "assistant", text: "Use the rail to jump between turns without losing your place.", at: 10 }
]

export function DesignSystem() {
  const [theme, setTheme] = useState<"light" | "dark">("light")
  const [preview, dispatch] = useReducer(reducePreview, initialPreview)

  useEffect(() => {
    document.documentElement.setAttribute("data-beui-theme", theme)
  }, [theme])

  return (
    <div className="min-h-screen bg-muted/45 text-foreground">
      <header className="sticky top-0 z-50 flex h-14 items-center bg-background/95 px-5 shadow-[0_1px_0_var(--border)] backdrop-blur-md">
        <a href="#top" className="flex items-center gap-2.5 font-semibold tracking-[-0.02em]">
          <MorphMascots />
          Interface system
        </a>
        <div className="ml-auto flex items-center gap-2">
          <span className="hidden text-xs text-muted-foreground sm:inline">Vite preview</span>
          <Button
            variant="secondary"
            size="sm"
            aria-label={theme === "light" ? "Use dark theme" : "Use light theme"}
            aria-pressed={theme === "dark"}
            onClick={() => setTheme((current) => (current === "light" ? "dark" : "light"))}
          >
            {theme === "light" ? "Dark theme" : "Light theme"}
          </Button>
        </div>
      </header>

      <div id="top" className="mx-auto grid max-w-[1500px] grid-cols-1 lg:grid-cols-[200px_minmax(0,1fr)]">
        <aside className="hidden px-5 py-10 lg:block">
          <nav className="sticky top-24 space-y-1" aria-label="Design system sections">
            <p className="mb-3 px-2 text-xs font-medium text-muted-foreground">On this page</p>
            {NAV.map((item) => (
              <a
                key={item.href}
                href={item.href}
                className="block rounded-lg px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
              >
                {item.label}
              </a>
            ))}
          </nav>
        </aside>

        <main className="min-w-0 px-4 py-10 sm:px-8 lg:px-10">
          <div className="mb-10 max-w-2xl">
            <p className="text-sm text-muted-foreground">Morph Chrome extension</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-[-0.03em] sm:text-4xl">Interface system</h1>
            <p className="mt-4 max-w-xl text-sm leading-6 text-muted-foreground">
              Check the real panel controls and core interface tokens without loading the extension.
            </p>
          </div>

          <Section
            id="chat-window"
            title="Agent chat window"
            description="Use the red, yellow, and green controls inside the preview. The reopen widget keeps the prior size."
          >
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <StateBadge label={preview.open ? preview.mode : "closed"} />
              <Button variant="secondary" size="sm" onClick={() => dispatch({ type: "openChat" })}>
                Reset preview
              </Button>
            </div>
            <PreviewStage preview={preview} dispatch={dispatch} />
          </Section>

          <Section
            id="chat-language"
            title="Agent chat language"
            description="Review every production question, bot state, and tool call in one place."
          >
            <ChatLanguage />
          </Section>

          <Section
            id="foundations"
            title="Foundations"
            description="The page reads the same CSS variables and typefaces as the shipped panel."
          >
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {TOKENS.map((token) => (
                <div key={token.variable} className="overflow-hidden rounded-xl bg-background shadow-sm">
                  <div className="h-20" style={{ backgroundColor: `var(${token.variable})` }} />
                  <div className="px-3 py-2.5">
                    <p className="text-xs font-medium">{token.name}</p>
                    <code className="mt-1 block text-[10px] text-muted-foreground">{token.variable}</code>
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-4 rounded-xl bg-background p-5 shadow-sm">
              <div className="grid gap-6 md:grid-cols-[1fr_1fr]">
                <div>
                  <p className="text-xs text-muted-foreground">Display</p>
                  <p className="mt-2 text-3xl font-semibold tracking-[-0.03em]">Make the page feel clear.</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Body and code</p>
                  <p className="mt-2 max-w-md text-sm leading-6">
                    Geist carries the interface. Geist Mono is reserved for prices, tokens, and code.
                  </p>
                  <code className="mt-3 block font-mono text-xs text-muted-foreground">promptTokens: 24,810</code>
                </div>
              </div>
            </div>
          </Section>

          <Section
            id="controls"
            title="Controls"
            description="Interactive states use the production motion and focus behavior."
          >
            <div className="grid gap-4 md:grid-cols-2">
              <div className="rounded-xl bg-background p-5 shadow-sm">
                <p className="mb-4 text-xs font-medium text-muted-foreground">Buttons</p>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm">Primary</Button>
                  <Button variant="secondary" size="sm">
                    Secondary
                  </Button>
                  <Button variant="outline" size="sm">
                    Outline
                  </Button>
                  <Button variant="ghost" size="sm">
                    Ghost
                  </Button>
                  <Button size="sm" disabled>
                    Disabled
                  </Button>
                </div>
              </div>
              <div className="rounded-xl bg-background p-5 shadow-sm">
                <p className="mb-4 text-xs font-medium text-muted-foreground">Inputs</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Input label="Repository" defaultValue="acme/storefront" />
                  <Input label="OpenRouter key" defaultValue="sk-or-••••••" success />
                </div>
              </div>
            </div>
          </Section>
        </main>
      </div>
    </div>
  )
}

function PreviewStage({
  preview,
  dispatch
}: {
  preview: PreviewState
  dispatch: (action: Parameters<typeof reducePreview>[1]) => void
}) {
  const [draft, setDraft] = useState("")
  const [model, setModel] = useState(DEFAULT_SETTINGS.model)
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [threads, setThreads] = useState<ReadonlyArray<ChatThread>>([
    { id: "homepage", title: "Homepage refresh", createdAt: 0 },
    { id: "checkout", title: "Checkout flow", createdAt: 1 }
  ])
  const [selectedThread, setSelectedThread] = useState("homepage")

  const act = (action: PanelAction) => dispatch(action)
  const newThread = () => {
    const thread = { id: `preview-${threads.length}`, title: "New chat", createdAt: threads.length }
    setThreads((current) => [...current, thread])
    setSelectedThread(thread.id)
    setDraft("")
  }

  return (
    <div className="relative -mx-4 h-[max(720px,calc(84vh+48px))] overflow-hidden bg-[#dfe2e4] shadow-inner sm:mx-0 sm:rounded-2xl dark:bg-[#0d0d0d]">
      <div className="absolute left-5 top-4 flex items-center gap-2 text-[11px] text-[#5e6266] dark:text-[#8a8a8a]">
        <span className="size-2 rounded-full bg-success" />
        Interactive preview
      </div>

      {preview.open && preview.mode !== "minimized" ? (
        <article
          aria-label="Agent chat preview"
          style={{
            ...CHAT_LAYOUT[preview.mode],
            ...(settingsOpen && preview.mode === "normal" ? { width: `${CHAT_GEOMETRY.settings.width}px` } : {}),
            transition: "width 260ms cubic-bezier(0.22,1,0.36,1)"
          }}
          className="absolute flex flex-col bg-background shadow-[0_24px_70px_-28px_rgba(0,0,0,0.55)]"
        >
          {settingsOpen ? (
            <SettingsView
              settings={settings}
              skills={PREVIEW_SKILLS}
              onChange={(patch) => setSettings((current) => ({ ...current, ...patch }))}
              onBack={() => setSettingsOpen(false)}
            />
          ) : (
            <>
          <Header
            busy={false}
            onForgetPage={() => setDraft("")}
            onForgetSite={() => setDraft("")}
            onOpenSettings={() => setSettingsOpen(true)}
            onWindowAction={act}
          />
          <ChatTabs
            threads={threads}
            selected={selectedThread}
            onSelect={setSelectedThread}
            onNew={newThread}
            onClose={(id) => {
              setThreads((current) => {
                const remaining = current.filter((thread) => thread.id !== id)
                if (remaining.length === 0) return current
                if (selectedThread === id) setSelectedThread(remaining[0]!.id)
                return remaining
              })
            }}
          />
          <div
            id="chat-transcript"
            role="tabpanel"
            aria-labelledby="active-chat-thread-tab"
            className="min-h-0 flex-1"
          >
            <Transcript steps={PREVIEW_STEPS} state="idle" />
          </div>
          <footer className="shrink-0 p-2">
            <Composer
              value={draft}
              onValueChange={setDraft}
              disabled={false}
              working={false}
              onSend={() => setDraft("")}
              onStop={() => undefined}
              onSteer={() => undefined}
              models={MODELS}
              model={model}
              onModelChange={setModel}
              spend={NO_SPEND}
            />
          </footer>
            </>
          )}
        </article>
      ) : null}

      {preview.open && preview.mode === "minimized" ? (
        <button
          type="button"
          aria-label="Open Morph"
          title="Open Morph"
          onClick={() => dispatch({ type: "restoreChat" })}
          style={CHAT_LAYOUT.minimized}
          className="absolute flex cursor-pointer items-center gap-2 bg-[#151515] px-2 pr-3 text-xs font-semibold text-[#f5f5f5] shadow-[0_14px_38px_rgba(0,0,0,0.28)] outline-none transition-[background-color,box-shadow,transform] hover:bg-[#242424] hover:shadow-[0_16px_42px_rgba(0,0,0,0.34)] active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-white"
        >
          <MorphMascots />
          <span className="whitespace-nowrap">Morph</span>
        </button>
      ) : null}

      {!preview.open ? (
        <div className="absolute inset-0 grid place-items-center">
          <div className="text-center">
            <p className="mb-3 text-sm text-[#5e6266] dark:text-[#a0a0a0]">The chat is closed.</p>
            <Button size="sm" onClick={() => dispatch({ type: "openChat" })}>
              Reopen chat
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function StateBadge({ label }: { label: string }) {
  return (
    <span className="rounded-full bg-background px-2.5 py-1 font-mono text-[11px] text-muted-foreground shadow-sm">
      state: {label}
    </span>
  )
}

function Section({
  id,
  title,
  description,
  children
}: {
  id: string
  title: string
  description: string
  children: ReactNode
}) {
  return (
    <section id={id} className="mb-16 scroll-mt-24">
      <div className="mb-5">
        <h2 className="text-xl font-semibold tracking-[-0.02em]">{title}</h2>
        <p className="mt-1.5 max-w-2xl text-sm leading-6 text-muted-foreground">{description}</p>
      </div>
      {children}
    </section>
  )
}
