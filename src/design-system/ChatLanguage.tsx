import { useState } from "react"
import { TOOL_NAMES, type ToolName } from "@/agent/tool-names"
import type { ChatThread } from "@/session"
import { AskUserCard } from "@/panel/AskUserCard"
import { ChatTabs } from "@/panel/ChatTabs"
import { ToolStep } from "@/panel/ToolStep"
import { statusOf, viewOf, type ToolCall } from "@/panel/tools-view"

interface ToolSample {
  readonly input: unknown
  readonly result?: unknown
  readonly running?: boolean
}

const TOOL_SAMPLES: Readonly<Record<Exclude<ToolName, "ask_user">, ToolSample>> = {
  write_todos: {
    input: { todos: [{ id: "1", title: "Map the product grid", status: "completed" }] },
    result: { ok: true }
  },
  spawn_agent: {
    input: { title: "Layout bot", brief: "Rework the product grid.", target: "main" },
    result: { id: "bot-layout", status: "working" }
  },
  send_agent: {
    input: { to: "bot-copy", message: "Keep the labels under 24 characters." },
    result: { ok: true }
  },
  read_messages: {
    input: {},
    result: { messages: [{ from: "bot-copy", text: "Labels are ready." }] }
  },
  await_agents: {
    input: { agentIds: ["bot-layout", "bot-copy"] },
    running: true
  },
  claim_work: {
    input: { capability: "css", selector: ".product-grid" },
    result: { ok: true, owner: "bot-layout" }
  },
  release_work: {
    input: { capability: "css", selector: ".product-grid" },
    result: { ok: true }
  },
  read_page: {
    input: { selector: "main" },
    result: { title: "Storefront", nodes: 184 }
  },
  read_styles: {
    input: { selector: ".product-card" },
    result: [{ selector: ".product-card", display: "grid" }]
  },
  fetch_url: {
    input: { url: "https://api.example.com/films/tt0111161", accept: "json" },
    result: { url: "https://api.example.com/films/tt0111161", status: 200, contentType: "application/json", body: '{"rating":9.3}', truncated: false }
  },
  read_text: {
    input: { selector: "main" },
    result: ["New arrivals", "Shop all"]
  },
  read_design: {
    input: {},
    result: { theme: "light", tokens: { primary: "#00bebf" } }
  },
  write_design: {
    input: { tokens: { primary: "#00bebf", radius: "1rem" } },
    result: { ok: true }
  },
  apply_styles: {
    input: { css: ".product-grid { gap: 1.25rem; }" },
    result: { ok: true }
  },
  run_script: {
    input: { js: "document.querySelector('main')?.focus()" },
    result: { ok: true }
  },
  write_skin: {
    input: {
      files: [{ path: "page.tsx", content: "export default function Store() { return <main /> }" }]
    },
    result: { ok: true, files: 1 }
  },
  load_kit: {
    input: {},
    result: { ok: true }
  },
  look: {
    input: {},
    result: { ok: true, image: "Screenshot attached to the model." }
  },
  read_morph_source: {
    input: { path: "entry.tsx" },
    result: { path: "entry.tsx", content: "export const start = () => null" }
  },
  write_morph_source: {
    input: { files: [{ path: "entry.tsx", content: "export const start = () => null" }] },
    result: { draftId: "draft-1", revisionId: "revision-2" }
  },
  rollback_morph: {
    input: { draftId: "draft-1", revisionId: "revision-1" },
    result: { draftId: "draft-1", revisionId: "revision-1" }
  },
  rename_morph_draft: {
    input: { draftId: "draft-1", name: "Quiet inbox" },
    result: { draftId: "draft-1", name: "Quiet inbox" }
  },
  discard_morph_draft: {
    input: { draftId: "draft-1" },
    result: { ok: true }
  },
  publish_morph: {
    input: { draftId: "draft-1", confirmationCallId: "confirm-release" },
    result: { state: "completed", slug: "alex/quiet-inbox", version: "1.0.0" }
  }
}

const BOT_THREADS: ReadonlyArray<ChatThread> = [
  { id: "root", title: "Storefront", createdAt: 1 },
  {
    id: "bot-layout",
    title: "Layout bot",
    createdAt: 2,
    parentId: "root",
    rootId: "root",
    agentId: "bot-layout",
    status: "working"
  },
  {
    id: "bot-copy",
    title: "Copy bot",
    createdAt: 3,
    parentId: "root",
    rootId: "root",
    agentId: "bot-copy",
    status: "done"
  }
]

