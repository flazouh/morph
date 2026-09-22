/**
 * CrewRuntime: panel-scoped orchestrator around a Crew coordinator.
 *
 * Wraps a Crew and an injected startChild callback to manage the full
 * lifecycle of spawned child agents: spawn, run, complete or fail, stop.
 * All state changes go through the Crew event log; this layer adds only the
 * async child execution and the convenience seam for the panel.
 */

import type { Crew, WaitResult } from "./coordinator"
import type { MailMessage } from "./state"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Handle returned by the injected startChild callback.
 * completion resolves with the child's output string or rejects on failure.
 * stop() signals the child to terminate cleanly.
 */
export interface ChildHandle {
  readonly completion: Promise<string>
  readonly stop: () => Promise<void>
}

/**
 * Injected callback that the caller provides to actually run a child agent.
 * CrewRuntime calls this once per spawn, immediately, without awaiting the
 * returned promise chain.
 */
export type StartChild = (
  childId: string,
  parentId: string,
  brief: string,
  title: string | undefined,
  target: string | undefined,
) => Promise<ChildHandle>

/**
 * Metadata returned synchronously from spawn().
 */
export interface SpawnedChild {
  readonly id: string
  readonly parentId: string
  readonly brief: string
  readonly title: string | undefined
  readonly target: string | undefined
}

/**
 * The panel-scoped runtime interface.
 */
export interface CrewRuntime {
  /**
   * Synchronously reserve and spawn a child agent in the crew, immediately
   * fire the child task, and return the child metadata. Multiple spawn calls
   * run concurrently; none blocks the caller.
   */
  readonly spawn: (
    parentId: string,
    brief: string,
    title?: string,
    target?: string,
  ) => SpawnedChild

  /**
   * Delegate to the crew's subscription-based awaitAgents. Does not poll.
   * Resolves when every listed agent is terminal.
   */
  readonly awaitAgents: (ids: ReadonlyArray<string>) => Promise<WaitResult>

  /**
   * Queue a message from one agent to another using an injected message id.
   * Does not trigger any auto-execution of the recipient.
   */
  readonly send: (fromId: string, toId: string, payload: string) => void

  /**
   * Return and consume all unread messages for the given agent.
   */
  readonly read: (agentId: string) => ReadonlyArray<MailMessage>

  /** Set a bot's visible lifecycle state. */
  readonly setStatus: (agentId: string, status: "working" | "waiting") => void

  readonly recordSpend: (agentId: string, usd: number) => void
  readonly totalSpend: () => number

  /**
   * Block new work via crew.stop(), then await stop() on every live handle.
   */
  readonly stop: () => Promise<void>

  /**
   * Subscribe to crew state changes. Returns an unsubscribe function.
   * Fires synchronously after each crew event, exactly like crew.subscribe().
   */
  readonly subscribe: (cb: () => void) => () => void
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export const createCrewRuntime = (
  crew: Crew,
  makeId: () => string,
  startChild: StartChild,
): CrewRuntime => {
  /**
   * Live ChildHandles keyed by agent id.
   * An entry exists from the moment startChild resolves until the child
   * completes (successfully or not). Handles not yet returned by startChild
   * are not tracked here; the crew will mark them stopped by status when
   * crew.stop() is called before startChild resolves.
   */
  const liveHandles = new Map<string, ChildHandle>()
  const starting = new Set<Promise<ChildHandle>>()

  // -------------------------------------------------------------------------
  // spawn
  // -------------------------------------------------------------------------

  const spawn = (
    parentId: string,
    brief: string,
    title?: string,
    target?: string,
  ): SpawnedChild => {
    const childId = makeId()
    // Synchronously register the agent in the crew. Throws if the crew is
    // stopped, at capacity, or the parent is terminal/unknown.
    crew.spawnAgent(childId, parentId)

    // Fire the child task without awaiting. run() catches everything so
    // there are no unhandled promise rejections.
    void run(childId, parentId, brief, title, target)

    return { id: childId, parentId, brief, title, target }
  }

  const run = async (
    childId: string,
    parentId: string,
    brief: string,
    title: string | undefined,
    target: string | undefined,
  ): Promise<void> => {
    // --- Phase 1: obtain the ChildHandle ---
    let handle: ChildHandle
    const start = startChild(childId, parentId, brief, title, target)
    starting.add(start)
    try {
      handle = await start
    } catch (err) {
      // startChild itself threw before returning a handle.
      writeFailure(childId, err)
      return
    } finally {
      starting.delete(start)
    }

    // If the crew was stopped while startChild was running, the crew already
    // set the agent to "stopped". Do not override that status.
    if (crew.state().stopped) {
      await handle.stop()
      return
    }

    liveHandles.set(childId, handle)

    // --- Phase 2: await child completion ---
    try {
      const output = await handle.completion
      liveHandles.delete(childId)
      if (!crew.state().stopped) {
        crew.writeOutput(childId, output)
        crew.setStatus(childId, "done")
      }
    } catch (err) {
      liveHandles.delete(childId)
      writeFailure(childId, err)
    }
  }

  /** Write an error output and mark the agent failed, unless crew is stopped. */
  const writeFailure = (childId: string, err: unknown): void => {
    if (crew.state().stopped) return
    const message = err instanceof Error ? err.message : String(err)
    try {
      crew.writeOutput(childId, `Error: ${message}`)
    } catch {
      // crew may have been stopped between the guard above and this call
    }
    try {
      crew.setStatus(childId, "failed")
    } catch {
      // same race guard
    }
  }

  // -------------------------------------------------------------------------
  // awaitAgents
  // -------------------------------------------------------------------------

  const awaitAgents = (ids: ReadonlyArray<string>): Promise<WaitResult> =>
    crew.awaitAgents(ids)

  // -------------------------------------------------------------------------
  // send / read
  // -------------------------------------------------------------------------

  const send = (fromId: string, toId: string, payload: string): void => {
    const messageId = makeId()
    crew.sendMessage(messageId, fromId, toId, payload)
  }

  const read = (agentId: string): ReadonlyArray<MailMessage> =>
    crew.readMailbox(agentId)

  const setStatus = (agentId: string, status: "working" | "waiting"): void => {
    const agent = crew.state().agents.get(agentId)
    if (crew.state().stopped || agent === undefined || agent.status === "done" || agent.status === "failed" || agent.status === "stopped") return
    crew.setStatus(agentId, status)
  }

  const recordSpend = (agentId: string, usd: number): void => crew.recordSpend(agentId, usd)
  const totalSpend = (): number => crew.totalSpend()

  // -------------------------------------------------------------------------
  // stop
  // -------------------------------------------------------------------------

  const stop = async (): Promise<void> => {
    // Block all future spawn / sendMessage / writeOutput calls.
    crew.stop()
    // Signal every live handle to stop, then wait for them all.
    await Promise.all([...liveHandles.values()].map((h) => h.stop()))
    await Promise.allSettled([...starting])
  }

  // -------------------------------------------------------------------------
  // subscribe
  // -------------------------------------------------------------------------

  const subscribe = (cb: () => void): (() => void) => crew.subscribe(cb)

  return { spawn, awaitAgents, send, read, setStatus, recordSpend, totalSpend, stop, subscribe }
}
