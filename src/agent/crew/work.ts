/**
 * Parallel-agent work coordination.
 *
 * Claims let agents own a capability — css (scoped to a selector), script,
 * or design — while preventing overlapping writes. CSS fragments
 * compose in claim order into one stylesheet string. The write queue
 * serialises all page writes and isolates failures.
 */

import { Effect, Semaphore } from "effect"
import type { Crew } from "./coordinator"
import { isTerminal } from "./state"
import { appliedOf, type Applied, type Script } from "../applied"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type Capability = "css" | "script" | "design"

/** Globally exclusive capabilities: only one agent may hold each at a time. */
const EXCLUSIVE: ReadonlySet<Capability> = new Set(["script", "design"])

/** CSS selectors that conflict with every other CSS selector. */
const UNIVERSAL_CSS: ReadonlySet<string> = new Set([":root", "body", "*"])

export interface Claim {
  readonly agentId: string
  readonly capability: Capability
  /** Present only for css claims. */
  readonly selector?: string
  /** Monotonically increasing insertion counter. Lower means claimed earlier. */
  readonly order: number
}

export class WorkError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "WorkError"
  }
}

// ---------------------------------------------------------------------------
// Internal storage
// ---------------------------------------------------------------------------

type StoredClaim = Claim

interface CssArtifact {
  readonly agentId: string
  readonly selector: string
  readonly order: number
  readonly content: string
}

interface ScriptArtifact {
  readonly agentId: string
  readonly order: number
  readonly script: Script
}

// ---------------------------------------------------------------------------
// Selector conflict helpers
// ---------------------------------------------------------------------------

const normalise = (sel: string): string => sel.trim().replace(/\s+/g, " ")

/**
 * True when CSS selectors A and B conflict.
 *
 * Conflicts are:
 * - Either selector is a universal selector (body, :root, *).
 * - The normalised strings are equal.
 * - One is a conservative prefix of the other (A is ".foo" and B is ".foo .bar").
 */
