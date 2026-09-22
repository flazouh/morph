import { describe, expect, test } from "bun:test"
import type { GeneratedSource } from "./source"
import { parseSourceMapReference, resolveSourceMap } from "./source-map"

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

const vlq = (value: number): string => {
  let rest = value < 0 ? (-value << 1) | 1 : value << 1
  let out = ""
  do {
    let digit = rest & 31
    rest = rest >>> 5
    if (rest > 0) digit = digit | 32
    out += BASE64[digit]
  } while (rest > 0)
  return out
}

/**
 * Real maps arrive with VLQ mappings, so the fixtures build them from absolute segments:
 * `[generatedColumn, sourceIndex, sourceLine, sourceColumn]`, every field zero-based.
 */
const encodeMappings = (lines: ReadonlyArray<ReadonlyArray<ReadonlyArray<number>>>): string => {
  const previous = [0, 0, 0, 0, 0]
  return lines
    .map((segments) => {
      previous[0] = 0
      return segments
        .map((segment) =>
          segment
            .map((value, index) => {
              const delta = value - (previous[index] ?? 0)
              previous[index] = value
              return vlq(delta)
            })
            .join("")
        )
        .join(",")
    })
    .join(";")
}

const MAP_URL = "https://app.test/assets/index-9f1.js.map"

const bundleMap = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  version: 3,
  file: "index-9f1.js",
  sources: ["../src/ui/Card.tsx"],
  names: [],
  mappings: encodeMappings([
    [
      [0, 0, 11, 4],
      [10, 0, 11, 20]
    ],
    []
  ]),
  ...extra
})

const at = (line: number, column: number, component: string | null = null): GeneratedSource => ({
  url: "https://app.test/assets/index-9f1.js",
  line,
  column,
  component
})

describe("parseSourceMapReference", () => {
  const script = (reference: string) => `console.log(1)\n//# sourceMappingURL=${reference}\n`

  test("a neighbouring file becomes an absolute URL", () => {
    expect(parseSourceMapReference(script("index-9f1.js.map"), "https://app.test/assets/index-9f1.js")).toBe(
      "https://app.test/assets/index-9f1.js.map"
    )
  })

  test("a root-relative reference resolves against the script's origin", () => {
    expect(parseSourceMapReference(script("/maps/index.js.map"), "https://app.test/assets/index-9f1.js")).toBe(
      "https://app.test/maps/index.js.map"
    )
  })

  test("a parent-relative reference resolves against the script's directory", () => {
    expect(parseSourceMapReference(script("../maps/index.js.map"), "https://app.test/assets/index-9f1.js")).toBe(
      "https://app.test/maps/index.js.map"
    )
  })

  test("an absolute reference is kept", () => {
    expect(parseSourceMapReference(script("https://cdn.test/index.js.map"), "https://app.test/assets/index-9f1.js")).toBe(
      "https://cdn.test/index.js.map"
    )
  })

  test("an inline map is kept as its data URL", () => {
    const inline = "data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozfQ=="
    expect(parseSourceMapReference(script(inline), "https://app.test/src/App.tsx")).toBe(inline)
  })

  test("the old @ form is read too", () => {
    expect(parseSourceMapReference("x()\n//@ sourceMappingURL=old.js.map", "https://app.test/assets/x.js")).toBe(
      "https://app.test/assets/old.js.map"
    )
  })

  test("a block comment is read, with and without a space before its end", () => {
    expect(parseSourceMapReference("x()\n/*# sourceMappingURL=a.js.map */", "https://app.test/a.js")).toBe(
      "https://app.test/a.js.map"
    )
    expect(parseSourceMapReference("x()\n/*# sourceMappingURL=b.js.map*/", "https://app.test/a.js")).toBe(
      "https://app.test/b.js.map"
    )
  })

  test("a carriage return does not become part of the URL", () => {
    expect(parseSourceMapReference("x()\r\n//# sourceMappingURL=c.js.map\r\n", "https://app.test/a.js")).toBe(
      "https://app.test/c.js.map"
    )
  })

  test("a script without a reference has none", () => {
    expect(parseSourceMapReference("console.log(1)\n", "https://app.test/assets/index-9f1.js")).toBeNull()
  })

  test("the last reference wins, because that is the one the file ends with", () => {
    const bundled = "//# sourceMappingURL=first.js.map\nmore()\n//# sourceMappingURL=last.js.map\n"
    expect(parseSourceMapReference(bundled, "https://app.test/a.js")).toBe("https://app.test/last.js.map")
  })

  test("a mention outside a comment is not a reference", () => {
    expect(parseSourceMapReference(`const label = "sourceMappingURL=fake.js.map"`, "https://app.test/a.js")).toBeNull()
  })

  test("a script URL the browser cannot parse leaves the reference as written", () => {
    expect(parseSourceMapReference("//# sourceMappingURL=index.js.map", "not-a-url")).toBe("index.js.map")
  })
})

