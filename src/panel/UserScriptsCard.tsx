import { useEffect, useReducer } from "react"
import type { UserScriptsGate } from "@/bridge/user-scripts"
import { ToolApproval } from "@/components/agents/tool-approval"
import { cn } from "@/lib/utils"
import {
  pollsUserScripts,
  reduceUserScripts,
  userScriptsApprovalStatus,
  userScriptsCopy,
  userScriptsVisible,
  type UserScriptsStage
} from "./user-scripts-card"
import { viewOf } from "./tools-view"

export interface UserScriptsCardProps {
  readonly gate: UserScriptsGate
  /** How often the card asks the worker while it waits. Tests shorten it. */
  readonly pollMs?: number
  /** How long the card says “on” before it goes. Tests shorten it. */
  readonly hideMs?: number
  readonly className?: string
}

/** The switch is on a page the panel cannot draw in, so the details say where, and what it unlocks in the panel's own words. */
const PARAMETERS = [
  { id: "setting", label: "Setting", value: "Allow User Scripts" },
  { id: "page", label: "Where", value: "chrome://extensions → Morph → Details" },
  {
    id: "unlocks",
    label: "Unlocks",
    value: (["write_design", "apply_styles", "run_script", "load_kit"] as const).map((name) => viewOf(name).title).join(", ")
  }
]

/**
 * The permission card for `chrome.userScripts`: Morph's one browser switch, asked for the
 * way a tool asks for approval. It reads the switch through the worker, since the worker
 * is what writes pages, and checks again while the reader is at the switch.
 */
export function UserScriptsCard({ gate, pollMs = 1500, hideMs = 2400, className }: UserScriptsCardProps) {
  const [stage, dispatch] = useReducer(reduceUserScripts, "unknown" as UserScriptsStage)
  const polling = pollsUserScripts(stage)

  // One read on mount decides whether the card is drawn at all.
  useEffect(() => {
    void gate.enabled().then((enabled) => dispatch({ type: "checked", enabled }))
  }, [gate])

  // While the reader can still act, keep reading: on a timer, and on the way back from the settings tab.
  useEffect(() => {
    if (!polling) return
    let stopped = false
    const check = () => {
      void gate.enabled().then((enabled) => {
        if (!stopped) dispatch({ type: "checked", enabled })
      })
    }
    const id = window.setInterval(check, pollMs)
    window.addEventListener("focus", check)
    document.addEventListener("visibilitychange", check)
    return () => {
      stopped = true
      window.clearInterval(id)
      window.removeEventListener("focus", check)
      document.removeEventListener("visibilitychange", check)
    }
  }, [gate, pollMs, polling])

  // “On” is said for a moment, then the card goes.
  useEffect(() => {
    if (stage !== "on") return
    const id = window.setTimeout(() => dispatch({ type: "gone" }), hideMs)
    return () => window.clearTimeout(id)
  }, [stage, hideMs])

  if (!userScriptsVisible(stage)) return null
  const copy = userScriptsCopy(stage)

  return (
    <div className={cn("px-2 pt-2", className)}>
      <ToolApproval
        tool="chrome.userScripts"
        title={copy.title}
        description={copy.description}
        parameters={PARAMETERS}
        status={userScriptsApprovalStatus(stage)}
        statusLabel={copy.status}
        approveLabel="Open Morph settings"
        denyLabel="Not now"
        onApprove={() => {
          dispatch({ type: "openSettings" })
          void gate.openSettings()
        }}
        onDeny={() => dispatch({ type: "dismiss" })}
        className="bg-card text-[13px]"
      >
        {stage === "opened" ? (
          <p className="text-xs leading-5 text-muted-foreground">
            Turned it on and Morph still waits? Chrome tells a running Morph late.{" "}
            <button
              type="button"
              onClick={() => void gate.reload()}
              className="rounded-md font-medium text-foreground underline decoration-border underline-offset-2 outline-none transition-colors hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              Reload Morph
            </button>
            , then open it again.
          </p>
        ) : null}
      </ToolApproval>
    </div>
  )
}
