/**
 * Crew coordinator: the mutable runtime that wraps the append-only log.
 *
 * All state lives in the event log. The coordinator validates preconditions,
 * appends events, and notifies subscribers. It never touches clocks or
 * external IDs; callers supply those when they matter for display.
 */

import { MAX_AGENTS, MAX_DEPTH, type AgentStatus, type CrewEvent } from "./events"
import { applyOne, INITIAL_STATE, isTerminal, type AgentRecord, type CrewState, type MailMessage } from "./state"

export class CrewError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CrewError"
  }
}

export interface WaitResult {
  /** True only when every selected agent is in a terminal status. */
  readonly ready: boolean
  /**
   * Populated only when ready is true. Maps each requested agent ID to its
   * output string (undefined when the agent never wrote output).
   */
  readonly outputs: ReadonlyMap<string, string | undefined>
}

export interface Crew {
  /**
   * Spawn a new agent. parentId null makes a root agent. Throws when:
   * - crew is stopped
   * - agentId is already in use
   * - total live agents would exceed MAX_AGENTS
   * - depth would exceed MAX_DEPTH
   * - parent does not exist or is terminal
   */
  readonly spawnAgent: (agentId: string, parentId: string | null) => void

  /**
   * Transition an agent to a new status. Throws when the agent does not exist.
   * Callers are responsible for valid status transitions.
   */
  readonly setStatus: (agentId: string, status: AgentStatus) => void

  /**
   * Queue a message from one agent to another. Does not trigger any
   * auto-execution of the recipient. Throws when:
   * - crew is stopped
   * - sender or recipient does not exist
   */
  readonly sendMessage: (messageId: string, fromId: string, toId: string, payload: string) => void

  /**
   * Return all unread messages for agentId and advance the read cursor.
   * Returns an empty array for an unknown agent.
   */
  readonly readMailbox: (agentId: string) => ReadonlyArray<MailMessage>

  /**
   * Inspect selected agents. Returns ready=true only when every listed agent
   * is terminal; outputs are populated only in that case.
   * An empty selection is immediately ready with no outputs.
   */
  readonly waitFor: (agentIds: ReadonlyArray<string>) => WaitResult

  /** Resolve when every selected agent is terminal, without polling or model turns. */
  readonly awaitAgents: (agentIds: ReadonlyArray<string>) => Promise<WaitResult>

  /**
   * Write the terminal output for an agent. Throws when:
   * - crew is stopped
   * - agent does not exist
   */
  readonly writeOutput: (agentId: string, output: string) => void

  /**
   * Stop the crew. Marks every non-terminal agent stopped, then blocks all
   * future spawn / sendMessage / writeOutput calls. Idempotent.
   */
  readonly stop: () => void

  /**
   * Record numeric spend for an agent. Throws when the agent does not exist.
   * Spend is additive: multiple records accumulate per agent.
   */
  readonly recordSpend: (agentId: string, amount: number) => void

  /** Total spend across all agents in the crew. */
  readonly totalSpend: () => number

  /** Spend for one agent. Returns 0 for agents with no records yet. */
  readonly agentSpend: (agentId: string) => number

  /** Current projected state. Cheap: result is cached between events. */
  readonly state: () => CrewState

  /** Full event log snapshot. */
  readonly events: () => ReadonlyArray<CrewEvent>

  /**
   * Register a change callback. Fires synchronously after every event append.
   * Returns an unsubscribe function.
   */
  readonly subscribe: (cb: () => void) => () => void
}

