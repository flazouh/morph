/**
 * Crew constants and the append-only event log.
 *
 * All crew state derives from a sequence of CrewEvents. Nothing else is
 * canonical. The coordinator appends events; the projection in state.ts
 * rebuilds state from them.
 */

export const MAX_AGENTS = 4
export const MAX_DEPTH = 2

export type AgentStatus = "working" | "waiting" | "done" | "failed" | "stopped"

/**
 * Every mutation the crew records. No timestamps or IDs from the environment
 * are added by correctness logic; callers may inject them only for display.
 */
export type CrewEvent =
  | {
      readonly type: "AgentSpawned"
      readonly agentId: string
      readonly parentId: string | null
      readonly depth: number
    }
  | {
      readonly type: "StatusChanged"
      readonly agentId: string
      readonly status: AgentStatus
    }
  | {
      readonly type: "MessageQueued"
      readonly messageId: string
      readonly fromId: string
      readonly toId: string
      readonly payload: string
    }
  | {
      readonly type: "CursorAdvanced"
      readonly agentId: string
      readonly cursor: number
    }
  | {
      readonly type: "OutputWritten"
      readonly agentId: string
      readonly output: string
    }
  | {
      readonly type: "SpendRecorded"
      readonly agentId: string
      readonly amount: number
    }
  | { readonly type: "CrewStopped" }
