import { describe, expect, test } from "bun:test"
import { pageSourceOf } from "./page-package"

const design = { tokens: { "--primary": "red" } } as const
const DESIGN_CSS = ':root,\n:root[data-beui-theme="light"],\n:root[data-beui-theme="dark"] {\n  --primary: red;\n}\n'

describe("pageSourceOf, on one page", () => {
  test("nothing applied is nothing to publish", () => {
    expect(pageSourceOf({}, undefined)).toBeUndefined()
    expect(pageSourceOf({ "/": {} }, design)).toBeUndefined()
  })

  test("a skin becomes a page.tsx package with the page's stylesheet and the site's design", () => {
    const built = pageSourceOf(
      { "/": { css: "body{}", skin: { "page.tsx": "export default () => null", "data.ts": "export const x = 1" } } },
      design
    )
    expect(built?.paths).toEqual(["/"])
    expect(built?.source).toEqual({
      entry: "page.tsx",
      style: "style.css",
      files: {
        "style.css": "body{}",
        "design.css": DESIGN_CSS,
        "page.tsx": "export default () => null",
        "data.ts": "export const x = 1"
      }
    })
  })

  test("a default design and no css leave an empty stylesheet and no design file", () => {
    const built = pageSourceOf({ "/": { script: "1" } }, { tokens: {} })
    expect(built?.source).toEqual({ entry: "page.js", style: "style.css", files: { "style.css": "", "page.js": "1" } })
  })

  test("a skin and a persisted script publish together: the skin is the entry, the script is page.js", () => {
    const built = pageSourceOf({ "/": { skin: { "page.tsx": "export default () => null" }, script: "document.title = 'x'" } }, undefined)
    expect(built?.source).toEqual({
      entry: "page.tsx",
      style: "style.css",
      files: { "style.css": "", "page.tsx": "export default () => null", "page.js": "document.title = 'x'" }
    })
  })

  test("css alone is a stylesheet package", () => {
    expect(pageSourceOf({ "/": { css: "a{}" } }, undefined)?.source).toEqual({
      entry: "style.css",
      style: "style.css",
      files: { "style.css": "a{}" }
    })
  })

  test("a skin file named like a package stylesheet is refused", () => {
    expect(() => pageSourceOf({ "/": { skin: { "page.tsx": "", "style.css": "" } } }, undefined)).toThrow("style.css")
  })

  test("a skin without an entry is refused", () => {
    expect(() => pageSourceOf({ "/": { skin: { "a.tsx": "", "b.tsx": "" } } }, undefined)).toThrow("page.tsx")
  })

  test("a page that wears nothing is not a path of the package", () => {
    const built = pageSourceOf({ "/tiers": {}, "/login": { css: "a{}" } }, undefined)
    expect(built?.paths).toEqual(["/login"])
    expect(built?.source.files).toEqual({ "style.css": "a{}" })
  })
})

describe("pageSourceOf, on several pages", () => {
  const two = {
    "/login": { skin: { "page.tsx": "export default () => 'login'", "components/Card.tsx": "export const Card = () => null" } },
    "/": { skin: { "page.tsx": "export default () => 'home'" } }
  }

  test("every page the thread skinned is a path of one package", () => {
    const built = pageSourceOf(two, design)
    expect(built?.paths).toEqual(["/", "/login"])
  })

  test("each page keeps its own files, under its own folder", () => {
    const files = pageSourceOf(two, design)?.source.files ?? {}
    expect(files["pages/index/page.tsx"]).toBe("export default () => 'home'")
    expect(files["pages/login/page.tsx"]).toBe("export default () => 'login'")
    expect(files["pages/login/components/Card.tsx"]).toBe("export const Card = () => null")
    expect(files["page.tsx"]).toBeDefined()
  })

  test("the generated entry picks the page by pathname", () => {
    const entry = pageSourceOf(two, design)?.source.files["page.tsx"] ?? ""
    expect(entry).toContain('"/"')
    expect(entry).toContain('"/login"')
    expect(entry).toContain("./pages/index/page")
    expect(entry).toContain("./pages/login/page")
    expect(entry).toContain("location.pathname")
  })

  test("the shared stylesheet carries the design, and nothing page-specific", () => {
    const files = pageSourceOf({ ...two, "/": { ...two["/"], css: "body{margin:0}" } }, design)?.source.files ?? {}
    expect(files["design.css"]).toBe(DESIGN_CSS)
    expect(files["style.css"]).toBe("")
    expect(files["page.js"]).toContain("body{margin:0}")
    expect(files["page.js"]).toContain('"/"')
  })

  test("a persisted script runs only on the page it was applied to", () => {
    const files = pageSourceOf({ "/": { script: "home()" }, "/login": { script: "login()" } }, undefined)?.source.files ?? {}
    expect(files["page.js"]).toContain("home()")
    expect(files["page.js"]).toContain("login()")
    expect(files["page.js"]).toContain('location.pathname === "/login"')
    expect(pageSourceOf({ "/": { script: "home()" }, "/login": { script: "login()" } }, undefined)?.source.entry).toBe("page.js")
  })

  test("a page whose skin entry is skin.tsx is imported by that name", () => {
    const files = pageSourceOf(
      { "/": { skin: { "page.tsx": "export default () => null" } }, "/login": { skin: { "skin.tsx": "export default () => null" } } },
      undefined
    )?.source.files ?? {}
    expect(files["pages/login/skin.tsx"]).toBeDefined()
    expect(files["page.tsx"]).toContain("./pages/login/skin")
    expect(files["page.tsx"]).not.toContain("./pages/login/page")
  })

  test("two paths with the same folder name still get one folder each", () => {
    const built = pageSourceOf(
      { "/a/b": { skin: { "page.tsx": "ab" } }, "/a-b": { skin: { "page.tsx": "a-b" } } },
      undefined
    )
    const files = built?.source.files ?? {}
    const folders = Object.keys(files).filter((path) => path.startsWith("pages/"))
    expect(new Set(folders).size).toBe(folders.length)
    expect(folders.length).toBe(2)
  })
})
