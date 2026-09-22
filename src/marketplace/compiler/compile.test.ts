import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { compilePackage, COMPILER, type CompilerPorts, PackageCompileError, type PackageSource } from "./compile"

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")

/** The sheets the extension bundles for a package, read from disk here. */
const sheets: Readonly<Record<string, string>> = {
  "tailwindcss/theme.css": read("../../../node_modules/tailwindcss/theme.css"),
  "tailwindcss/preflight.css": read("../../../node_modules/tailwindcss/preflight.css"),
  "tailwindcss/utilities.css": read("../../../node_modules/tailwindcss/utilities.css")
}

const ICONS: Readonly<Record<string, unknown>> = {
  Search01Icon: [["path", { d: "M17 17L21 21", key: "0" }]],
  SearchList01Icon: [["path", { d: "M1 1", key: "0" }]],
  ArrowRight01Icon: [["path", { d: "M9 6l6 6-6 6", key: "0" }]]
}

const ports: CompilerPorts = {
  lent: ["effect", "react", "react/jsx-runtime", "react-dom/client"],
  sheets,
  icons: async () => ICONS
}

const project = (files: Readonly<Record<string, string>>, entry = "entry.tsx", style = "style.css"): PackageSource => ({ entry, style, files })

const ENTRY = `import { Effect } from "effect"
import { Row } from "./ui/Row"
import "./style.css"

export const start = () => Effect.sync(() => Row({ title: "one" }))
`

const ROW = `interface Props { readonly title: string }

export const Row = ({ title }: Props) => <div className="flex gap-2 p-4">{title}</div>
`

const STYLE = `@import "tailwindcss/theme.css" layer(theme);
@import "tailwindcss/utilities.css";
@import "./ui/row.css";
`

const ROW_CSS = `.row { color: red; }
`

const sampleProject = () => project({ "entry.tsx": ENTRY, "ui/Row.tsx": ROW, "style.css": STYLE, "ui/row.css": ROW_CSS })

/** The refusal, or a failure saying it compiled when it should not have. */
const refusal = async (source: PackageSource, given: CompilerPorts = ports): Promise<PackageCompileError> => {
  try {
    await compilePackage(source, given)
  } catch (error) {
    if (error instanceof PackageCompileError) return error
    throw error
  }
  throw new Error("the package compiled")
}

const ONE_LINE_CSS = `@import "tailwindcss/utilities.css";`

