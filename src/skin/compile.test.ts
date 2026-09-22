import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { candidatesOf } from "../compiler/candidates"
import { iconImports, type IconSet } from "../compiler/icons"
import { CompileFailure, compileSkin, type Sheets, type SkinFiles } from "./compile"

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")

/** The same sheets the panel bundles, read from disk here. */
const sheets: Sheets = {
  "tailwindcss/theme.css": read("../../node_modules/tailwindcss/theme.css"),
  "tailwindcss/preflight.css": read("../../node_modules/tailwindcss/preflight.css"),
  "tailwindcss/utilities.css": read("../../node_modules/tailwindcss/utilities.css"),
  "theme.css": read("../styles/theme.css"),
  "shadow.css": read("../styles/shadow.css")
}

const SKIN = `
import { useState } from "react"
import { Button, TiltCard } from "beui"

export const target = "#hnmain"

interface Story { title: string; href: string }

const stories = (): Story[] =>
  Array.from(document.querySelectorAll<HTMLAnchorElement>(".titleline > a")).map((a) => ({ title: a.textContent ?? "", href: a.href }))

export default function Skin() {
  const [open, setOpen] = useState(false)
  return (
    <main className="mx-auto max-w-3xl bg-background p-6 text-foreground">
      {stories().map((s) => (
        <TiltCard key={s.href} className={open ? "mb-3 rounded-lg" : "mb-3"}>
          <a href={s.href} className="text-[15px] font-medium hover:underline">{s.title}</a>
        </TiltCard>
      ))}
      <Button variant="secondary" onClick={() => setOpen(!open)}>Toggle</Button>
    </main>
  )
}
`

/** A few icons in the set's own shape; the real set has 14,000 and is loaded on demand. */
const ICONS: IconSet = {
  Search01Icon: [["path", { d: "M17 17L21 21", key: "0" }]],
  SearchList01Icon: [["path", { d: "M1 1", key: "0" }]],
  ArrowRight01Icon: [["path", { d: "M9 6l6 6-6 6", key: "0" }]]
}
const icons = async () => ICONS
/** One file, `page.tsx`, or a whole project by path. */
const compile = (skin: string | SkinFiles) => compileSkin(typeof skin === "string" ? { "page.tsx": skin } : skin, sheets, icons)

const failure = async (skin: string | SkinFiles): Promise<string> => {
  try {
    await compile(skin)
  } catch (e) {
    if (e instanceof CompileFailure) return e.message
    throw e
  }
  throw new Error("compiled")
}

