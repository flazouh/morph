import { Cause, Effect, Option } from "effect"
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult"
import * as Atom from "effect/unstable/reactivity/Atom"
import { useEffect } from "react"
import type { CustomSkillInput, Skill, SkillsError, SkillsStore } from "@/skills/contract"
import { useAtomRefresh, useAtomSet, useAtomValue } from "./effect-atoms"

export type SkillCommand =
  | { readonly type: "create"; readonly input: CustomSkillInput }
  | { readonly type: "update"; readonly id: string; readonly input: CustomSkillInput }
  | { readonly type: "set-enabled"; readonly id: string; readonly enabled: boolean }
  | { readonly type: "remove"; readonly id: string }

export interface SkillCommandResult {
  readonly type: SkillCommand["type"]
  readonly id: string
}

interface SkillAtoms {
  readonly library: Atom.Atom<AsyncResult.AsyncResult<ReadonlyArray<Skill>, SkillsError>>
  readonly command: Atom.AtomResultFn<SkillCommand, SkillCommandResult, SkillsError>
}

const cache = new WeakMap<SkillsStore, SkillAtoms>()

const atomsFor = (store: SkillsStore): SkillAtoms => {
  const found = cache.get(store)
  if (found !== undefined) return found

  const library = Atom.make(store.read)
  const command = Atom.fn<SkillCommand>()((action, get): Effect.Effect<SkillCommandResult, SkillsError> => {
    const refresh = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
      effect.pipe(Effect.tap(() => Effect.sync(() => get.refresh(library))))

    switch (action.type) {
      case "create":
        return refresh(store.create(action.input)).pipe(
          Effect.map((skill): SkillCommandResult => ({ type: action.type, id: skill.id }))
        )
      case "update":
        return refresh(store.update(action.id, action.input)).pipe(
          Effect.map((skill): SkillCommandResult => ({ type: action.type, id: skill.id }))
        )
      case "set-enabled":
        return refresh(store.setEnabled(action.id, action.enabled)).pipe(
          Effect.as<SkillCommandResult>({ type: action.type, id: action.id })
        )
      case "remove":
        return refresh(store.remove(action.id)).pipe(
          Effect.as<SkillCommandResult>({ type: action.type, id: action.id })
        )
    }
  })
  const made = { library, command }
  cache.set(store, made)
  return made
}

export interface SkillsState {
  readonly skills: ReadonlyArray<Skill> | null
  readonly readError: SkillsError | undefined
  readonly command: AsyncResult.AsyncResult<SkillCommandResult, SkillsError>
  readonly run: (command: SkillCommand) => void
}

/** Current skills and mutations, owned by Effect's atom registry. */
export const useSkills = (store: SkillsStore): SkillsState => {
  const atoms = atomsFor(store)
  const library = useAtomValue(atoms.library)
  const command = useAtomValue(atoms.command)
  const run = useAtomSet(atoms.command)
  const refresh = useAtomRefresh(atoms.library)

  useEffect(() => store.subscribe(refresh), [refresh, store])

  return {
    skills: AsyncResult.isSuccess(library) ? library.value : null,
    readError: AsyncResult.isFailure(library)
      ? Option.getOrUndefined(Cause.findErrorOption(library.cause))
      : undefined,
    command,
    run
  }
}