describe("compiling a package", () => {
  test("an entry, its relative modules and one stylesheet become a sandbox script and a stylesheet", async () => {
    const out = await compilePackage(sampleProject(), ports)

    expect(out.script).toMatch(/require\(['"]effect['"]\)/)
    expect(out.script).not.toContain("interface Props")
    expect(out.script).not.toContain("<div")
    expect(out.script).toContain('module.exports = __load("entry.tsx")')
    expect(out.script).toContain("return module.exports.start(morph);")
    expect(out.style).toContain(".flex")
    expect(out.style).toContain(".gap-2")
    expect(out.style).toContain(".row")
    expect(out.style).not.toContain(".hidden")
  })

  test("the sandbox runs the script the way the guest does, and the modules load once", async () => {
    const out = await compilePackage(
      project({
        "entry.tsx": `import { count } from "./data"\nimport { Row } from "./ui/Row"\nexport const start = (morph: unknown) => ({ morph, first: count(), again: count(), row: typeof Row })`,
        "data.ts": `let calls = 0\nexport const count = () => ++calls`,
        "ui/Row.tsx": ROW,
        "style.css": `@import "tailwindcss/utilities.css";`
      }),
      ports
    )

    const asked: Array<string> = []
    const answer = { jsx: () => null, jsxs: () => null }
    const exports: Record<string, unknown> = {}
    const started = new Function("require", "exports", "module", "morph", out.script)(
      (id: string) => (asked.push(id), answer),
      exports,
      { exports },
      "the-morph"
    ) as { morph: string; first: number; again: number; row: string }

    expect(started.morph).toBe("the-morph")
    expect(started.first).toBe(1)
    expect(started.again).toBe(2)
    expect(started.row).toBe("function")
    expect(asked).toEqual(["react/jsx-runtime"])
  })

  test("every source file, the script and the stylesheet carry a sha256 digest, beside the compiler that made them", async () => {
    const out = await compilePackage(sampleProject(), ports)

    expect(Object.keys(out.sources).sort()).toEqual(["entry.tsx", "style.css", "ui/Row.tsx", "ui/row.css"])
    for (const digest of Object.values(out.sources)) expect(digest).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(out.artifacts.script).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(out.artifacts.css).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(out.compiler).toBe(COMPILER)
    // The digest the installer checks is the digest of the artifact's own bytes.
    expect(out.artifacts.script).toBe(
      `sha256:${[...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(out.script)))]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("")}`
    )
  })
})

describe("a package the compiler refuses", () => {
  test("a project with no files, and an entry or a stylesheet that is not one of them", async () => {
    expect((await refusal(project({}))).message).toBe("the package has no files")
    const missing = await refusal(project({ "other.tsx": "export const start = () => 1", "style.css": ONE_LINE_CSS }))
    expect(missing.reason).toBe("source")
    expect(missing.message).toContain('the package entry "entry.tsx" is not one of its files')
    expect(missing.message).toContain("other.tsx, style.css")
    const noStyle = await refusal(project({ "entry.tsx": "export const start = () => 1" }))
    expect(noStyle.message).toContain('the package stylesheet "style.css" is not one of its files')
  })

  test("file count and source byte limits stop work before compilation", async () => {
    const many = Object.fromEntries([
      ["entry.ts", "export const start = () => 1"],
      ["style.css", ONE_LINE_CSS],
      ...Array.from({ length: 255 }, (_, index) => [
        `data/${index}.ts`,
        `export const value${index} = ${index}`
      ])
    ])
    expect((await refusal(project(many, "entry.ts"))).message).toContain("at most 256 files")

    const large = await refusal(
      project({
        "entry.ts": "export const start = () => 1",
        "large.ts": `export const value = ${JSON.stringify("x".repeat(512_001))}`,
        "style.css": ONE_LINE_CSS
      }, "entry.ts")
    )
    expect(large.file).toBe("large.ts")
    expect(large.message).toContain("at most 512000 bytes")
  })

  test("candidate and generated artifact limits stop bounded source from expanding without limit", async () => {
    const candidates = Array.from({ length: 5_001 }, (_, index) => `candidate-${index}`).join(" ")
    const tooManyCandidates = await refusal(
      project({
        "entry.ts": `export const names = ${JSON.stringify(candidates)}\nexport const start = () => names`,
        "style.css": ONE_LINE_CSS
      }, "entry.ts")
    )
    expect(tooManyCandidates.message).toContain("at most 5000 Tailwind candidates")

    const hugeIcon = await refusal(
      project({
        "entry.ts": `import { HugeIcon } from "@hugeicons/core-free-icons"\nexport const start = () => HugeIcon`,
        "style.css": ONE_LINE_CSS
      }, "entry.ts"),
      { ...ports, icons: async () => ({ HugeIcon: "x".repeat(2_500_000) }) }
    )
    expect(hugeIcon.message).toContain("compiled script can contain at most 2500000 bytes")

    const hugeStyle = await refusal(
      project({
        "entry.ts": "export const start = () => 1",
        "style.css": '@import "large.css";'
      }, "entry.ts"),
      {
        ...ports,
        sheets: { ...ports.sheets, "large.css": `.large{--value:${"x".repeat(1_000_000)}}` }
      }
    )
    expect(hugeStyle.message).toContain("compiled stylesheet can contain at most 1000000 bytes")
  })

  test("a path that is not the one canonical spelling of a package-relative file", async () => {
    for (const path of ["./entry.tsx", "/entry.tsx", "../entry.tsx", "ui//Row.tsx", "ui\\Row.tsx", "https://x/e.tsx", "ui/"]) {
      const error = await refusal(project({ [path]: "export const start = () => 1", "entry.tsx": "export const start = () => 1", "style.css": ONE_LINE_CSS }))
      expect(error.reason).toBe("source")
      expect(error.message).toContain("is not a package-relative path")
      expect(error.file).toBe(path)
    }
  })

  test("a package file cannot hide a stylesheet lent by the runtime", async () => {
    const error = await refusal(
      project({
        "entry.tsx": "export const start = () => 1",
        "style.css": '@import "tailwindcss/utilities.css";',
        "tailwindcss/utilities.css": ".wrong { color: red; }"
      })
    )
    expect(error.reason).toBe("source")
    expect(error.file).toBe("tailwindcss/utilities.css")
    expect(error.message).toContain("same name as a runtime stylesheet")
  })

  test("a file that is neither TypeScript nor a stylesheet", async () => {
    const error = await refusal(project({ "entry.tsx": "export const start = () => 1", "style.css": ONE_LINE_CSS, "build.sh": "npm run build" }))
    expect(error.message).toContain("build.sh is neither TypeScript nor a stylesheet")
  })

  test("a source TypeScript cannot read names the file and the line", async () => {
    const error = await refusal(project({ "entry.tsx": "export const start = () => <div>", "style.css": ONE_LINE_CSS }))
    expect(error.reason).toBe("syntax")
    expect(error.file).toBe("entry.tsx")
    expect(error.message).toStartWith("entry.tsx does not compile")
    expect(error.message).toMatch(/\(1:/)
  })

  test("the entry must export the start function the sandbox calls", async () => {
    const error = await refusal(
      project({
        "entry.tsx": `export const ready = () => 1`,
        "style.css": ONE_LINE_CSS
      })
    )
    expect(error.reason).toBe("source")
    expect(error.file).toBe("entry.tsx")
    expect(error.message).toContain("must export start")
  })

  test("an import that names no file of the package", async () => {
    const error = await refusal(
      project({ "entry.tsx": `import { gone } from "./gone"\nexport const start = () => gone`, "style.css": ONE_LINE_CSS })
    )
    expect(error.reason).toBe("import")
    expect(error.file).toBe("entry.tsx")
    expect(error.id).toBe("./gone")
    expect(error.message).toContain("the package has no such file")
  })

  test("a runtime import cannot walk above the package root and return through another file", async () => {
    const error = await refusal(
      project({
        "entry.tsx": `import { secret } from "../../secret"\nexport const start = () => secret`,
        "secret.ts": `export const secret = "outside"`,
        "style.css": ONE_LINE_CSS
      })
    )
    expect(error.reason).toBe("import")
    expect(error.id).toBe("../../secret")
    expect(error.message).toContain("leaves the package")
  })

  test("an import of an address, of an absolute path, of Node, and of a module the runtime does not lend", async () => {
    const cases = [
      ["https://esm.sh/left-pad", "cannot load code from an address"],
      ["//esm.sh/left-pad", "cannot load code from an address"],
      ["/opt/secrets", "imports its own files by relative path"],
      ["node:fs", "has none of Node"],
      ["fs", "has none of Node"],
      ["child_process", "has none of Node"],
      ["constructor", "which the runtime does not lend"],
      ["left-pad", "which the runtime does not lend"]
    ] as const
    for (const [id, said] of cases) {
      const error = await refusal(
        project({ "entry.tsx": `import x from ${JSON.stringify(id)}\nexport const start = () => x`, "style.css": ONE_LINE_CSS })
      )
      expect(error.reason).toBe("import")
      expect(error.id).toBe(id)
      expect(error.message).toContain(said)
    }
  })

  test("a package that reads import.meta, which the sandbox cannot even parse", async () => {
    const error = await refusal(
      project({ "entry.tsx": `export const start = () => (import.meta.env.DEV ? 1 : 2)`, "style.css": ONE_LINE_CSS })
    )
    expect(error.reason).toBe("import")
    expect(error.message).toContain("import.meta")
  })

  test("a second stylesheet imported from a source, when a package ships one", async () => {
    const error = await refusal(
      project({
        "entry.tsx": `import "./style.css"\nimport "./ui/row.css"\nexport const start = () => 1`,
        "ui/row.css": ROW_CSS,
        "style.css": ONE_LINE_CSS
      })
    )
    expect(error.reason).toBe("import")
    expect(error.id).toBe("./ui/row.css")
    expect(error.message).toContain("a package has one stylesheet and it is style.css")
  })

  test("a stylesheet that imports nothing that exists, an address, or a sheet the runtime does not lend", async () => {
    const style = (css: string) => project({ "entry.tsx": "export const start = () => 1", "style.css": css })
    expect((await refusal(style(`@import "./gone.css";`))).message).toContain("the package has no gone.css")
    expect((await refusal(style(`@import "https://fonts.example/x.css";`))).message).toContain("cannot import from a network address")
    expect((await refusal(style(`@import url("//fonts.example/x.css");`))).message).toContain("cannot import from a network address")
    expect((await refusal(style(`@import "/etc/x.css";`))).message).toContain("imports its own files by relative path")
    expect((await refusal(style(`@import "../secret.css";`))).message).toContain("leaves the package")
    const unlent = await refusal(style(`@import "bootstrap";`))
    expect(unlent.reason).toBe("style")
    expect(unlent.message).toContain("a package stylesheet may import tailwindcss/theme.css")
  })

  test("an import without whitespace still passes through the stylesheet checks", async () => {
    const error = await refusal(
      project({
        "entry.tsx": "export const start = () => 1",
        "style.css": '@import"https://bad.example/style.css";'
      })
    )
    expect(error.reason).toBe("style")
    expect(error.message).toContain("network address")
  })

  test("a relative stylesheet asset fails instead of becoming a broken frame request", async () => {
    const error = await refusal(
      project({
        "entry.tsx": "export const start = () => 1",
        "style.css": '.face { background-image: url("./face.png"); }'
      })
    )
    expect(error.reason).toBe("style")
    expect(error.message).toContain("cannot load an asset")
  })

  test("a stylesheet cycle is named rather than followed", async () => {
    const error = await refusal(
      project({
        "entry.tsx": "export const start = () => 1",
        "style.css": `@import "./ui/a.css";`,
        "ui/a.css": `@import "./b.css";`,
        "ui/b.css": `@import "../style.css";`
      })
    )
    expect(error.reason).toBe("style")
    expect(error.message).toContain("style.css imports ui/a.css imports ui/b.css imports style.css, which is a cycle")
  })

  test("a stylesheet that asks Tailwind to scan a folder for class names", async () => {
    const error = await refusal(
      project({ "entry.tsx": "export const start = () => 1", "style.css": `@import "tailwindcss/utilities.css" source("../");` })
    )
    expect(error.reason).toBe("style")
    expect(error.message).toContain("cannot scan a folder for class names")
  })

  test("an @import written about in a comment is prose, not an import", async () => {
    const out = await compilePackage(
      project({
        "entry.tsx": "export const start = () => 1",
        "style.css": `/* @import "tailwindcss" would bring the reset with it. */\n@import "tailwindcss/utilities.css";`
      }),
      ports
    )
    expect(out.style).toContain("tailwindcss")
  })

  test("an icon name the set does not have offers the near names", async () => {
    const error = await refusal(
      project({
        "entry.tsx": `import { SearchIcon } from "@hugeicons/core-free-icons"\nexport const start = () => SearchIcon`,
        "style.css": ONE_LINE_CSS
      })
    )
    expect(error.reason).toBe("icon")
    expect(error.message).toContain("SearchIcon (near: Search01Icon, SearchList01Icon)")
  })

  test("namespace, default, re-exported, and dynamic icon imports fail before the sandbox starts", async () => {
    const imports = [
      `import * as Icons from "@hugeicons/core-free-icons"\nexport const start = () => Icons`,
      `import * as Icons\nfrom "@hugeicons/core-free-icons"\nexport const start = () => Icons`,
      `import Icons from "@hugeicons/core-free-icons"\nexport const start = () => Icons`,
      `import Icons,\n{ Search01Icon }\nfrom "@hugeicons/core-free-icons"\nexport const start = () => Icons`,
      `export { Search01Icon as start } from "@hugeicons/core-free-icons"`,
      `export *\nfrom "@hugeicons/core-free-icons"\nexport const start = () => 1`,
      `export const start = () => import("@hugeicons/core-free-icons")`
    ]
    for (const entry of imports) {
      const error = await refusal(
        project({ "entry.tsx": entry, "style.css": ONE_LINE_CSS })
      )
      expect(error.reason).toBe("icon")
      expect(error.message).toContain("named imports")
    }
  })
})

describe("what a package may write", () => {
  test("one file and a stylesheet is a package", async () => {
    const out = await compilePackage(
      project({ "entry.tsx": `import "./style.css"\nexport const start = () => "up"`, "style.css": ONE_LINE_CSS }),
      ports
    )
    expect(out.script).toContain('module.exports = __load("entry.tsx")')
    expect(Object.keys(out.sources)).toEqual(["entry.tsx", "style.css"])
  })

  test("checked-in vendor modules use relative imports and do not add Tailwind candidates", async () => {
    const out = await compilePackage(
      project(
        {
          "entry.ts": `import { answer } from "./vendor/tiny-ui"\nexport const start = () => answer`,
          "vendor/tiny-ui.ts": `export const answer = 42\nexport const internalClass = "visible"`,
          "style.css": ONE_LINE_CSS
        },
        "entry.ts"
      ),
      { ...ports, lent: [] }
    )
    const exports = {}
    const started = new Function("require", "exports", "module", "morph", out.script)(
      () => ({}),
      exports,
      { exports },
      {}
    )
    expect(started).toBe(42)
    expect(out.style).not.toContain(".visible")
  })

  test("relative modules resolve with or without their ending, through folders and back, and through an index", async () => {
    const out = await compilePackage(
      project(
        {
          "app/entry.tsx": `import { a } from "../domain/a"\nimport { b } from "./b.ts"\nimport { c } from "../domain/deep"\nexport const start = () => [a, b, c]`,
          "app/b.ts": `import { a } from "../domain/a"\nexport const b = a + 1`,
          "domain/a.ts": "export const a = 1",
          "domain/deep/index.ts": "export const c = 3",
          "app/style.css": ONE_LINE_CSS
        },
        "app/entry.tsx",
        "app/style.css"
      ),
      ports
    )
    const exports: Record<string, unknown> = {}
    const started = new Function("require", "exports", "module", "morph", out.script)(() => ({}), exports, { exports }, {}) as Array<number>
    expect(started).toEqual([1, 2, 3])
  })

  test("a relative path can enter a folder before it walks back to the package root", async () => {
    const out = await compilePackage(
      project(
        {
          "ui/entry.ts": `import { value } from "./sub/../../value"\nexport const start = () => value`,
          "value.ts": "export const value = 7",
          "style.css": ONE_LINE_CSS
        },
        "ui/entry.ts"
      ),
      ports
    )
    const exports = {}
    const started = new Function("require", "exports", "module", "morph", out.script)(
      () => ({}),
      exports,
      { exports },
      {}
    )
    expect(started).toBe(7)
  })

  test("a type-only import of a file outside the package is erased, so the sandbox never asks for it", async () => {
    const out = await compilePackage(
      project({
        "entry.tsx": `import type { SandboxRequester } from "../../sandbox/request"\nimport { type Only, value } from "./both"\nexport const start = (morph: SandboxRequester) => ({ morph, value } as { morph: SandboxRequester; value: Only })`,
        "both.ts": `export type Only = number\nexport const value: Only = 7`,
        "style.css": ONE_LINE_CSS
      }),
      ports
    )
    expect(out.script).not.toContain("sandbox/request")
    expect(out.script).toContain('"both.ts"')
  })

  test("icons are inlined by name, aliases included, and the artifact carries no other icon", async () => {
    const out = await compilePackage(
      project({
        "entry.tsx": `import { Search01Icon, ArrowRight01Icon as Next } from "@hugeicons/core-free-icons"\nexport const start = () => [Search01Icon, Next]`,
        "style.css": ONE_LINE_CSS
      }),
      ports
    )
    const exports: Record<string, unknown> = {}
    const started = new Function("require", "exports", "module", "morph", out.script)(
      (id: string) => {
        throw new Error(`the sandbox was asked for ${id}`)
      },
      exports,
      { exports },
      {}
    ) as Array<unknown>
    expect(started).toEqual([ICONS["Search01Icon"], ICONS["ArrowRight01Icon"]])
    expect(out.script).not.toContain("SearchList01Icon")
  })
})

describe("the same source, the same bytes", () => {
  test("the order the files were written in does not reach the artifacts", async () => {
    const files = { "entry.tsx": ENTRY, "ui/Row.tsx": ROW, "style.css": STYLE, "ui/row.css": ROW_CSS }
    const reversed = Object.fromEntries(Object.entries(files).reverse())
    const first = await compilePackage(project(files), ports)
    const second = await compilePackage(project(reversed), ports)
    expect(second.artifacts).toEqual(first.artifacts)
    expect(second.script).toBe(first.script)
    expect(second.style).toBe(first.style)
    expect(second.sources).toEqual(first.sources)
  })

  test("compiling the same package twice gives the same digests", async () => {
    const first = await compilePackage(sampleProject(), ports)
    const second = await compilePackage(sampleProject(), ports)
    expect(second.artifacts).toEqual(first.artifacts)
  })

  test("one changed byte changes that file's digest and the script's, and leaves the others alone", async () => {
    const before = await compilePackage(sampleProject(), ports)
    const after = await compilePackage(
      project({ "entry.tsx": ENTRY, "ui/Row.tsx": `${ROW}\nexport const extra = 1\n`, "style.css": STYLE, "ui/row.css": ROW_CSS }),
      ports
    )
    expect(after.sources["ui/Row.tsx"]).not.toBe(before.sources["ui/Row.tsx"])
    expect(after.sources["entry.tsx"]).toBe(before.sources["entry.tsx"])
    expect(after.artifacts.script).not.toBe(before.artifacts.script)
    expect(after.artifacts.css).toBe(before.artifacts.css)
  })

  test("a class added to a source changes the stylesheet digest", async () => {
    const before = await compilePackage(sampleProject(), ports)
    const after = await compilePackage(
      project({ "entry.tsx": ENTRY, "ui/Row.tsx": ROW.replace("flex gap-2 p-4", "flex gap-2 p-4 underline"), "style.css": STYLE, "ui/row.css": ROW_CSS }),
      ports
    )
    expect(after.artifacts.css).not.toBe(before.artifacts.css)
    expect(after.style).toContain(".underline")
  })
})