describe("compiling a skin", () => {
  test("TSX with imports becomes one CommonJS body that exports the component and the target", async () => {
    const out = await compile(SKIN)
    expect(out.js).toMatch(/require\(['"]react['"]\)/)
    expect(out.js).toMatch(/require\(['"]beui['"]\)/)
    expect(out.js).toMatch(/require\(['"]react\/jsx-runtime['"]\)/)
    expect(out.js).not.toContain("interface Story")
    expect(out.js).not.toContain("<main")
    expect(out.js).toContain("exports.default")
    expect(out.js).toContain("exports.target")
  })

  test("a skin can import a curated Paper Shader from beui", async () => {
    const out = await compile(`
      import { MeshGradient } from "beui"
      export default () => <MeshGradient colors={["#111111", "#eeeeee"]} speed={0} />
    `)

    expect(out.js).toMatch(/require\(['"]beui['"]\)/)
  })

  test("the Tailwind classes it uses become CSS on the design tokens, with preflight and nothing unused", async () => {
    const out = await compile(SKIN)
    expect(out.css).toContain(".bg-background")
    expect(out.css).toContain("var(--background)")
    expect(out.css).toContain(".max-w-3xl")
    expect(out.css).toContain(".mb-3")
    expect(out.css).toContain(".rounded-lg")
    expect(out.css).toContain(".hover\\:underline")
    expect(out.css).toContain(".text-\\[15px\\]")
    expect(out.css).toContain("box-sizing: border-box")
    expect(out.css).not.toContain(".bg-primary")
  })

  test("the skin's sheet is layered like the kit's, and `dark:` reads the host's theme attribute", async () => {
    const out = await compile(`export default () => <div className="dark:bg-card md:flex hidden" />`)
    expect(out.css).toContain("@layer theme, base, components, utilities;")
    expect(out.css).toContain(':host([data-beui-theme="dark"])')
    expect(out.css).toContain(".md\\:flex")
  })

  test("a syntax error is a CompileFailure with the line", async () => {
    expect(await failure("export default function Skin() { return <div> }")).toMatch(/\(1:/)
  })

  test("every shape of default export compiles; whether one is there is the kit's to judge", async () => {
    for (const tsx of ["export default () => null", "const C = () => null\nexport default C", "export default function Skin() { return null }", "export const target = '#x'"]) {
      const out = await compile(tsx)
      expect(typeof out.js).toBe("string")
    }
  })

  test("an import the kit has no module for, or a relative import naming no file, fails at compile time with the file, the ids, the files and the legal ids", async () => {
    // Sucrase drops an unused import, so these are used.
    const message = await failure({ "page.tsx": `import _ from "lodash"\nimport { x } from "./util"\nexport default () => _.f(x)`, "data.ts": "export const x = 1" })
    expect(message).toStartWith("page.tsx imports")
    expect(message).toContain('"lodash"')
    expect(message).toContain('"./util"')
    expect(message).toContain("page.tsx, data.ts")
    expect(message).toContain("beui")
  })

  test("a project: files require each other by relative path, with or without the extension, through folders and back; each loads once; bare ids go to the kit", async () => {
    const out = await compile({
      "page.tsx": `import { Story } from "./components/Story"\nimport { stories } from "./data.ts"\nexport default () => <main>{stories().map((s) => <Story key={s} title={s} />)}</main>`,
      "components/Story.tsx": `import { count } from "../data"\nexport const Story = ({ title }: { title: string }) => <article className="p-4">{title} {count()}</article>`,
      "data.ts": `let calls = 0\nexport const count = () => ++calls\nexport const stories = () => ["a", "b"]`
    })
    // The body is evaluated the way the kit does it: `require` answers the bare ids.
    const seen: Array<string> = []
    const exportsObj: Record<string, unknown> = {}
    const mod = { exports: exportsObj as unknown }
    new Function("require", "exports", "module", out.js)((id: string) => (seen.push(id), { jsx: () => null, jsxs: () => null }), exportsObj, mod)
    const page = mod.exports as { default: () => unknown }
    expect(typeof page.default).toBe("function")
    expect(seen).toEqual(["react/jsx-runtime", "react/jsx-runtime"])
    expect(out.css).toContain(".p-4")
  })

  test("the entry is page.tsx, or skin.tsx, or the one file there is; a project without one is refused", async () => {
    expect(typeof (await compile({ "skin.tsx": "export default () => null" })).js).toBe("string")
    expect(typeof (await compile({ "Main.tsx": "export default () => null" })).js).toBe("string")
    expect(await failure({ "a.tsx": "export default () => null", "b.tsx": "export const b = 1" })).toContain("needs a page.tsx")
    expect(await failure({})).toContain("needs a page.tsx")
  })

  test("a syntax error names the file it is in", async () => {
    expect(await failure({ "page.tsx": `import { S } from "./S"\nexport default () => <S />`, "S.tsx": "export const S = () => <div>" })).toStartWith("S.tsx does not compile")
  })

  test("icons a skin imports are inlined by export name, aliases included; a skin without icons carries none", async () => {
    const out = await compile(`import { HugeiconsIcon } from "@hugeicons/react"\nimport { Search01Icon, ArrowRight01Icon as Next } from "@hugeicons/core-free-icons"\nexport default () => <HugeiconsIcon icon={Search01Icon} altIcon={Next} />`)
    expect(Object.keys(out.icons).sort()).toEqual(["ArrowRight01Icon", "Search01Icon"])
    expect(out.icons["Search01Icon"]).toEqual(ICONS["Search01Icon"])
    expect(out.js).toMatch(/require\(['"]@hugeicons\/core-free-icons['"]\)/)
    expect((await compile("export default () => null")).icons).toEqual({})
    expect(iconImports(`import {\n  A,\n  B as C\n} from '@hugeicons/core-free-icons'\nimport { D } from "beui"`)).toEqual(["A", "B"])
  })

  test("an icon name the set does not have fails at compile time with the near names", async () => {
    const message = await failure(`import { SearchIcon, Nope99Icon } from "@hugeicons/core-free-icons"\nexport default () => <i>{SearchIcon}{Nope99Icon}</i>`)
    expect(message).toContain("SearchIcon (near: Search01Icon, SearchList01Icon)")
    expect(message).toContain("Nope99Icon (no icon by that stem)")
    expect(message).toContain("Search01Icon, ArrowRight01Icon")
  })

  test("an icon set that does not load is a compile failure that names the load, not a bare error from inside it", async () => {
    // Seen live on 2026-09-12: the set was an `import()`, Chrome refused it in the service
    // worker, and the model read the masked "window is not defined" as an SSR problem.
    const broken = () => Promise.reject(new Error("the icon set at chrome-extension://x/hugeicons.json did not load: HTTP 404"))
    const skin = `import { Search01Icon } from "@hugeicons/core-free-icons"\nexport default () => <i>{Search01Icon}</i>`
    const outcome = await compileSkin({ "page.tsx": skin }, sheets, broken).then(
      () => "compiled",
      (e: unknown) => e
    )
    expect(outcome).toBeInstanceOf(CompileFailure)
    expect((outcome as CompileFailure).message).toBe(
      "the icon set did not load, so no skin can import from @hugeicons/core-free-icons right now: the icon set at chrome-extension://x/hugeicons.json did not load: HTTP 404"
    )
    // A skin without icons never touches the set.
    expect((await compileSkin({ "page.tsx": "export default () => null" }, sheets, broken)).icons).toEqual({})
  })

  test("candidates: every whitespace-separated word inside a string literal, once", () => {
    expect(candidatesOf(`a("p-4 bg-card", 'p-4 hover:x', \`grid \${n} gap-2\`)`)).toEqual(["p-4", "bg-card", "hover:x", "grid", "gap-2"])
    expect(candidatesOf("const x = 1")).toEqual([])
  })

  test("candidates: a class inside a template's ${...} is found, quotes and all", () => {
    expect(candidatesOf('`text-sm ${a ? "font-bold" : "font-normal"} p-2`')).toEqual(["text-sm", "font-bold", "font-normal", "p-2"])
    expect(candidatesOf("`a ${b ? `x ${c ? 'deep' : 'deeper'}` : 'y'} z`")).toEqual(["a", "x", "deep", "deeper", "y", "z"])
    expect(candidatesOf("`${fn({ k: 1 })} after`")).toEqual(["after"])
  })
})

describe("the icon names the doc offers", () => {
  test("every name in SKIN_DOC's icon list is in the free set, so the model's first import compiles", async () => {
    const set = await import("@hugeicons/core-free-icons")
    const { SKIN_DOC } = await import("./docs")
    const line = SKIN_DOC.split("\n").find((l) => l.startsWith("Names are PascalCase")) ?? ""
    const names = (line.split("Names that exist: ")[1] ?? "").split(". ")[0]?.split(", ") ?? []
    expect(names.length).toBeGreaterThan(50)
    expect(names.filter((n) => !Object.hasOwn(set, n))).toEqual([])
  })
})

describe("the sheet every shadow root wears", () => {
  test("the kit sheet and the skin sheet import the same shadow.css, so the layers and the dark variant have one home", () => {
    // Unlayered rules beat layered ones whatever their order: an unlayered kit sheet hid a skin's whole navigation once.
    const shadow = read("../styles/shadow.css")
    expect(shadow).toContain("@layer theme, base, components, utilities;")
    expect(shadow).toContain('@import "tailwindcss/utilities.css" layer(utilities);')
    expect(shadow).toContain('@import "tailwindcss/theme.css" layer(theme);')
    expect(shadow).toContain("@custom-variant dark")
    expect(read("../kit/kit.css")).toContain('@import "../styles/shadow.css";')
    expect(read("./compile.ts")).toContain('@import "shadow.css";')
  })
})
