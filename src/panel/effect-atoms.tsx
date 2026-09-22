import * as Atom from "effect/unstable/reactivity/Atom"
import * as AtomRegistry from "effect/unstable/reactivity/AtomRegistry"
import { useCallback, useEffect, useSyncExternalStore } from "react"

let registry: AtomRegistry.AtomRegistry | undefined
const activeRegistry = (): AtomRegistry.AtomRegistry => (registry ??= AtomRegistry.make())

type Store<A> = {
  readonly subscribe: (changed: () => void) => () => void
  readonly snapshot: () => A
  readonly serverSnapshot: () => A
}

const stores = new WeakMap<Atom.Atom<unknown>, Store<unknown>>()

const storeFor = <A,>(atom: Atom.Atom<A>): Store<A> => {
  const found = stores.get(atom as Atom.Atom<unknown>)
  if (found !== undefined) return found as Store<A>

  const current = activeRegistry()
  const store: Store<A> = {
    subscribe: (changed) => current.subscribe(atom, changed),
    snapshot: () => current.get(atom),
    serverSnapshot: () => Atom.getServerValue(atom, current)
  }
  stores.set(atom as Atom.Atom<unknown>, store as Store<unknown>)
  return store
}

export const useAtomValue = <A,>(atom: Atom.Atom<A>): A => {
  const store = storeFor(atom)
  return useSyncExternalStore(store.subscribe, store.snapshot, store.serverSnapshot)
}

export const useAtomSet = <R, W>(atom: Atom.Writable<R, W>): ((value: W) => void) => {
  const current = activeRegistry()
  useEffect(() => current.mount(atom), [atom, current])
  return useCallback((value: W) => current.set(atom, value), [atom, current])
}

export const useAtomRefresh = <A,>(atom: Atom.Atom<A>): (() => void) => {
  const current = activeRegistry()
  useEffect(() => current.mount(atom), [atom, current])
  return useCallback(() => current.refresh(atom), [atom, current])
}
