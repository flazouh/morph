import { describe, expect, test } from "bun:test"
import { Window } from "happy-dom"
import { cssFor } from "./css"
import { detectTailwind, isGeneratedSelector, stableSelector } from "./selector"

const page = (html: string) => {
  const window = new Window()
  window.document.body.innerHTML = html
  return window.document as unknown as Document
}

const select = (document: Document, selector: string) => {
  const element = document.querySelector(selector)
  if (element === null) throw new Error(`missing fixture: ${selector}`)
  return element
}

describe("stableSelector", () => {
  test("uses body for the document body and produces preview CSS", () => {
    const document = page(`<main>Content</main>`)
    const selector = stableSelector(document.body, document)
    expect(selector).toBe("body")
    expect(cssFor({
      url: "https://example.com",
      tailwind: false,
      sources: {},
      changes: [{ selector, property: "margin", before: "8px", after: "0" }]
    })).toBe("body {\n  margin: 0 !important;\n}")
  })

  test("uses html for the document root and produces preview CSS", () => {
    const document = page(`<main>Content</main>`)
    const selector = stableSelector(document.documentElement, document)
    expect(selector).toBe("html")
    expect(cssFor({
      url: "https://example.com",
      tailwind: false,
      sources: {},
      changes: [{ selector, property: "background-color", before: "white", after: "black" }]
    })).toBe("html {\n  background-color: black !important;\n}")
  })

  test("uses a unique id", () => {
    const document = page(`<main><button id="save">Save</button></main>`)
    expect(stableSelector(select(document, "button"), document)).toBe("#save")
  })

  test("does not use a duplicate id as an anchor", () => {
    const document = page(`<main><button id="save">One</button><button id="save">Two</button></main>`)
    const element = document.querySelectorAll("button")[1]
    expect(stableSelector(element!, document)).toBe("main > button:nth-of-type(2)")
  })

  test("uses the nearest unique data-testid as an anchor", () => {
    const document = page(`<main data-testid="shell"><section data-testid="card"><span class="label">Name</span></section></main>`)
    expect(stableSelector(select(document, "span"), document)).toBe('[data-testid="card"] > span.label')
  })

  test("escapes ids, test ids, and classes without global CSS.escape", () => {
    const document = page(`<main data-testid="settings panel"><button class="sm:hover item/name">Save</button></main>`)
    const selector = stableSelector(select(document, "button"), document)
    expect(selector).toBe('[data-testid="settings\\ panel"] > button.sm\\:hover.item\\/name')
    expect(document.querySelector(selector)).toBe(select(document, "button"))
  })

  test("adds nth-of-type when class paths are duplicated", () => {
    const document = page(`<main id="app"><section class="card"><button class="action">One</button></section><section class="card"><button class="action">Two</button></section></main>`)
    const element = document.querySelectorAll("button")[1]
    expect(stableSelector(element!, document)).toBe("#app > section.card:nth-of-type(2) > button.action")
  })

  test("adds nth-of-type when a sibling has a superset of the same classes", () => {
    const document = page(`<main id="app"><section class="card featured">One</section><section class="card">Two</section></main>`)
    const element = document.querySelectorAll("section")[1]
    expect(stableSelector(element!, document)).toBe("#app > section.card:nth-of-type(2)")
  })

  test("uses nth-of-type when an element has no stable attributes", () => {
    const document = page(`<main><p>One</p><p>Two</p></main>`)
    const element = document.querySelectorAll("p")[1]
    expect(stableSelector(element!, document)).toBe("main > p:nth-of-type(2)")
  })
})

/**
 * `stableSelector` writes the selectors and `cssFor` decides which ones are safe to
 * write into a stylesheet. Both read one grammar, so every shape the writer produces
 * must survive the reader. A shape that fails here would silently drop a preview rule.
 */
describe("generated selector grammar", () => {
  interface GrammarCase {
    readonly name: string
    readonly html: string
    readonly pick: (document: Document) => Element
  }

  const cases: Array<GrammarCase> = [
    { name: "the document body", html: `<main>Content</main>`, pick: (document) => document.body },
    { name: "the document root", html: `<main>Content</main>`, pick: (document) => document.documentElement },
    { name: "a unique id", html: `<main><button id="save">Save</button></main>`, pick: (document) => select(document, "button") },
    {
      name: "a duplicate id",
      html: `<main><button id="save">One</button><button id="save">Two</button></main>`,
      pick: (document) => document.querySelectorAll("button")[1]!
    },
    {
      name: "an id that starts with a digit",
      html: `<main><button id="2fa">Save</button></main>`,
      pick: (document) => select(document, "button")
    },
    {
      name: "a data-testid anchor",
      html: `<main data-testid="shell"><section data-testid="card"><span class="label">Name</span></section></main>`,
      pick: (document) => select(document, "span")
    },
    {
      name: "escaped test ids and classes",
      html: `<main data-testid="settings panel"><button class="sm:hover item/name">Save</button></main>`,
      pick: (document) => select(document, "button")
    },
    {
      name: "a duplicated class path",
      html: `<main id="app"><section class="card"><button class="action">One</button></section><section class="card"><button class="action">Two</button></section></main>`,
      pick: (document) => document.querySelectorAll("button")[1]!
    },
    {
      name: "an element with no stable attributes",
      html: `<main><p>One</p><p>Two</p></main>`,
      pick: (document) => document.querySelectorAll("p")[1]!
    },
    {
      name: "a custom element tag",
      html: `<main><my-widget class="chart">x</my-widget></main>`,
      pick: (document) => select(document, "my-widget")
    }
  ]

  test.each(cases)("cssFor keeps the selector written for $name", ({ html, pick }: GrammarCase) => {
    const document = page(html)
    const selector = stableSelector(pick(document), document)

    expect(isGeneratedSelector(selector)).toBe(true)
    expect(cssFor({
      url: "https://example.com",
      tailwind: false,
      sources: {},
      changes: [{ selector, property: "padding", before: "8px", after: "12px" }]
    })).toBe(`${selector} {\n  padding: 12px !important;\n}`)
  })

  test("rejects a selector the writer never produces", () => {
    expect(isGeneratedSelector("button { color: red; }")).toBe(false)
    expect(isGeneratedSelector("#card, #title")).toBe(false)
  })
})

describe("detectTailwind", () => {
  test("detects two utility classes across the element and its ancestors", () => {
    const document = page(`<main class="flex"><button class="px-4 ordinary">Save</button></main>`)
    expect(detectTailwind(select(document, "button"))).toBe(true)
  })

  test("rejects one utility class", () => {
    const document = page(`<button class="px-4 ordinary named-class">Save</button>`)
    expect(detectTailwind(select(document, "button"))).toBe(false)
  })
})
