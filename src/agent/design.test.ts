import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { Effect, Exit } from "effect"
import { TOKEN_KEYS, TOKENS } from "../kit/tokens"
import { designCss, isDefault, parseDesign } from "./design"

const parsed = (input: unknown) => Effect.runSyncExit(parseDesign(input))
const failure = (input: unknown): string => {
  const exit = parsed(input)
  if (Exit.isSuccess(exit)) throw new Error("expected a failure")
  return String(exit.cause)
}

describe("a site's design", () => {
  test("parse keeps known tokens and CSS values, trims, and names what is wrong", () => {
    expect(Effect.runSync(parseDesign({ tokens: { "--primary": " #123 " } }))).toEqual({ tokens: { "--primary": "#123" } })
    expect(Effect.runSync(parseDesign({ tokens: { primary: "#123", "primary-foreground": "white" } }))).toEqual({ tokens: { "--primary": "#123", "--primary-foreground": "white" } })
    expect(Effect.runSync(parseDesign({ tokens: {}, dark: { "--background": "black" } }))).toEqual({ tokens: {}, dark: { "--background": "black" } })
    expect(Effect.runSync(parseDesign({}))).toEqual({ tokens: {} })
    expect(Effect.runSync(parseDesign({ tokens: { radius: "0" }, dark: {} }))).toEqual({ tokens: { "--radius": "0" } })
    expect(isDefault({ tokens: {} })).toBe(true)
    expect(isDefault({ tokens: {}, dark: { "--primary": "x" } })).toBe(false)
    expect(failure({ tokens: { "--brand-blue": "red" } })).toContain('"--brand-blue" is not a token; the tokens are background, foreground')
    expect(failure({ tokens: { "--primary": "red; } body { display: none" } })).toContain("without ; { } /* */")
    // A comment opener would swallow every rule after it in the generated sheet.
    expect(failure({ tokens: { "--primary": "red /* " } })).toContain("without ; { } /* */")
    expect(failure({ dark: { "--primary": "*/ red" } })).toContain("without ; { } /* */")
    expect(failure({ tokens: { "--primary": "" } })).toContain("needs a CSS value")
    expect(failure({ tokens: [] })).toContain("tokens must be an object")
    expect(failure({ tokens: { "--radius": "1" }, dark: 3 })).toContain("dark must be an object")
  })

  test("keys the model mangles still name their token: extra quotes, camelCase, underscores", () => {
    // Seen from Gemini Flash: the dashed key arrives wrapped in a second pair of quotes.
    expect(Effect.runSync(parseDesign({ tokens: { '"accent-foreground"': "white", primaryForeground: "black", muted_foreground: "gray", "--Card": "red", "muted foreground ": "x" } }))).toEqual({
      tokens: { "--accent-foreground": "white", "--primary-foreground": "black", "--muted-foreground": "x", "--card": "red" }
    })
    expect(failure({ tokens: { '"accentforeground"': "white" } })).toContain("not a token")
  })

  test("the CSS covers both themes for tokens and only dark for dark, and is empty for nothing", () => {
    expect(designCss({ tokens: { "--radius": "0" } })).toBe(':root,\n:root[data-beui-theme="light"],\n:root[data-beui-theme="dark"] {\n  --radius: 0;\n}\n')
    expect(designCss({ tokens: {}, dark: { "--primary": "white" } })).toBe(':root[data-beui-theme="dark"] {\n  --primary: white;\n}\n')
    expect(designCss({ tokens: {} })).toBe("")
  })

  test("TOKENS is exactly what palette.css declares", () => {
    const css = readFileSync(new URL("../styles/palette.css", import.meta.url), "utf8")
    const declared = new Set(Array.from(css.matchAll(/^\s*(--[a-z-]+):/gm), (m) => m[1] ?? ""))
    expect(new Set<string>(TOKENS)).toEqual(declared)
    expect(new Set(TOKENS).size).toBe(TOKENS.length)
    expect(TOKEN_KEYS).toEqual(TOKENS.map((t) => t.slice(2)))
  })
})
