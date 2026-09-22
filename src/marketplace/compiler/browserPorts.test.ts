import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { createServer } from "vite"
import {
  compilePackage,
  COMPILER,
  type CompilerPorts,
  type PackageSource
} from "./compile"
import { nodeCompilerPorts } from "./node"
import { LENT_MODULE_IDS } from "../sandbox/lentModules"

const root = resolve(import.meta.dirname, "../../..")

const source: PackageSource = {
  entry: "entry.ts",
  style: "style.css",
  files: {
    "entry.ts": "export const start = () => 1",
    "style.css": '@import "tailwindcss/theme.css";'
  }
}

describe("the browser compiler binding", () => {
  test("the compiler identity records each byte-producing dependency", async () => {
    for (const name of ["sucrase", "tailwindcss", "@hugeicons/core-free-icons"]) {
      const manifest = JSON.parse(
        await readFile(join(root, "node_modules", name, "package.json"), "utf8")
      ) as { version: string }
      expect(COMPILER).toContain(manifest.version)
    }
  })

  test("writes the same bytes and digests as the release binding", async () => {
    const vite = await createServer({
      root,
      configFile: false,
      appType: "custom",
      optimizeDeps: { noDiscovery: true },
      server: { middlewareMode: true }
    })
    try {
      const module = (await vite.ssrLoadModule(
        "/src/marketplace/compiler/browserPorts.ts"
      )) as { browserCompilerPorts: CompilerPorts }
      const node = await nodeCompilerPorts(root, LENT_MODULE_IDS)

      const [browserBuild, nodeBuild] = await Promise.all([
        compilePackage(source, module.browserCompilerPorts),
        compilePackage(source, node)
      ])
      expect(browserBuild.script).toBe(nodeBuild.script)
      expect(browserBuild.style).toBe(nodeBuild.style)
      expect(browserBuild.artifacts).toEqual(nodeBuild.artifacts)
    } finally {
      await vite.close()
    }
  })
})