describe("resolveSourceMap", () => {
  test("a generated position becomes an authored file, line and one-based column", () => {
    expect(resolveSourceMap(bundleMap(), at(1, 1, "Card"), MAP_URL)).toEqual({
      file: "https://app.test/src/ui/Card.tsx",
      line: 12,
      column: 5,
      component: "Card",
      precision: "authored"
    })
  })

  test("a later column on the same line finds its own segment", () => {
    expect(resolveSourceMap(bundleMap(), at(1, 11), MAP_URL)).toMatchObject({ line: 12, column: 21 })
  })

  test("a column between two segments takes the segment it sits in", () => {
    expect(resolveSourceMap(bundleMap(), at(1, 8), MAP_URL)).toMatchObject({ line: 12, column: 5 })
  })

  test("a column counted from zero lands on the same first segment as one", () => {
    expect(resolveSourceMap(bundleMap(), at(1, 0), MAP_URL)).toMatchObject({ line: 12, column: 5 })
  })

  test("a generated line with no segments has no authored position", () => {
    expect(resolveSourceMap(bundleMap(), at(2, 1), MAP_URL)).toBeNull()
  })

  test("a generated line past the map has no authored position", () => {
    expect(resolveSourceMap(bundleMap(), at(9, 1), MAP_URL)).toBeNull()
  })

  test("a line below one has no authored position", () => {
    expect(resolveSourceMap(bundleMap(), at(0, 1), MAP_URL)).toBeNull()
  })

  test("a source root is part of the resolved file", () => {
    const map = bundleMap({ sourceRoot: "/src/", sources: ["ui/Card.tsx"] })
    expect(resolveSourceMap(map, at(1, 1), MAP_URL)).toMatchObject({ file: "https://app.test/src/ui/Card.tsx" })
  })

  test("the map's own name is the component when the page named none", () => {
    const map = bundleMap({
      names: ["Card"],
      mappings: encodeMappings([[[0, 0, 11, 4, 0]], []])
    })
    expect(resolveSourceMap(map, at(1, 1), MAP_URL)).toMatchObject({ component: "Card" })
  })

  test("the page's component name wins over the map's name", () => {
    const map = bundleMap({
      names: ["c"],
      mappings: encodeMappings([[[0, 0, 11, 4, 0]], []])
    })
    expect(resolveSourceMap(map, at(1, 1, "Card"), MAP_URL)).toMatchObject({ component: "Card" })
  })

  test("a map given as JSON text is parsed", () => {
    expect(resolveSourceMap(JSON.stringify(bundleMap()), at(1, 1), MAP_URL)).toMatchObject({
      file: "https://app.test/src/ui/Card.tsx",
      line: 12
    })
  })

  test("a map with already decoded mappings works", () => {
    const map = bundleMap({ mappings: [[[0, 0, 11, 4]], []] })
    expect(resolveSourceMap(map, at(1, 1), MAP_URL)).toMatchObject({ line: 12, column: 5 })
  })

  test("an inline map resolves its sources against the script it sits in", () => {
    const inline = "data:application/json;charset=utf-8;base64,e30="
    expect(resolveSourceMap(bundleMap(), at(1, 1), inline)).toMatchObject({
      file: "https://app.test/src/ui/Card.tsx"
    })
  })

  test("an explicit source base wins over both the map URL and the script URL", () => {
    expect(resolveSourceMap(bundleMap(), at(1, 1), MAP_URL, "https://cdn.test/build/out.js")).toMatchObject({
      file: "https://cdn.test/src/ui/Card.tsx"
    })
  })

  test("an inline map on a script with no usable URL keeps its sources as written", () => {
    const inline = "data:application/json;charset=utf-8;base64,e30="
    const noUrl = { url: "", line: 1, column: 1, component: null }
    expect(resolveSourceMap(bundleMap({ sources: ["src/ui/Card.tsx"] }), noUrl, inline)).toMatchObject({
      file: "src/ui/Card.tsx"
    })
  })

  test("a segment that points at a nameless source has no authored position", () => {
    expect(resolveSourceMap(bundleMap({ sources: [null] }), at(1, 1), MAP_URL)).toBeNull()
  })

  test("a malformed map is no position, not a throw", () => {
    expect(resolveSourceMap(null, at(1, 1), MAP_URL)).toBeNull()
    expect(resolveSourceMap(undefined, at(1, 1), MAP_URL)).toBeNull()
    expect(resolveSourceMap({}, at(1, 1), MAP_URL)).toBeNull()
    expect(resolveSourceMap("<!doctype html>", at(1, 1), MAP_URL)).toBeNull()
    expect(resolveSourceMap('{"version":3,', at(1, 1), MAP_URL)).toBeNull()
    expect(resolveSourceMap(bundleMap({ version: 2 }), at(1, 1), MAP_URL)).toBeNull()
    expect(resolveSourceMap(bundleMap({ mappings: 42 }), at(1, 1), MAP_URL)).toBeNull()
    expect(resolveSourceMap(bundleMap({ sources: "one.tsx" }), at(1, 1), MAP_URL)).toBeNull()
    expect(resolveSourceMap(bundleMap({ mappings: "!!!!" }), at(1, 1), MAP_URL)).toBeNull()
  })

  test("a position with no numbers is no position", () => {
    expect(resolveSourceMap(bundleMap(), at(Number.NaN, 1), MAP_URL)).toBeNull()
    expect(resolveSourceMap(bundleMap(), at(1, Number.NaN), MAP_URL)).toMatchObject({ line: 12 })
  })
})

