import { describe, expect, test } from "bun:test"
import { Window } from "happy-dom"
import { scanColorTokens, scanRulesForColorTokens } from "./tokens"

const page = (css: string) => {
  const window = new Window({ url: "https://app.test/" })
  window.document.head.innerHTML = `<style>${css}</style>`
  return window.document as unknown as Document
}

describe("scanColorTokens", () => {
  test("finds a root custom property that is a color", () => {
    const document = page(`:root { --brand: #ff0000; }`)
    expect(scanColorTokens(document)).toEqual([{ name: "--brand", value: "#ff0000" }])
  })

  test("finds a token nested inside a real @media rule", () => {
    const document = page(`@media (min-width: 1px) { :root { --accent: rgb(0, 218, 219); } }`)
    expect(scanColorTokens(document)).toEqual([{ name: "--accent", value: "rgb(0, 218, 219)" }])
  })

  test("ignores a custom property that is not a color", () => {
    const document = page(`:root { --gap: 10px; --brand: #ff0000; }`)
    expect(scanColorTokens(document)).toEqual([{ name: "--brand", value: "#ff0000" }])
  })

  test("resolves an alias that only references another root color to that color", () => {
    const document = page(`:root { --brand: #ff0000; --alias: var(--brand); }`)
    expect(scanColorTokens(document)).toEqual([
      { name: "--brand", value: "#ff0000" },
      { name: "--alias", value: "#ff0000" }
    ])
  })

  test("does not resolve an alias whose referenced property is not declared on :root or html", () => {
    const document = page(`.theme { --brand: #ff0000; } :root { --alias: var(--brand); }`)
    expect(scanColorTokens(document)).toEqual([])
  })

  test("keeps one entry per name, the last root-scoped declaration in document order", () => {
    // The `.theme` declaration is out of scope: only :root/html rules are scanned.
    const document = page(`:root { --brand: #ff0000; } .theme { --brand: #00ff00; }`)
    expect(scanColorTokens(document)).toEqual([{ name: "--brand", value: "#ff0000" }])
  })

  test("ignores a color custom property declared outside :root or html", () => {
    const document = page(`.card { --brand: #ff0000; }`)
    expect(scanColorTokens(document)).toEqual([])
  })

  test("scans an html rule the same as a :root rule", () => {
    const document = page(`html { --brand: #ff0000; }`)
    expect(scanColorTokens(document)).toEqual([{ name: "--brand", value: "#ff0000" }])
  })

  test("skips a stylesheet that throws reading its rules, such as a cross-origin sheet", () => {
    const document = page(`:root { --brand: #ff0000; }`)
    const hostile = {
      get cssRules(): never {
        throw new Error("cross-origin")
      }
    }
    Object.defineProperty(document, "styleSheets", {
      value: [hostile, document.styleSheets[0]],
      configurable: true
    })
    expect(scanColorTokens(document)).toEqual([{ name: "--brand", value: "#ff0000" }])
  })

  test("returns nothing when no stylesheet defines a color token", () => {
    const document = page(`.card { padding: 8px; }`)
    expect(scanColorTokens(document)).toEqual([])
  })
})

describe("scanRulesForColorTokens: generic recursion", () => {
  /**
   * happy-dom's CSS parser drops `@layer` blocks entirely (confirmed: a real
   * `@layer` stylesheet parses to zero rules), so a real browser's
   * CSSLayerBlockRule cannot be exercised through `<style>` text in this test
   * runner. The scanner walks any rule shaped like a CSS grouping rule (has
   * `cssRules`), which is exactly what `@layer`, `@media`, `@supports`, and
   * `@container` all expose, so a hand-built rule with that shape proves the
   * same recursion a real `@layer` block would take.
   */
  test("recurses into a rule shaped like an @layer block", () => {
    const layerLike = {
      cssRules: [
        {
          selectorText: ":root",
          style: {
            length: 1,
            item: (i: number) => (i === 0 ? "--brand" : undefined),
            getPropertyValue: (name: string) => (name === "--brand" ? "#ff0000" : "")
          }
        }
      ]
    }
    expect(scanRulesForColorTokens([layerLike])).toEqual([{ name: "--brand", value: "#ff0000" }])
  })

  test("recurses two levels deep, such as @layer inside @media", () => {
    const inner = {
      cssRules: [
        {
          selectorText: "html",
          style: {
            length: 1,
            item: (i: number) => (i === 0 ? "--nested" : undefined),
            getPropertyValue: (name: string) => (name === "--nested" ? "#00dadb" : "")
          }
        }
      ]
    }
    const outer = { cssRules: [inner] }
    expect(scanRulesForColorTokens([outer])).toEqual([{ name: "--nested", value: "#00dadb" }])
  })

  test("does not collect a style rule whose selector is not :root or html", () => {
    const rule = {
      selectorText: ".theme",
      style: {
        length: 1,
        item: (i: number) => (i === 0 ? "--brand" : undefined),
        getPropertyValue: (name: string) => (name === "--brand" ? "#ff0000" : "")
      }
    }
    expect(scanRulesForColorTokens([rule])).toEqual([])
  })
})
