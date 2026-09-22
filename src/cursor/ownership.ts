/**
 * Which run of a Cursor thread this extension owns, and what owning one means.
 *
 * A send makes a run at Cursor and Morph reads its stream. Three things follow that run
 * and must never disagree: the tool gate the cloud agent calls back through, the
 * heartbeat that keeps the service worker alive, and the Stop target. Kept apart, they
 * drift the moment two runs overlap, and they do overlap: Cursor can settle one run and
 * accept the next before Morph has read the first one's terminal event.
 *
 * So ownership is one table, keyed by turn, and one flag inside it. A turn holds all of
 * what owning means or none of it. At most one turn holds the gate, which is what gives
 * Stop and the heartbeat a single answer, and the turn it took over from keeps reading
 * until its own last step is written.
 */
import { Effect, Fiber, Ref, Semaphore } from "effect"
import type { ActiveRun } from "./state"

/** Everything one turn's run needs, and everything ending it needs, in one value. */
export interface OwnedRun {
  readonly turn: number
  readonly run: ActiveRun
  /** Ends Morph's read of the stream. Cancelling the run at Cursor is a separate call. */
  readonly reader: AbortController
  /** The fiber doing that read. Absent for the moment between the fork and the record. */
  readonly fiber: Fiber.Fiber<void> | undefined
  /**
   * True until the terminal event gives the tool gate back.
   *
   * A turn outlives its run: the usage read that follows the terminal event belongs to
   * the same fiber and the same abort. The gate has to go at the terminal event, so the
   * next send starts clean, but the record stays until the fiber is finished, so Stop and
   * scope close still have something to end.
   */
  readonly holdsGate: boolean
}

/** What a turn gets for owning its run: its number, and the way to end its read. */
export interface Claimed {
  readonly turn: number
  readonly reader: AbortController
}

/** What the table needs from the relay: the tool gate, opened and closed. */
export interface RunGate {
  readonly openRun: () => Effect.Effect<void>
  readonly closeRun: () => Effect.Effect<void>
}

export interface RunOwnership {
  /**
   * Numbers this turn and gives it the gate, the heartbeat, and the Stop target.
   *
   * The turn this one takes over from keeps its read. Cursor accepted a second run, so
   * the first already settled on its side and its stream has a terminal event on the way;
   * that turn still has to see it to write its own last step. It loses the gate here, and
   * stays in the table until its fiber is finished, so scope close still has something
   * to end.
   */
  readonly claim: (run: ActiveRun) => Effect.Effect<Claimed>
  /** The same, for a turn that opened the gate itself before Cursor gave it a run id. */
  readonly claimHoldingGate: (run: ActiveRun) => Effect.Effect<Claimed>
  /** Records the fiber reading the run, for as long as that turn is in the table. */
  readonly attachReader: (turn: number, fiber: Fiber.Fiber<void>) => Effect.Effect<void>
  /**
   * Gives the tool gate back, for the turn that still holds it and for no other turn.
   * Answers whether this turn was the holder, so only it settles the run's last state.
   */
  readonly releaseGate: (turn: number) => Effect.Effect<boolean>
  /** Forgets the turn once its fiber is finished, so nothing waits on a run that ended. */
  readonly finish: (turn: number) => Effect.Effect<void>
  /** The turn a Stop belongs to: the one run of this session that Cursor still holds. */
  readonly holder: Effect.Effect<OwnedRun | undefined>
  /**
   * Ends every read this session still owns, and waits for each turn to settle its state.
   *
   * A turn the next one took over from is still in here. Scope close has to end that read
   * too, or a stream outlives the thread that asked for it.
   */
  readonly endReads: Effect.Effect<void>
}

export const makeRunOwnership = (gate: RunGate): Effect.Effect<RunOwnership> =>
  Effect.gen(function* () {
    const runs = yield* Ref.make<ReadonlyMap<number, OwnedRun>>(new Map())
    const turns = yield* Ref.make(0)
    /**
     * The run changes hands under this lock. Two atomic writes are not one atomic
     * handover: without it a turn could win the release and then close a tool gate that
     * the turn after it opened in between. It is held for a few reference writes only,
     * never for a request.
     */
    const handover = yield* Semaphore.make(1)

    const take = (run: ActiveRun, open: boolean) =>
      handover.withPermits(1)(
        Effect.gen(function* () {
          const turn = yield* Ref.updateAndGet(turns, (count) => count + 1)
          const reader = new AbortController()
          yield* Ref.update(runs, (current) => {
            const next = new Map<number, OwnedRun>()
            for (const [key, entry] of current) next.set(key, { ...entry, holdsGate: false })
            next.set(turn, { turn, run, reader, fiber: undefined, holdsGate: true })
            return next
          })
          if (open) yield* gate.openRun()
          return { turn, reader }
        })
      )

    const claim = Effect.fn("RunOwnership.claim")((run: ActiveRun) => take(run, true))
    const claimHoldingGate = Effect.fn("RunOwnership.claimHoldingGate")((run: ActiveRun) =>
      take(run, false)
    )

    const attachReader = (turn: number, fiber: Fiber.Fiber<void>) =>
      Ref.update(runs, (current) => {
        const entry = current.get(turn)
        if (entry === undefined) return current
        return new Map(current).set(turn, { ...entry, fiber })
      })

    const releaseGate = Effect.fn("RunOwnership.releaseGate")(function* (turn: number) {
      return yield* handover.withPermits(1)(
        Effect.gen(function* () {
          const mine = yield* Ref.modify(runs, (current) => {
            const entry = current.get(turn)
            if (entry === undefined || !entry.holdsGate) return [false, current] as const
            return [true, new Map(current).set(turn, { ...entry, holdsGate: false })] as const
          })
          if (mine) yield* gate.closeRun()
          return mine
        })
      )
    })

    const finish = (turn: number) =>
      Ref.update(runs, (current) => {
        if (!current.has(turn)) return current
        const next = new Map(current)
        next.delete(turn)
        return next
      })

    const holder = Effect.map(Ref.get(runs), (current) => {
      for (const entry of current.values()) if (entry.holdsGate) return entry
      return undefined
    })

    const endReads = Effect.gen(function* () {
      const current = yield* Ref.get(runs)
      // Ending the read, rather than interrupting the fiber, lets each turn settle itself.
      for (const entry of current.values()) entry.reader.abort()
      for (const entry of current.values()) {
        if (entry.fiber !== undefined) yield* Effect.asVoid(Fiber.await(entry.fiber))
      }
    })

    return { claim, claimHoldingGate, attachReader, releaseGate, finish, holder, endReads }
  })