describe("resolveSourceMap: indexed maps", () => {
  const section = (offsetLine: number, source: string, sourceLine: number, sourceColumn: number) => ({
    offset: { line: offsetLine, column: 0 },
    map: {
      version: 3,
      sources: [source],
      names: [],
      mappings: encodeMappings([[[0, 0, sourceLine, sourceColumn]]])
    }
  })

  const indexed = {
    version: 3,
    file: "index-9f1.js",
    sections: [section(0, "../src/ui/Card.tsx", 11, 4), section(1, "../src/ui/List.tsx", 6, 2)]
  }

  test("a position in the first section resolves through it", () => {
    expect(resolveSourceMap(indexed, at(1, 1), MAP_URL)).toEqual({
      file: "https://app.test/src/ui/Card.tsx",
      line: 12,
      column: 5,
      component: null,
      precision: "authored"
    })
  })

  test("a position in a later section resolves through that section", () => {
    expect(resolveSourceMap(indexed, at(2, 1), MAP_URL)).toMatchObject({
      file: "https://app.test/src/ui/List.tsx",
      line: 7,
      column: 3
    })
  })

  test("an indexed map given as JSON text is parsed", () => {
    expect(resolveSourceMap(JSON.stringify(indexed), at(2, 1), MAP_URL)).toMatchObject({
      file: "https://app.test/src/ui/List.tsx",
      line: 7
    })
  })

  test("a section holding a malformed map is no position", () => {
    const broken = { version: 3, sections: [{ offset: { line: 0, column: 0 }, map: { version: 2, sources: [], names: [], mappings: "" } }] }
    expect(resolveSourceMap(broken, at(1, 1), MAP_URL)).toBeNull()
  })

  test("a section with no offset is no position", () => {
    const broken = { version: 3, sections: [{ map: bundleMap() }] }
    expect(resolveSourceMap(broken, at(1, 1), MAP_URL)).toBeNull()
  })

  test("a map with neither mappings nor sections is no position", () => {
    expect(resolveSourceMap({ version: 3, file: "x.js" }, at(1, 1), MAP_URL)).toBeNull()
  })
})

