import { readFile, readdir } from "node:fs/promises"
import { join, relative } from "node:path"
import { packIconSet, unpackIconSet } from "../../skin/icon-codec"
import type { CompilerPorts } from "./compile"
import type { PageCompilerPorts } from "./page"
import type { PackageSource } from "./source"

const text = (path: string): Promise<string> => readFile(path, "utf8")

/** Node binding used by reproducible build scripts and integration tests. */
export const nodeCompilerPorts = async (
  root: string,
  lent: ReadonlyArray<string>
): Promise<CompilerPorts> => {
  return {
    lent,
    sheets: {
      "tailwindcss/theme.css": await text(join(root, "node_modules/tailwindcss/theme.css")),
      "tailwindcss/preflight.css": await text(join(root, "node_modules/tailwindcss/preflight.css")),
      "tailwindcss/utilities.css": await text(join(root, "node_modules/tailwindcss/utilities.css"))
    },
    icons: () => import("@hugeicons/core-free-icons")
  }
}

/**
 * The page compiler's binding for the server: the same sheets the panel bundles, read from
 * the repository, and the icon set through the same codec the extension's asset goes
 * through, so both sides hand the skin compiler identical icon objects and the same source
 * digests to the same bytes.
 */
export const nodePageCompilerPorts = async (root: string): Promise<PageCompilerPorts> => ({
  sheets: {
    "tailwindcss/theme.css": await text(join(root, "node_modules/tailwindcss/theme.css")),
    "tailwindcss/preflight.css": await text(join(root, "node_modules/tailwindcss/preflight.css")),
    "tailwindcss/utilities.css": await text(join(root, "node_modules/tailwindcss/utilities.css")),
    "theme.css": await text(join(root, "src/styles/theme.css")),
    "shadow.css": await text(join(root, "src/styles/shadow.css"))
  },
  icons: async () => {
    const set = await import("@hugeicons/core-free-icons")
    return unpackIconSet(packIconSet(Object.fromEntries(Object.entries(set))))
  }
})

/** Read one package source folder without giving the compiler filesystem access. */
export const packageSourceAt = async (
  root: string,
  entry: string,
  style: string,
  include: (path: string) => boolean = () => true
): Promise<PackageSource> => {
  const files: Record<string, string> = {}
  for (const item of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!item.isFile()) continue
    const absolute = join(item.parentPath, item.name)
    const path = relative(root, absolute)
    if (!include(path)) continue
    files[path] = await text(absolute)
  }
  return { entry, style, files }
}
