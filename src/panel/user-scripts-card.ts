import type { ToolApprovalStatus } from "@/components/agents/tool-approval"

/**
 * What the User Scripts card knows, apart from how it is drawn.
 *
 * `unknown`: the first check has not answered; nothing is drawn.
 * `off`: the switch is off; the card asks.
 * `opened`: the reader went to the switch; the card waits and checks.
 * `on`: the switch is on; the card says so, then goes.
 * `done`: the card said so and went. Nothing more to check in this panel.
 * `dismissed`: the reader said not now; the card stays away for this panel.
 */
export type UserScriptsStage = "unknown" | "off" | "opened" | "on" | "done" | "dismissed"

export type UserScriptsEvent =
  | { readonly type: "checked"; readonly enabled: boolean }
  | { readonly type: "openSettings" }
  | { readonly type: "dismiss" }
  | { readonly type: "gone" }

const settled = (stage: UserScriptsStage): boolean => stage === "dismissed" || stage === "done"

export const reduceUserScripts = (stage: UserScriptsStage, event: UserScriptsEvent): UserScriptsStage => {
  switch (event.type) {
    case "dismiss":
      return "dismissed"
    case "gone":
      return stage === "on" ? "done" : stage
    case "openSettings":
      return settled(stage) ? stage : "opened"
    case "checked":
      if (settled(stage)) return stage
      if (event.enabled) return "on"
      // A switch turned off again after it was on brings the card back to asking.
      return stage === "opened" ? "opened" : "off"
  }
}

/** The card checks the switch while the reader can still act on the answer. */
export const pollsUserScripts = (stage: UserScriptsStage): boolean => stage === "off" || stage === "opened"

export const userScriptsVisible = (stage: UserScriptsStage): boolean =>
  stage === "off" || stage === "opened" || stage === "on"

export const userScriptsApprovalStatus = (stage: UserScriptsStage): ToolApprovalStatus => {
  switch (stage) {
    case "opened":
      return "running"
    case "on":
      return "complete"
    default:
      return "pending"
  }
}

export interface UserScriptsCopy {
  readonly title: string
  readonly description: string
  readonly status: string
}

export const userScriptsCopy = (stage: UserScriptsStage): UserScriptsCopy => {
  switch (stage) {
    case "opened":
      return {
        title: "Turn on Allow User Scripts",
        description:
          "On the Morph details page, find “Allow User Scripts” and turn it on. This card changes as soon as Morph can write.",
        status: "Waiting"
      }
    case "on":
      return {
        title: "User Scripts is on",
        description: "Morph can restyle this page now.",
        status: "On"
      }
    default:
      return {
        title: "Morph needs User Scripts",
        description:
          "Morph restyles a page by running its styles and scripts on it through Chrome User Scripts. Chrome keeps that off until you turn it on once for Morph. Reads work; writes wait.",
        status: "Switch off"
      }
  }
}
