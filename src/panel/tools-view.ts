import {
  CheckListIcon,
  CssFile01Icon,
  Globe02Icon,
  Layers01Icon,
  PackageIcon,
  PaintBrush01Icon,
  PaletteIcon,
  SourceCodeIcon,
  Structure01Icon,
  TextAlignLeft01Icon,
  ViewIcon,
  Wrench01Icon
} from "./icons"
import type { IconSvgElement } from "@hugeicons/react"
import {
  CREW_TOOL_NAMES,
  isToolError,
  type ToolName
} from "@/agent/tool-names"
import type { AgentCodeLanguage } from "@/components/agents/agent-code"
import type { ToolResultStatus } from "@/components/agents/tool-result"
import type { Step } from "@/session"

export type ToolCall = Extract<Step, { kind: "tool" }>

export interface ToolBotTarget {
  readonly seed: string
  readonly destination: boolean
}

type CrewToolName = (typeof CREW_TOOL_NAMES)[number]

const CREW_ACTIONS = {
  spawn_agent: "Delegating",
  send_agent: "Messaging",
  read_messages: "Reading messages",
  await_agents: "Waiting for",
  claim_work: "Claiming work",
  release_work: "Releasing work"
} satisfies Readonly<Record<CrewToolName, string>>

export const crewActionOf = (name: string): string | undefined =>
  Object.hasOwn(CREW_ACTIONS, name)
    ? CREW_ACTIONS[name as CrewToolName]
    : undefined

/** How one tool reads on screen: a plain title, an icon, and which input field is code. */
export interface ToolView {
  readonly title: string
  readonly icon: IconSvgElement
  /** What Agent Activity calls this: read, edit, or run. */
  readonly action: "read" | "edit" | "run"
  /** Object of the call when the inputs have no short string. */
  readonly target: string
  /** Input field shown as code, with its language. Other inputs show as JSON. */
  readonly code?: { readonly field: string; readonly language: AgentCodeLanguage }
}

const VIEWS: Readonly<Record<ToolName, ToolView>> = {
  ask_user: { title: "Ask the reader", icon: CheckListIcon, action: "run", target: "question" },
  write_todos: { title: "Update the plan", icon: CheckListIcon, action: "run", target: "plan" },
  spawn_agent: { title: "Delegate to a bot", icon: Structure01Icon, action: "run", target: "new chat" },
  send_agent: { title: "Message a bot", icon: TextAlignLeft01Icon, action: "run", target: "crew" },
  read_messages: { title: "Read bot messages", icon: TextAlignLeft01Icon, action: "read", target: "crew" },
  await_agents: { title: "Wait for bots", icon: CheckListIcon, action: "run", target: "crew" },
  claim_work: { title: "Claim a work area", icon: Layers01Icon, action: "run", target: "page" },
  release_work: { title: "Release a work area", icon: Layers01Icon, action: "run", target: "page" },
  read_page: { title: "Read the page", icon: Structure01Icon, action: "read", target: "body" },
  read_styles: { title: "Read the styles", icon: CssFile01Icon, action: "read", target: "styles" },
  read_text: { title: "Read the text", icon: TextAlignLeft01Icon, action: "read", target: "text" },
  fetch_url: { title: "Fetch a URL", icon: Globe02Icon, action: "read", target: "web" },
  read_design: { title: "Read the design", icon: PaletteIcon, action: "read", target: "design" },
  write_design: { title: "Set the design", icon: PaletteIcon, action: "edit", target: "design" },
  apply_styles: { title: "Apply styles", icon: PaintBrush01Icon, action: "edit", target: "styles", code: { field: "css", language: "css" } },
  run_script: { title: "Run a script", icon: SourceCodeIcon, action: "run", target: "page", code: { field: "js", language: "javascript" } },
  write_skin: { title: "Write the skin", icon: Layers01Icon, action: "edit", target: "skin", code: { field: "files", language: "tsx" } },
  load_kit: { title: "Load the kit", icon: PackageIcon, action: "run", target: "kit" },
  look: { title: "Look at the page", icon: ViewIcon, action: "read", target: "page" },
  read_morph_source: { title: "Read Morph source", icon: SourceCodeIcon, action: "read", target: "Morph" },
  write_morph_source: { title: "Write Morph source", icon: SourceCodeIcon, action: "edit", target: "Morph" },
  rollback_morph: { title: "Restore Morph revision", icon: Layers01Icon, action: "run", target: "revision" },
  rename_morph_draft: { title: "Rename Morph draft", icon: TextAlignLeft01Icon, action: "edit", target: "draft" },
  discard_morph_draft: { title: "Discard Morph draft", icon: Wrench01Icon, action: "run", target: "draft" },
  publish_morph: { title: "Publish Morph", icon: PackageIcon, action: "run", target: "release" }
}

/** A name outside the list: a tool from another build. The row still draws. */
const FALLBACK: ToolView = { title: "Tool call", icon: Wrench01Icon, action: "run", target: "tool" }

const isToolName = (name: string): name is ToolName => name in VIEWS

