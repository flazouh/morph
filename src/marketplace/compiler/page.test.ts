import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { skinScript } from "../../kit/skin-script"
import { compileSkin, extrasOf, type Sheets } from "../../skin/compile"
import { packIconSet, unpackIconSet } from "../../skin/icon-codec"
import type { IconSet } from "../../compiler/icons"
import { PackageCompileError } from "./error"
import { checkPageSource, compilePagePackage, PAGE_COMPILER, skinFilesOf, type PageCompilerPorts } from "./page"
import type { PackageSource } from "./source"
import { pageSourceOf } from "../../agent/page-package"

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")

const sheets: Sheets = {
  "tailwindcss/theme.css": read("../../../node_modules/tailwindcss/theme.css"),
  "tailwindcss/preflight.css": read("../../../node_modules/tailwindcss/preflight.css"),
  "tailwindcss/utilities.css": read("../../../node_modules/tailwindcss/utilities.css"),
  "theme.css": read("../../styles/theme.css"),
  "shadow.css": read("../../styles/shadow.css")
}

const ICONS: IconSet = {
  Search01Icon: [["path", { d: "M17 17L21 21", key: "0" }], ["circle", { cx: "11", cy: "11", r: "8", key: "1" }]],
  ArrowRight01Icon: [["path", { d: "M9 6l6 6-6 6", key: "0" }]]
}
const ports: PageCompilerPorts = { sheets, icons: async () => ICONS }

const PAGE = `
import { HugeiconsIcon } from "@hugeicons/react"
import { Search01Icon } from "@hugeicons/core-free-icons"
import { Story } from "./components/Story"

export default function Page() {
  return <main className="mx-auto max-w-3xl p-6"><HugeiconsIcon icon={Search01Icon} /><Story title="one" /></main>
}
`
const STORY = `export const Story = ({ title }: { title: string }) => <h2 className="text-lg font-medium">{title}</h2>`

const skin: PackageSource = {
  entry: "page.tsx",
  style: "style.css",
  files: { "page.tsx": PAGE, "components/Story.tsx": STORY, "style.css": "body { margin: 0 }", "design.css": ":root { --primary: red }" }
}

const failure = async (source: PackageSource, with_: PageCompilerPorts = ports): Promise<PackageCompileError> => {
  try {
    await compilePagePackage(source, with_)
  } catch (cause) {
    if (cause instanceof PackageCompileError) return cause
    throw cause
  }
  throw new Error("compiled")
}

describe("compilePagePackage", () => {
  test("a skin package's script is the page script the extension ran, kit call and icons included", async () => {
    const out = await compilePagePackage(skin, ports)
    const built = await compileSkin(skinFilesOf(skin), sheets, ports.icons)
    expect(out.compiler).toBe(PAGE_COMPILER)
    expect(out.script).toBe(skinScript(built.js, built.css, extrasOf(built)))
    expect(out.script.startsWith("window.__beui.skin(")).toBe(true)
    expect(out.script).toContain("Search01Icon")
    expect(Object.keys(out.sources).sort()).toEqual(["components/Story.tsx", "design.css", "page.tsx", "style.css"])
  })

  test("a skin package with a page.js runs the skin, then the script, the way the page's two registrations run", async () => {
    const out = await compilePagePackage({ ...skin, files: { ...skin.files, "page.js": "document.title = 'x'" } }, ports)
    const alone = await compilePagePackage(skin, ports)
    expect(out.script).toBe(`${alone.script}\ndocument.title = 'x'`)
    expect(Object.keys(out.sources).sort()).toEqual(["components/Story.tsx", "design.css", "page.js", "page.tsx", "style.css"])
  })

  test("the stylesheet is the design first, then the page's own rules", async () => {
    const out = await compilePagePackage(skin, ports)
    expect(out.style).toBe(":root { --primary: red }\nbody { margin: 0 }")
  })

  test("without a design the stylesheet is the page's alone", async () => {
    const { "design.css": _design, ...files } = skin.files
    const out = await compilePagePackage({ ...skin, files }, ports)
    expect(out.style).toBe("body { margin: 0 }")
  })

  test("a page.js package ships the script as it ran", async () => {
    const out = await compilePagePackage({ entry: "page.js", style: "style.css", files: { "page.js": "document.title = 'x'", "style.css": "" } }, ports)
    expect(out.script).toBe("document.title = 'x'")
    expect(out.style).toBe("")
  })

  test("a stylesheet package has an empty script", async () => {
    const out = await compilePagePackage({ entry: "style.css", style: "style.css", files: { "style.css": "a { color: red }" } }, ports)
    expect(out.script).toBe("")
    expect(out.style).toBe("a { color: red }")
  })

  test("the same source gives the same digests twice", async () => {
    const [left, right] = await Promise.all([compilePagePackage(skin, ports), compilePagePackage(skin, ports)])
    expect(left).toEqual(right)
  })

  test("icons through the extension's codec give the same bytes as the set itself", async () => {
    const packed: PageCompilerPorts = { sheets, icons: async () => unpackIconSet(packIconSet(ICONS)) }
    const [direct, viaCodec] = await Promise.all([compilePagePackage(skin, ports), compilePagePackage(skin, packed)])
    expect(viaCodec.artifacts).toEqual(direct.artifacts)
    expect(viaCodec.script).toBe(direct.script)
  })

  test("a skin that does not compile is refused with the skin compiler's words", async () => {
    const error = await failure({ ...skin, files: { ...skin.files, "page.tsx": "import x from 'nowhere'\nexport default () => <p>{x}</p>" } })
    expect(error.reason).toBe("source")
    expect(error.message).toContain("nowhere")
  })

  test("an icon the set lacks is refused", async () => {
    const error = await failure({ ...skin, files: { ...skin.files, "page.tsx": PAGE.replace("Search01Icon", "Search99Icon") } })
    expect(error.message).toContain("Search99Icon")
  })
})

