/**
 * The vocabulary the agent and the panel share about tools: the names, and the shape of
 * a failed answer. Pure data, so the panel imports no agent code. `toolsFor` is pinned
 * to this list by a test; the panel's view table is typed by it.
 */
export const CREW_TOOL_NAMES = [
  "spawn_agent",
  "send_agent",
  "read_messages",
  "await_agents",
  "claim_work",
  "release_work"
] as const

export const MORPH_TOOL_NAMES = [
  "read_morph_source",
  "write_morph_source",
  "rollback_morph",
  "rename_morph_draft",
  "discard_morph_draft",
  "publish_morph"
] as const

export const TOOL_NAMES = [
  "ask_user",
  "write_todos",
  ...CREW_TOOL_NAMES,
  "read_page",
  "read_styles",
  "read_text",
  "fetch_url",
  "read_design",
  "write_design",
  "apply_styles",
  "run_script",
  "write_skin",
  "load_kit",
  "look",
  ...MORPH_TOOL_NAMES
] as const

export type ToolName = (typeof TOOL_NAMES)[number]

/** The one tool that waits on the reader, not the page: it takes no turn in the page-write queue. */
export const ASK_USER: ToolName = "ask_user"

/**
 * A failure the panel acts on by kind, not by reading the prose. The prose is written for
 * the model and free to change; the code is the contract.
 */
export type ToolErrorCode = "userScriptsOff"

/** A tool that fails answers with a value the model reads; the panel draws it as failed. */
export interface ToolError {
  readonly error: string
  readonly code?: ToolErrorCode
}

export const isToolError = (result: unknown): result is ToolError =>
  typeof result === "object" && result !== null && typeof (result as ToolError).error === "string"