export const viewOf = (name: string): ToolView => (isToolName(name) ? VIEWS[name] : FALLBACK)

/** The row is 400px wide and the title comes first, so the summary stays short. */
const MAX = 22

const clip = (s: string, max = MAX): string => {
  const one = s.replace(/\s+/g, " ").trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

/** Bots shown on a tool row. Remote crew calls name their destinations; all other calls name the current bot. */
export const botTargetsOf = (call: ToolCall, currentSeed: string): ReadonlyArray<ToolBotTarget> => {
  const input = isRecord(call.input) ? call.input : undefined
  let remote: ReadonlyArray<string> = []
  if (call.name === "send_agent" && typeof input?.["to"] === "string") {
    remote = [input["to"]]
  } else if (call.name === "await_agents" && Array.isArray(input?.["agentIds"])) {
    remote = input["agentIds"].filter((id): id is string => typeof id === "string")
  } else if (call.name === "spawn_agent") {
    const result = isRecord(call.result) ? call.result : undefined
    if (typeof result?.["id"] === "string") remote = [result["id"]]
  }
  const unique = [...new Set(remote)]
  return unique.length === 0
    ? [{ seed: currentSeed, destination: false }]
    : unique.map((seed) => ({ seed, destination: true }))
}

/**
 * A few words that say what a tool call is about, for the collapsed row: the first
 * string input, skipping the code field. Nothing when the inputs are only flags,
 * numbers and objects; the title already says what the call does.
 */
export const summarizeInput = (input: unknown, skip?: string): string => {
  if (typeof input === "string") return clip(input)
  if (!isRecord(input)) return ""
  for (const [key, value] of Object.entries(input)) {
    if (key !== skip && typeof value === "string") return clip(value)
  }
  return ""
}

export const toJson = (value: unknown): string => {
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

/** A call without a result runs while the turn runs; after it, it was cut short. */
export const statusOf = (call: ToolCall, running: boolean): ToolResultStatus => {
  if (call.result === undefined) return running ? "running" : "cancelled"
  return isToolError(call.result) ? "error" : "success"
}

export interface Code {
  readonly label: string
  readonly language: AgentCodeLanguage
  readonly text: string
}

/** What a tool call shows once opened: its code apart, the other inputs, and the result. */
export interface Parts {
  readonly code?: Code
  /** The inputs besides the code, as JSON text; undefined when there is nothing to show. */
  readonly inputs?: string
  readonly result?: string
  readonly summary: string
}

interface NamedFile {
  readonly path: string
  readonly content: string
}

const isNamedFile = (v: unknown): v is NamedFile => isRecord(v) && typeof v["path"] === "string" && typeof v["content"] === "string"

/** The code field as text: the string itself, or a project's files one after the other, each under its path. */
const codeText = (value: unknown): string | undefined => {
  if (typeof value === "string") return value
  if (Array.isArray(value) && value.length > 0 && value.every(isNamedFile)) return value.map((f) => `// ${f.path}\n${f.content}`).join("\n\n")
  return undefined
}

/** The row's words for a project: its first file, and how many more. */
const filesSummary = (value: unknown): string | undefined => {
  if (!Array.isArray(value) || value.length === 0 || !value.every(isNamedFile)) return undefined
  const [first, ...rest] = value as ReadonlyArray<NamedFile>
  if (first === undefined) return undefined
  return rest.length === 0 ? first.path : `${first.path} +${rest.length} ${rest.length === 1 ? "file" : "files"}`
}

/** A write that failed for the User Scripts switch points at the card above the chat, not at its input. */
const USER_SCRIPTS_OFF_SUMMARY = "needs User Scripts, see the card above"

const userScriptsOff = (result: unknown): boolean => isToolError(result) && result.code === "userScriptsOff"

export const partsOf = (call: ToolCall): Parts => {
  const view = viewOf(call.name)
  const field = view.code?.field
  const input = isRecord(call.input) ? call.input : undefined
  const raw = field !== undefined ? input?.[field] : undefined
  const text = codeText(raw)
  const code: Code | undefined = view.code !== undefined && text !== undefined ? { label: view.code.field, language: view.code.language, text } : undefined
  const rest = code === undefined ? call.input : Object.fromEntries(Object.entries(input ?? {}).filter(([k]) => k !== field))
  const shown = rest !== undefined && rest !== null && !(isRecord(rest) && Object.keys(rest).length === 0)
  return {
    ...(code === undefined ? {} : { code }),
    ...(shown ? { inputs: toJson(rest) } : {}),
    ...(call.result === undefined ? {} : { result: toJson(call.result) }),
    summary: userScriptsOff(call.result)
      ? USER_SCRIPTS_OFF_SUMMARY
      : (filesSummary(raw) ?? summarizeInput(call.input, field))
  }
}

/** What the live activity chip names: a short input, or the tool's object. */
export const targetOf = (call: ToolCall): string => {
  const summary = partsOf(call).summary
  return summary === "" ? viewOf(call.name).target : summary
}