const QUESTION_INPUT = {
  title: "Choose a direction",
  description: "The bots can build either route. Pick one before they start.",
  asciiPreview: "┌──────────────┐  ┌──────┐\n│  IMAGE  COPY │  │ ITEM │\n│  IMAGE  CTA  │  │ ITEM │\n└──────────────┘  └──────┘",
  question: "Which direction should the redesign take?",
  options: [
    { id: "editorial", label: "Editorial grid", description: "Large imagery with clear sections." },
    { id: "compact", label: "Compact list", description: "More products above the fold." }
  ]
}

const callOf = (name: Exclude<ToolName, "ask_user">, index: number): ToolCall => {
  const sample = TOOL_SAMPLES[name]
  return {
    kind: "tool",
    callId: `preview-${name}`,
    name,
    input: sample.input,
    ...(sample.result === undefined ? {} : { result: sample.result }),
    at: index + 1
  }
}

export function ChatLanguage() {
  const [answer, setAnswer] = useState<ReadonlyArray<string>>([])
  const question: ToolCall = {
    kind: "tool",
    callId: "preview-question",
    name: "ask_user",
    input: QUESTION_INPUT,
    ...(answer.length === 0
      ? {}
      : {
          result: {
            selected: QUESTION_INPUT.options.filter((option) => answer.includes(option.id))
          }
        }),
    at: 1
  }

  return (
    <div aria-label="Chat language examples" className="space-y-5">
      <div className="grid gap-4 xl:grid-cols-2">
        <ShowcaseCard
          eyebrow="Decision"
          title="Ask the reader"
          detail="Pending and answered states use the same production card."
          dataTool="ask_user"
        >
          <AskUserCard call={question} onAnswer={(_, ids) => setAnswer(ids)} />
        </ShowcaseCard>

        <ShowcaseCard
          eyebrow="Parallel work"
          title="Bot chats"
          detail="Child chats stay next to their parent and show live status."
        >
          <div className="overflow-hidden rounded-xl border border-border bg-background">
            <ChatTabs
              threads={BOT_THREADS}
              selected="root"
              onSelect={() => undefined}
              onNew={() => undefined}
              onClose={() => undefined}
            />
            <div className="grid gap-3 p-4 sm:grid-cols-2">
              <BotState name="Layout bot" status="Working" detail="Editing the product grid" tone="accent" />
              <BotState name="Copy bot" status="Done" detail="Returned 12 labels" tone="success" />
            </div>
          </div>
        </ShowcaseCard>
      </div>

      <div className="rounded-2xl bg-background p-4 shadow-sm sm:p-5">
        <div className="mb-4">
          <p className="text-xs font-medium text-muted-foreground">Tool vocabulary</p>
          <h3 className="mt-1 text-base font-semibold tracking-[-0.02em]">Every call the transcript can show</h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            These rows use the shipped tool disclosure, inputs, results, and status rules.
          </p>
        </div>
        <div className="grid gap-2 lg:grid-cols-2">
          {TOOL_NAMES.filter((name): name is Exclude<ToolName, "ask_user"> => name !== "ask_user").map(
            (name, index) => {
              const call = callOf(name, index)
              const running = TOOL_SAMPLES[name].running === true
              return (
                <div key={name} data-tool={name} className="rounded-xl border border-border bg-card/55 p-2">
                  <div className="mb-1 flex items-center justify-between px-1">
                    <code className="text-[10px] text-muted-foreground">{name}</code>
                    <span className="text-[10px] capitalize text-muted-foreground">
                      {statusOf(call, running)}
                    </span>
                  </div>
                  <ToolStep
                    call={call}
                    running={running}
                    mascot={{ seed: `tool-bot-${index}` }}
                  />
                </div>
              )
            }
          )}
        </div>
      </div>
    </div>
  )
}

function ShowcaseCard({
  eyebrow,
  title,
  detail,
  dataTool,
  children
}: {
  readonly eyebrow: string
  readonly title: string
  readonly detail: string
  readonly dataTool?: string
  readonly children: React.ReactNode
}) {
  return (
    <article data-tool={dataTool} className="rounded-2xl bg-background p-4 shadow-sm sm:p-5">
      <p className="text-xs font-medium text-muted-foreground">{eyebrow}</p>
      <h3 className="mt-1 text-base font-semibold tracking-[-0.02em]">{title}</h3>
      <p className="mt-1 mb-4 text-xs leading-5 text-muted-foreground">{detail}</p>
      {children}
    </article>
  )
}

function BotState({
  name,
  status,
  detail,
  tone
}: {
  readonly name: string
  readonly status: string
  readonly detail: string
  readonly tone: "accent" | "success"
}) {
  return (
    <div className="rounded-xl bg-card p-3">
      <div className="flex items-center gap-2">
        <span className={tone === "accent" ? "size-2 rounded-full bg-accent" : "size-2 rounded-full bg-success"} />
        <span className="font-medium">{name}</span>
        <span className="ml-auto text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{status}</span>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{detail}</p>
    </div>
  )
}
