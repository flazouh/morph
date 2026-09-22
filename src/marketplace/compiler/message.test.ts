import { describe, expect, test } from "bun:test"
import type { CompilerPorts } from "./compile"
import {
  isPackageCompileAsk,
  packageCompileHandler
} from "./message"

const ports: CompilerPorts = {
  lent: [],
  sheets: {
    "tailwindcss/utilities.css": "@tailwind utilities;"
  },
  icons: async () => ({})
}

describe("compiling a package through the extension boundary", () => {
  test("the service-worker handler returns preview-ready artifacts", async () => {
    const answer = await packageCompileHandler(ports)({
      type: "compileMorphPackage",
      source: {
        entry: "entry.ts",
        style: "style.css",
        files: {
          "entry.ts": "export const start = () => 1",
          "style.css": ""
        }
      }
    })

    expect(answer.type).toBe("morphPackageCompiled")
    if (answer.type === "morphPackageCompiled") {
      expect(answer.compiled.script).toContain("return module.exports.start(morph)")
    }
  })

  test("invalid messages never enter the compiler", () => {
    expect(isPackageCompileAsk({ type: "compileMorphPackage", source: null })).toBe(false)
    expect(
      isPackageCompileAsk({
        type: "compileMorphPackage",
        source: { entry: "entry.ts", style: "style.css", files: { "entry.ts": 1 } }
      })
    ).toBe(false)
  })
})