describe("resolveSourceMap: mapping segments the map got wrong", () => {
  const decoded = (segment: ReadonlyArray<number>, extra: Record<string, unknown> = {}) =>
    bundleMap({ mappings: [[segment]], ...extra })

  test("a valid decoded segment still resolves, so the guard is not blanket", () => {
    expect(resolveSourceMap(decoded([0, 0, 11, 4]), at(1, 1), MAP_URL)).toMatchObject({ line: 12, column: 5 })
  })

  test("a negative original line is no position", () => {
    expect(resolveSourceMap(decoded([0, 0, -5, 4]), at(1, 1), MAP_URL)).toBeNull()
  })

  test("a negative original column is no position", () => {
    expect(resolveSourceMap(decoded([0, 0, 11, -4]), at(1, 1), MAP_URL)).toBeNull()
  })

  test("a negative generated column is no position", () => {
    expect(resolveSourceMap(decoded([-1, 0, 11, 4]), at(1, 1), MAP_URL)).toBeNull()
  })

  test("a fractional position is no position", () => {
    expect(resolveSourceMap(decoded([0, 0, 11.5, 4]), at(1, 1), MAP_URL)).toBeNull()
  })

  test("a source index past the sources is no position", () => {
    expect(resolveSourceMap(decoded([0, 3, 11, 4]), at(1, 1), MAP_URL)).toBeNull()
  })

  test("a name index past the names is no position", () => {
    expect(resolveSourceMap(decoded([0, 0, 11, 4, 7]), at(1, 1), MAP_URL)).toBeNull()
  })

  test("a segment of the wrong length is no position", () => {
    expect(resolveSourceMap(decoded([0, 0, 11]), at(1, 1), MAP_URL)).toBeNull()
    expect(resolveSourceMap(decoded([0, 0, 11, 4, 0, 9]), at(1, 1), MAP_URL)).toBeNull()
  })

  test("a segment holding something that is not a number is no position", () => {
    expect(resolveSourceMap(bundleMap({ mappings: [[["0", 0, 11, 4]]] }), at(1, 1), MAP_URL)).toBeNull()
    expect(resolveSourceMap(bundleMap({ mappings: [["nope"]] }), at(1, 1), MAP_URL)).toBeNull()
    expect(resolveSourceMap(bundleMap({ mappings: ["nope"] }), at(1, 1), MAP_URL)).toBeNull()
  })

  test("encoded mappings that decode to a line below one are no position", () => {
    const map = bundleMap({ mappings: encodeMappings([[[0, 0, -5, 4]]]) })
    expect(resolveSourceMap(map, at(1, 1), MAP_URL)).toBeNull()
  })

  test("encoded mappings that decode to a column below zero are no position", () => {
    const map = bundleMap({ mappings: encodeMappings([[[0, 0, 11, -4]]]) })
    expect(resolveSourceMap(map, at(1, 1), MAP_URL)).toBeNull()
  })
})