describe("checkPageSource", () => {
  const refusal = (source: PackageSource): string => {
    try {
      checkPageSource(source)
    } catch (cause) {
      if (cause instanceof PackageCompileError) return cause.message
      throw cause
    }
    return ""
  }

  test("style.css is required and is the only stylesheet name", () => {
    expect(refusal({ entry: "page.js", style: "style.css", files: { "page.js": "" } })).toContain("no style.css")
    expect(refusal({ entry: "page.js", style: "main.css", files: { "page.js": "", "main.css": "" } })).toContain("style.css")
  })

  test("a page.js package has no other scripts", () => {
    expect(refusal({ entry: "page.js", style: "style.css", files: { "page.js": "", "a.ts": "", "style.css": "" } })).toContain("no other script")
  })

  test("a stylesheet package has no scripts", () => {
    expect(refusal({ entry: "style.css", style: "style.css", files: { "style.css": "", "x.ts": "" } })).toContain("no script files")
  })

  test("the entry must be a skin entry, page.js or style.css", () => {
    expect(refusal({ entry: "main.tsx", style: "style.css", files: { "main.tsx": "", "style.css": "" } })).toContain("must be page.tsx, skin.tsx, page.js or style.css")
  })

  test("a file that is not TypeScript, page.js or a package stylesheet is refused", () => {
    expect(refusal({ entry: "page.tsx", style: "style.css", files: { "page.tsx": "", "style.css": "", "notes.md": "" } })).toContain("notes.md")
    expect(refusal({ entry: "page.tsx", style: "style.css", files: { "page.tsx": "", "style.css": "", "../x.ts": "" } })).toContain("package-relative")
  })
})

describe("a package that carries several pages", () => {
  const built = pageSourceOf(
    {
      "/": { skin: { "page.tsx": "export default () => <div className=\"p-4\">home</div>" } },
      "/login": {
        css: "body{margin:0}",
        skin: {
          "page.tsx": "import { Card } from \"./Card\"\nexport default () => <Card />",
          "Card.tsx": "export const Card = () => <div className=\"p-2\">login card</div>"
        }
      }
    },
    undefined
  )

  test("the compiler takes the generated layout and builds one script for both pages", async () => {
    if (built === undefined) throw new Error("the package did not build")
    const compiled = await compilePagePackage(built.source, ports)
    expect(compiled.script).toContain("home")
    expect(compiled.script).toContain("login card")
    expect(compiled.script).toContain("/login")
  })

  test("the same source compiles to the same bytes, so the server rebuilds what the extension sent", async () => {
    if (built === undefined) throw new Error("the package did not build")
    const [first, second] = await Promise.all([
      compilePagePackage(built.source, ports),
      compilePagePackage(built.source, ports)
    ])
    expect(first.artifacts).toEqual(second.artifacts)
  })
})

test("a page whose entry is skin.tsx compiles from the generated entry too", async () => {
  const built = pageSourceOf(
    {
      "/": { skin: { "page.tsx": "export default () => <div>home</div>" } },
      "/login": { skin: { "skin.tsx": "export default () => <div>login skin</div>" } }
    },
    undefined
  )
  if (built === undefined) throw new Error("the package did not build")
  const compiled = await compilePagePackage(built.source, ports)
  expect(compiled.script).toContain("login skin")
  expect(compiled.script).toContain("home")
})

test("the same files compile to the same bytes whatever order they arrive in", async () => {
  const files = {
    "page.tsx": 'import { Row } from "./components/Row"\nexport default () => <main><Row /></main>',
    "components/Row.tsx": 'export const Row = () => <div className="p-2">row</div>',
    "style.css": "body { margin: 0 }"
  }
  const reversed = Object.fromEntries(Object.entries(files).reverse())
  const source = { entry: "page.tsx", style: "style.css", files }
  const [first, second] = await Promise.all([
    compilePagePackage(source, ports),
    compilePagePackage({ ...source, files: reversed }, ports)
  ])
  expect(second.artifacts.script).toBe(first.artifacts.script)
  expect(second.script).toBe(first.script)
})
