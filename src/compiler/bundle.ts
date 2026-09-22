/**
 * Turn a folder of TypeScript into one CommonJS body the browser can run.
 *
 * This module has no opinion about skins or marketplace packages. Sucrase removes types
 * and JSX, relative imports resolve against in-memory files, and one loader binds them.
 */
import { transform } from "sucrase"

export const SOURCE_EXTENSIONS: ReadonlyArray<string> = [
  "",
  ".tsx",
  ".ts",
  "/index.tsx",
  "/index.ts"
]

export const normalise = (from: string, id: string): string => {
  const parts = from.split("/").slice(0, -1)
  for (const segment of id.split("/")) {
    if (segment === "..") parts.pop()
    else if (segment !== "." && segment !== "") parts.push(segment)
  }
  return parts.join("/")
}

export const resolveFile = (
  files: Readonly<Record<string, string>>,
  from: string,
  id: string
): string | undefined => {
  const base = normalise(from, id)
  return SOURCE_EXTENSIONS.map((extension) => base + extension).find((path) =>
    Object.hasOwn(files, path)
  )
}

export const isRelative = (id: string): boolean =>
  id.startsWith("./") || id.startsWith("../")

export const leavesPackage = (from: string, id: string): boolean => {
  const parts = from.split("/").slice(0, -1)
  for (const segment of id.split("/")) {
    if (segment === "." || segment === "") continue
    if (segment === "..") {
      if (parts.length === 0) return true
      parts.pop()
    } else {
      parts.push(segment)
    }
  }
  return false
}

const REQUIRE = /\brequire\((['"])([^'"]+)\1\)/g

export const requiredIds = (js: string): ReadonlyArray<string> => [
  ...new Set(Array.from(js.matchAll(REQUIRE), (match) => match[2] ?? ""))
]

export const transformSource = (path: string, source: string): string =>
  transform(source, {
    transforms: ["typescript", "jsx", "imports"],
    jsxRuntime: "automatic",
    production: true,
    filePath: path,
    disableESTransforms: true
  }).code

export interface BoundModule {
  readonly path: string
  readonly js: string
  readonly links: Readonly<Record<string, string>>
}

/**
 * One body for a set of modules. They are written in path order, never in the order they
 * arrived: a package's bytes must be a function of its files, not of how the object that
 * carried them happened to be keyed. Two callers with the same files, one that read them
 * from disk and one that sorted the manifest, have to produce the same digest, because
 * that is what lets a reader rebuild a release and compare it with what was published.
 */
export const bindModules = (
  modules: ReadonlyArray<BoundModule>,
  entry: string,
  inlined: Readonly<Record<string, string>> = {}
): string => {
  const ordered = [...modules].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  const table = ordered
    .map(
      (module) =>
        `${JSON.stringify(module.path)}: function (require, exports, module) {\n${module.js}\n}`
    )
    .join(",\n")
  const links = Object.fromEntries(
    ordered.map((module) => [module.path, module.links])
  )
  const given = `{\n${Object.entries(inlined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([id, value]) => `${JSON.stringify(id)}: ${value}`)
    .join(",\n")}\n}`
  return `var __inlined = ${given};
var __files = {
${table}
};
var __links = ${JSON.stringify(links)};
var __cache = {};
function __load(path) {
  if (__cache[path]) return __cache[path].exports;
  var m = { exports: {} };
  __cache[path] = m;
  var links = __links[path] || {};
  __files[path](function (id) {
    if (Object.hasOwn(links, id)) return __load(links[id]);
    if (Object.hasOwn(__inlined, id)) return __inlined[id];
    return require(id);
  }, m.exports, m);
  return m.exports;
}
module.exports = __load(${JSON.stringify(entry)});`
}
