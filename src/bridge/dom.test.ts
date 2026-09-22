import { describe, expect, test } from "bun:test"
import { Window } from "happy-dom"
import { outlineOf, readPage, readStyles, readText } from "./dom"

const page = (html: string) => {
  const window = new Window({ url: "https://github.com/acme/app/pulls" })
  window.document.body.innerHTML = html
  return { doc: window.document as unknown as Document, view: window as unknown as globalThis.Window }
}

describe("outlineOf", () => {
  test("one line per element, indented by depth, with id, classes, attributes and own text", () => {
    const { doc, view } = page(`<main id="repo" class="a b c d e"><h1 class="title">Pull requests</h1><a href="/acme/app/pull/1" role="link">Fix login</a></main>`)
    const { outline, nodes, truncated } = outlineOf(doc.body, view, 100)
    expect(nodes).toBe(4)
    expect(truncated).toBe(false)
    expect(outline.split("\n")).toEqual([
      "body",
      "  main#repo.a.b.c.d",
      '    h1.title "Pull requests"',
      '    a[role="link" href="/acme/app/pull/1"] "Fix login"'
    ])
  })

  test("skips scripts, styles, svg and hidden elements", () => {
    const { doc, view } = page(`<div><script>x()</script><style>a{}</style><svg><path d="M0"/></svg><p style="display:none">gone</p><p>kept</p></div>`)
    const { outline } = outlineOf(doc.body, view, 100)
    expect(outline).not.toContain("script")
    expect(outline).not.toContain("svg")
    expect(outline).not.toContain("gone")
    expect(outline).toContain('p "kept"')
  })

  test("stops at maxNodes and says so", () => {
    const { doc, view } = page(Array.from({ length: 50 }, (_, i) => `<p>${i}</p>`).join(""))
    const { nodes, truncated } = outlineOf(doc.body, view, 10)
    expect(nodes).toBe(10)
    expect(truncated).toBe(true)
  })

  test("long text is cut at 80 characters with an ellipsis", () => {
    const { doc, view } = page(`<p>${"x".repeat(200)}</p>`)
    const line = outlineOf(doc.body, view, 10).outline.split("\n")[1] ?? ""
    expect(line.length).toBeLessThan(90)
    expect(line.endsWith('…"')).toBe(true)
  })
})

describe("readPage", () => {
  test("carries url, title, viewport and the outline of the selected region", () => {
    const { doc, view } = page(`<nav>chrome</nav><main><h1>Hello</h1></main>`)
    doc.title = "Pulls"
    const result = readPage(doc, view, "main", 100)
    expect(result.url).toBe("https://github.com/acme/app/pulls")
    expect(result.title).toBe("Pulls")
    expect(result.outline).toBe('main\n  h1 "Hello"')
    expect(result.outline).not.toContain("chrome")
  })

  test("a selector that matches nothing is an error, not an empty outline", () => {
    const { doc, view } = page(`<p>x</p>`)
    expect(() => readPage(doc, view, "#nope", 10)).toThrow('nothing matches "#nope"')
  })
})

describe("readStyles and readText", () => {
  test("styles come with a selector path and a bounding box, capped by limit", () => {
    const { doc, view } = page(`<ul id="list"><li class="row one">a</li><li class="row">b</li><li class="row">c</li></ul>`)
    const nodes = readStyles(doc, view, "li", 2)
    expect(nodes).toHaveLength(2)
    expect(nodes[0]?.selector).toBe("#list > li.row.one")
    expect(Object.keys(nodes[0]?.styles ?? {})).toContain("background-color")
    expect(nodes[0]?.rect).toEqual({ x: 0, y: 0, width: 0, height: 0 })
  })

  test("text returns full content, capped by limit", () => {
    const { doc } = page(`<p>one</p><p>two</p><p>three</p>`)
    expect(readText(doc, "p", 2)).toEqual(["one", "two"])
  })
})
