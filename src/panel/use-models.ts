import { useEffect, useRef, useState } from "react"
import { modelsFor, MODELS, type CatalogModel } from "./models"
import type { Provider } from "@/session"

/**
 * How long a typed Cursor key settles before the panel asks Cursor about it.
 *
 * The key is a settings field, so it changes once per keystroke, and every change used to
 * be a request with a half-written key in it. Cursor answers those with a 401, and a
 * reader pasting a key sent one per character.
 */
const KEY_SETTLES_MS = 400

/** Live catalog for the selected provider, with each provider's stored choice included. */
export const useModels = (
  provider: Provider,
  current: string,
  cursorKey: string,
  load: () => Promise<ReadonlyArray<CatalogModel>>,
  loadCursor: (key: string) => Promise<ReadonlyArray<CatalogModel>>,
  keySettlesMs: number = KEY_SETTLES_MS
): ReadonlyArray<CatalogModel> => {
  const [catalog, setCatalog] = useState<ReadonlyArray<CatalogModel>>(provider === "openrouter" ? MODELS : [])
  const loadRef = useRef(load)
  const loadCursorRef = useRef(loadCursor)
  loadRef.current = load
  loadCursorRef.current = loadCursor
  useEffect(() => {
    let live = true
    setCatalog(provider === "openrouter" ? MODELS : [])
    const start = () => {
      const request = provider === "openrouter" ? loadRef.current() : loadCursorRef.current(cursorKey)
      void request
        .then((models) => {
          if (live) setCatalog(models)
        })
        .catch(() => {
          if (live) setCatalog(provider === "openrouter" ? MODELS : [])
        })
    }
    // OpenRouter's catalog does not depend on a field being typed, so it starts at once.
    if (provider === "openrouter") {
      start()
      return () => {
        live = false
      }
    }
    const timer = setTimeout(start, keySettlesMs)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [provider, cursorKey, keySettlesMs])
  return modelsFor(current, catalog)
}