const cssConflicts = (a: string, b: string): boolean => {
  const na = normalise(a)
  const nb = normalise(b)
  if (UNIVERSAL_CSS.has(na) || UNIVERSAL_CSS.has(nb)) return true
  if (na === nb) return true
  if (nb.startsWith(na + " ") || na.startsWith(nb + " ")) return true
  return false
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface Work {
  /**
   * Claim a capability for an agent.
   *
   * - css requires a selector; others must omit it.
   * Throws WorkError when:
   * - crew is stopped
   * - agent is unknown or terminal
   * - claim overlaps with an existing claim
   * - agent already holds this exact claim
   */
  readonly claim: (agentId: string, capability: Capability, selector?: string) => void

  /**
   * Release a claim. A noop when the claim does not exist.
   * Releasing removes the agent's CSS fragment from the composed output.
   */
  readonly release: (agentId: string, capability: Capability, selector?: string) => void

  /**
   * Replace the CSS content for an existing css+selector claim.
   * Throws WorkError when the agent has no such claim.
   */
  readonly writeCss: (agentId: string, selector: string, css: string | undefined) => void

  /** Current content for one CSS claim, used to roll back a failed page write. */
  readonly css: (agentId: string, selector: string) => string | undefined

  /** Remove older released fragments that this successful write replaced. */
  readonly settleCss: (agentId: string, selector: string) => void

  /**
   * Replace the script for the agent that holds the script claim.
   * Throws WorkError when the agent has no script claim.
   */
  readonly writeScript: (agentId: string, script: Script | undefined) => void

  /** Current script for the exclusive holder, used to roll back a failed page write. */
  readonly script: (agentId: string) => Script | undefined

  /** Remove older released scripts after this script reached the page. */
  readonly settleScript: (agentId: string) => void

  /** Current claims in claim order. */
  readonly claims: () => ReadonlyArray<Claim>

  /**
   * The composed Applied state.
   *
   * CSS: all fragments joined in claim order, each wrapped in agent
   * boundary comments. Script: the active script-holder's script, or
   * absent when no agent holds the script claim or none has been written.
   */
  readonly composed: () => Applied

  /** Run one page operation at a time in the calling Effect fiber. */
  readonly serialize: <A, E, R>(
    effect: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E | WorkError, R>
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export const createWork = (crew: Crew): Work => {
  const stored = new Map<string, StoredClaim>()
  const cssArtifacts = new Map<string, CssArtifact>()
  const scriptArtifacts = new Map<string, ScriptArtifact>()
  let counter = 0
  const semaphore = Semaphore.makeUnsafe(1)

  /** Stable map key that encodes agent, capability, and optional selector. */
  const claimKey = (agentId: string, capability: Capability, selector?: string): string =>
    selector !== undefined
      ? `${agentId}\x00${capability}\x00${selector}`
      : `${agentId}\x00${capability}`

  /** Claims sorted by insertion order. */
  const sortedClaims = (): StoredClaim[] =>
    [...stored.values()].sort((a, b) => a.order - b.order)

  // When the crew stops, all claims are invalidated.
  crew.subscribe(() => {
    if (crew.state().stopped) {
      stored.clear()
      cssArtifacts.clear()
      scriptArtifacts.clear()
      return
    }
    for (const [key, claim] of stored) {
      const agent = crew.state().agents.get(claim.agentId)
      if (agent !== undefined && isTerminal(agent.status)) stored.delete(key)
    }
  })

  // -------------------------------------------------------------------------
  // claim
  // -------------------------------------------------------------------------

  const claim = (agentId: string, capability: Capability, selector?: string): void => {
    const state = crew.state()
    if (state.stopped) throw new WorkError("crew is stopped")

    const agent = state.agents.get(agentId)
    if (agent === undefined) throw new WorkError(`agent "${agentId}" not found`)
    if (isTerminal(agent.status)) throw new WorkError(`agent "${agentId}" is terminal`)

    if (capability === "css") {
      if (selector === undefined) throw new WorkError("css claim requires a selector")
    } else if (selector !== undefined) {
      throw new WorkError(`${capability} claim does not accept a selector`)
    }

    const k = claimKey(agentId, capability, selector)
    if (stored.has(k)) throw new WorkError(`agent "${agentId}" already holds this claim`)

    // Globally exclusive capabilities allow only one holder.
    if (EXCLUSIVE.has(capability)) {
      for (const c of stored.values()) {
        if (c.capability === capability) {
          throw new WorkError(
            `capability "${capability}" is already claimed by agent "${c.agentId}"`,
          )
        }
      }
    }

    // CSS selector conflict check.
    if (capability === "css" && selector !== undefined) {
      for (const c of stored.values()) {
        if (c.capability === "css" && c.selector !== undefined) {
          if (cssConflicts(selector, c.selector)) {
            throw new WorkError(
              `css selector "${selector}" conflicts with "${c.selector}" held by agent "${c.agentId}"`,
            )
          }
        }
      }
    }

    stored.set(k, { agentId, capability, selector, order: counter++ })
  }

  // -------------------------------------------------------------------------
  // release
  // -------------------------------------------------------------------------

  const release = (agentId: string, capability: Capability, selector?: string): void => {
    stored.delete(claimKey(agentId, capability, selector))
  }

  // -------------------------------------------------------------------------
  // writeCss / writeScript
  // -------------------------------------------------------------------------

  const writeCss = (agentId: string, selector: string, css: string | undefined): void => {
    const k = claimKey(agentId, "css", selector)
    const c = stored.get(k)
    if (c === undefined) {
      throw new WorkError(`agent "${agentId}" has no css claim for "${selector}"`)
    }
    if (css === undefined) cssArtifacts.delete(k)
    else cssArtifacts.set(k, { agentId, selector, order: c.order, content: css })
  }

  const css = (agentId: string, selector: string): string | undefined =>
    cssArtifacts.get(claimKey(agentId, "css", selector))?.content

  const settleCss = (agentId: string, selector: string): void => {
    const current = claimKey(agentId, "css", selector)
    for (const [key, artifact] of cssArtifacts) {
      if (key !== current && normalise(selector) === normalise(artifact.selector)) cssArtifacts.delete(key)
    }
  }

  const writeScript = (agentId: string, script: Script | undefined): void => {
    const k = claimKey(agentId, "script")
    const c = stored.get(k)
    if (c === undefined) {
      throw new WorkError(`agent "${agentId}" has no script claim`)
    }
    if (script === undefined) scriptArtifacts.delete(k)
    else scriptArtifacts.set(k, { agentId, order: c.order, script })
  }

  const script = (agentId: string): Script | undefined =>
    scriptArtifacts.get(claimKey(agentId, "script"))?.script

  const settleScript = (agentId: string): void => {
    const current = claimKey(agentId, "script")
    for (const key of scriptArtifacts.keys()) {
      if (key !== current) scriptArtifacts.delete(key)
    }
  }

  // -------------------------------------------------------------------------
  // composed
  // -------------------------------------------------------------------------

  const composed = (): Applied => {
    const cssParts: string[] = []
    const fragments = [...cssArtifacts.values()].sort((a, b) => a.order - b.order)
    for (const fragment of fragments) {
      cssParts.push(`/* agent:${fragment.agentId} */\n${fragment.content}\n/* /agent:${fragment.agentId} */`)
    }

    const scriptArtifact = [...scriptArtifacts.values()].sort((a, b) => b.order - a.order)[0]

    const css = cssParts.length > 0 ? { css: cssParts.join("\n") } : {}
    return scriptArtifact === undefined ? css : { ...css, ...appliedOf(scriptArtifact.script) }
  }

  // -------------------------------------------------------------------------
  // serialize
  // -------------------------------------------------------------------------

  const serialize = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | WorkError, R> =>
    semaphore.withPermit(
      Effect.suspend<A, E | WorkError, R>(() =>
        crew.state().stopped
          ? Effect.fail(new WorkError("crew is stopped"))
          : effect
      )
    )

  // -------------------------------------------------------------------------
  // claims
  // -------------------------------------------------------------------------

  const claims = (): ReadonlyArray<Claim> =>
    sortedClaims().map(({ agentId, capability, selector, order }) => ({
      agentId,
      capability,
      selector,
      order,
    }))

  return {
    claim,
    release,
    writeCss,
    css,
    settleCss,
    writeScript,
    script,
    settleScript,
    claims,
    composed,
    serialize
  }
}
