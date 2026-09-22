/**
 * Pure projection: CrewEvent[] -> CrewState.
 *
 * No side effects, no I/O, no clocks. Call project() with the full log to
 * get current state, or applyOne() to fold one event onto an existing state.
 */

import type { AgentStatus, CrewEvent } from "./events"

export interface AgentRecord {
  readonly id: string
  readonly parentId: string | null
  readonly depth: number
  readonly status: AgentStatus
  /** Set by writeOutput. Undefined until an agent writes its result. */
  readonly output: string | undefined
}

export interface MailMessage {
  readonly messageId: string
  readonly fromId: string
  readonly payload: string
}

export interface Mailbox {
  readonly messages: ReadonlyArray<MailMessage>
  /** Index of the first unread message. */
  readonly cursor: number
}

export interface CrewState {
  readonly agents: ReadonlyMap<string, AgentRecord>
  readonly mailboxes: ReadonlyMap<string, Mailbox>
  readonly spends: ReadonlyMap<string, number>
  readonly stopped: boolean
}

const TERMINAL: ReadonlySet<AgentStatus> = new Set(["done", "failed", "stopped"])

export const isTerminal = (status: AgentStatus): boolean => TERMINAL.has(status)

export const INITIAL_STATE: CrewState = {
  agents: new Map(),
  mailboxes: new Map(),
  spends: new Map(),
  stopped: false,
}

export const applyOne = (state: CrewState, event: CrewEvent): CrewState => {
  switch (event.type) {
    case "AgentSpawned": {
      const agents = new Map(state.agents)
      agents.set(event.agentId, {
        id: event.agentId,
        parentId: event.parentId,
        depth: event.depth,
        status: "working",
        output: undefined,
      })
      return { ...state, agents }
    }

    case "StatusChanged": {
      const agent = state.agents.get(event.agentId)
      if (agent === undefined) return state
      const agents = new Map(state.agents)
      agents.set(event.agentId, { ...agent, status: event.status })
      return { ...state, agents }
    }

    case "MessageQueued": {
      const mailboxes = new Map(state.mailboxes)
      const prev = mailboxes.get(event.toId) ?? { messages: [], cursor: 0 }
      mailboxes.set(event.toId, {
        ...prev,
        messages: [
          ...prev.messages,
          { messageId: event.messageId, fromId: event.fromId, payload: event.payload },
        ],
      })
      return { ...state, mailboxes }
    }

    case "CursorAdvanced": {
      const mailboxes = new Map(state.mailboxes)
      const prev = mailboxes.get(event.agentId)
      if (prev === undefined) return state
      mailboxes.set(event.agentId, { ...prev, cursor: event.cursor })
      return { ...state, mailboxes }
    }

    case "OutputWritten": {
      const agent = state.agents.get(event.agentId)
      if (agent === undefined) return state
      const agents = new Map(state.agents)
      agents.set(event.agentId, { ...agent, output: event.output })
      return { ...state, agents }
    }

    case "SpendRecorded": {
      const spends = new Map(state.spends)
      spends.set(event.agentId, (spends.get(event.agentId) ?? 0) + event.amount)
      return { ...state, spends }
    }

    case "CrewStopped": {
      if (state.stopped) return state
      const agents = new Map(state.agents)
      for (const [id, agent] of agents) {
        if (!isTerminal(agent.status)) {
          agents.set(id, { ...agent, status: "stopped" })
        }
      }
      return { ...state, agents, stopped: true }
    }
  }
}

/** Replay the full log and return current state. */
export const project = (events: ReadonlyArray<CrewEvent>): CrewState =>
  events.reduce(applyOne, INITIAL_STATE)