export const createCrew = (): Crew => {
  const log: Array<CrewEvent> = []
  const messageIds = new Set<string>()
  const subscribers = new Set<() => void>()
  let cache: CrewState = INITIAL_STATE

  const emit = (event: CrewEvent): void => {
    log.push(event)
    cache = applyOne(cache, event)
    for (const cb of subscribers) cb()
  }

  const current = (): CrewState => cache

  const spawnAgent = (agentId: string, parentId: string | null): void => {
    const state = current()
    if (state.stopped) throw new CrewError("crew is stopped")
    if (state.agents.has(agentId)) throw new CrewError(`agent "${agentId}" already exists`)
    const active = [...state.agents.values()].filter((agent) => !isTerminal(agent.status)).length
    if (active >= MAX_AGENTS) {
      throw new CrewError(`cannot spawn: crew is at the maximum of ${MAX_AGENTS} agents`)
    }

    let depth = 0
    if (parentId !== null) {
      const parent = state.agents.get(parentId)
      if (parent === undefined) throw new CrewError(`parent "${parentId}" not found`)
      if (isTerminal(parent.status)) throw new CrewError(`parent "${parentId}" is terminal`)
      depth = parent.depth + 1
      if (depth > MAX_DEPTH) {
        throw new CrewError(`cannot spawn: depth ${depth} exceeds maximum of ${MAX_DEPTH}`)
      }
    }

    emit({ type: "AgentSpawned", agentId, parentId, depth })
  }

  const setStatus = (agentId: string, status: AgentStatus): void => {
    if (!current().agents.has(agentId)) throw new CrewError(`agent "${agentId}" not found`)
    emit({ type: "StatusChanged", agentId, status })
  }

  const sendMessage = (messageId: string, fromId: string, toId: string, payload: string): void => {
    const state = current()
    if (state.stopped) throw new CrewError("crew is stopped")
    if (!state.agents.has(fromId)) throw new CrewError(`sender "${fromId}" not found`)
    if (!state.agents.has(toId)) throw new CrewError(`recipient "${toId}" not found`)
    if (messageIds.has(messageId)) throw new CrewError(`message "${messageId}" already exists`)
    messageIds.add(messageId)
    emit({ type: "MessageQueued", messageId, fromId, toId, payload })
  }

  const readMailbox = (agentId: string): ReadonlyArray<MailMessage> => {
    const state = current()
    const mailbox = state.mailboxes.get(agentId)
    if (mailbox === undefined || mailbox.cursor >= mailbox.messages.length) return []
    const unread = mailbox.messages.slice(mailbox.cursor)
    emit({ type: "CursorAdvanced", agentId, cursor: mailbox.messages.length })
    return unread
  }

  const waitFor = (agentIds: ReadonlyArray<string>): WaitResult => {
    const state = current()
    const outputs = new Map<string, string | undefined>()
    for (const id of agentIds) {
      const agent = state.agents.get(id)
      if (agent === undefined || !isTerminal(agent.status)) {
        return { ready: false, outputs: new Map() }
      }
      outputs.set(id, agent.output)
    }
    return { ready: true, outputs }
  }

  const awaitAgents = (agentIds: ReadonlyArray<string>): Promise<WaitResult> => {
    const missing = agentIds.find((id) => !current().agents.has(id))
    if (missing !== undefined) return Promise.reject(new CrewError(`agent "${missing}" not found`))
    const immediate = waitFor(agentIds)
    if (immediate.ready) return Promise.resolve(immediate)
    return new Promise((resolve) => {
      const unsubscribe = subscribe(() => {
        const result = waitFor(agentIds)
        if (!result.ready) return
        unsubscribe()
        resolve(result)
      })
    })
  }

  const writeOutput = (agentId: string, output: string): void => {
    const state = current()
    if (state.stopped) throw new CrewError("crew is stopped")
    if (!state.agents.has(agentId)) throw new CrewError(`agent "${agentId}" not found`)
    emit({ type: "OutputWritten", agentId, output })
  }

  const stop = (): void => {
    if (!current().stopped) emit({ type: "CrewStopped" })
  }

  const recordSpend = (agentId: string, amount: number): void => {
    if (!current().agents.has(agentId)) throw new CrewError(`agent "${agentId}" not found`)
    emit({ type: "SpendRecorded", agentId, amount })
  }

  const totalSpend = (): number => {
    let total = 0
    for (const amount of current().spends.values()) total += amount
    return total
  }

  const agentSpend = (agentId: string): number => current().spends.get(agentId) ?? 0

  const subscribe = (cb: () => void): (() => void) => {
    subscribers.add(cb)
    return () => { subscribers.delete(cb) }
  }

  return {
    spawnAgent,
    setStatus,
    sendMessage,
    readMailbox,
    waitFor,
    awaitAgents,
    writeOutput,
    stop,
    recordSpend,
    totalSpend,
    agentSpend,
    state: current,
    events: () => [...log],
    subscribe,
  }
}
