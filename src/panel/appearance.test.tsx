import { afterEach, expect, test } from "bun:test"
import { act, cleanup, render } from "@testing-library/react"
import { DEFAULT_SETTINGS, type Settings } from "@/session/contract"
import { applyAppearance, resolvedTheme, useAppearance } from "./appearance"

afterEach(() => {
  cleanup()
  document.documentElement.removeAttribute("data-beui-theme")
  document.documentElement.removeAttribute("data-font-size")
  restoreMatchMedia()
})

/** Drive `matchMedia("(prefers-color-scheme: dark)")` and its listeners for a test. */
const stubMatchMedia = (prefersDark: boolean) => {
  const state = { matches: prefersDark }
  const listeners = new Set<() => void>()
  const original = window.matchMedia
  window.matchMedia = ((query: string) =>
    ({
      get matches() {
        return state.matches
      },
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: (_: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
      dispatchEvent: () => false
    }) as unknown as MediaQueryList) as typeof window.matchMedia
  ;(window.matchMedia as { restore?: () => void }).restore = () => {
    window.matchMedia = original
  }
  /** Flip the OS palette and fire the change listeners the hook registered. */
  const setDark = (dark: boolean) => {
    state.matches = dark
    for (const listener of listeners) listener()
  }
  return { listeners, setDark }
}

const restoreMatchMedia = () => {
  ;(window.matchMedia as { restore?: () => void }).restore?.()
}

test("resolvedTheme follows the OS only while system is set", () => {
  expect(resolvedTheme("system", true)).toBe("dark")
  expect(resolvedTheme("system", false)).toBe("light")
  expect(resolvedTheme("light", true)).toBe("light")
  expect(resolvedTheme("dark", false)).toBe("dark")
})

test("applyAppearance writes the palette and the text scale onto the root", () => {
  const root = document.createElement("html")
  applyAppearance(root, "dark", "large", false)
  expect(root.getAttribute("data-beui-theme")).toBe("dark")
  expect(root.getAttribute("data-font-size")).toBe("large")
  applyAppearance(root, "system", "small", true)
  expect(root.getAttribute("data-beui-theme")).toBe("dark")
  expect(root.getAttribute("data-font-size")).toBe("small")
})

const Probe = ({ settings }: { settings: Settings | null }) => {
  useAppearance(settings)
  return null
}

test("the hook waits for the store before it touches the root", () => {
  stubMatchMedia(false)
  render(<Probe settings={null} />)
  expect(document.documentElement.getAttribute("data-font-size")).toBeNull()
})

test("an explicit dark theme and large size apply to the document root", () => {
  stubMatchMedia(false)
  render(<Probe settings={{ ...DEFAULT_SETTINGS, theme: "dark", fontSize: "large" }} />)
  expect(document.documentElement.getAttribute("data-beui-theme")).toBe("dark")
  expect(document.documentElement.getAttribute("data-font-size")).toBe("large")
})

test("system theme follows a later OS change and stops after unmount", () => {
  const media = stubMatchMedia(false)
  const view = render(<Probe settings={{ ...DEFAULT_SETTINGS, theme: "system" }} />)
  expect(document.documentElement.getAttribute("data-beui-theme")).toBe("light")

  // The OS flips to dark; the live listener re-applies.
  act(() => media.setDark(true))
  expect(document.documentElement.getAttribute("data-beui-theme")).toBe("dark")

  view.unmount()
  expect(media.listeners.size).toBe(0)
})

test("an explicit theme does not listen to OS changes", () => {
  const media = stubMatchMedia(false)
  render(<Probe settings={{ ...DEFAULT_SETTINGS, theme: "light" }} />)
  expect(media.listeners.size).toBe(0)
})
