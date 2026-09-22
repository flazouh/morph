import { useEffect, useState } from "react"
import type { Settings, SettingsStore } from "@/session"

/** Current settings, kept in sync with the store. `null` until the first read lands. */
export const useSettings = (store: SettingsStore): Settings | null => {
  const [current, setCurrent] = useState<Settings | null>(null)
  useEffect(() => {
    let live = true
    void store.read().then((s) => {
      if (live) setCurrent(s)
    })
    const off = store.subscribe((s) => {
      if (live) setCurrent(s)
    })
    return () => {
      live = false
      off()
    }
  }, [store])
  return current
}
