import { afterEach, describe, expect, test } from "bun:test"
import { FONT_FACES, loadFonts } from "./fonts"

/**
 * The faces the kit adds to a page, against a stand-in FontFace: happy-dom has none, and
 * the real one needs a renderer. What matters is what the page's font set receives.
 */

interface Made {
  readonly family: string
  readonly source: string
  readonly descriptors: Record<string, string> | undefined
}

const original = (globalThis as { FontFace?: unknown }).FontFace
afterEach(() => {
  ;(globalThis as { FontFace?: unknown }).FontFace = original
})

const withFontFace = (): Array<Made> => {
  const made: Array<Made> = []
  ;(globalThis as { FontFace?: unknown }).FontFace = class {
    constructor(family: string, source: string, descriptors?: Record<string, string>) {
      made.push({ family, source, descriptors })
    }
  }
  return made
}

describe("loadFonts", () => {
  test("adds Geist and Geist Mono to the document's fonts from the extension's files, variable weight, one face per range", () => {
    const made = withFontFace()
    const added: Array<unknown> = []
    loadFonts({ fonts: { add: (f: unknown) => added.push(f) } as unknown as FontFaceSet }, "chrome-extension://abc/fonts/")
    expect(added).toHaveLength(FONT_FACES.length)
    expect(made.map((m) => m.family)).toEqual(["Geist Variable", "Geist Variable", "Geist Mono Variable"])
    expect(made[0]?.source).toBe("url(chrome-extension://abc/fonts/geist-latin-wght-normal.woff2)")
    expect(made[0]?.descriptors?.["weight"]).toBe("100 900")
    expect(made[0]?.descriptors?.["unicodeRange"]).toStartWith("U+0000-00FF")
    expect(made[1]?.descriptors?.["unicodeRange"]).toStartWith("U+0100-02BA")
    expect(made[2]?.source).toContain("geist-mono-latin-wght-normal.woff2")
  })

  test("without FontFace in the window, nothing is added and nothing throws", () => {
    ;(globalThis as { FontFace?: unknown }).FontFace = undefined
    const added: Array<unknown> = []
    loadFonts({ fonts: { add: (f: unknown) => added.push(f) } as unknown as FontFaceSet }, "x/")
    expect(added).toEqual([])
  })
})
