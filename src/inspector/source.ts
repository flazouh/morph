import type { SourceLocation } from "./model"

/**
 * Where an element came from, as the page itself can say.
 *
 * A dev build leaves a trail: React writes the JSX call site on the fiber, Vue and Svelte
 * write the component file on the node, Astro writes it in attributes. Each trail has a
 * different shape and a different truth. A file and a line a person typed is `authored`.
 * A line inside the script the browser ran is not, so it comes back as a `GeneratedSource`
 * and stays that until a source map turns it into an authored line.
 */

/**
 * A position inside a script the browser loaded: a built bundle, or a dev server's
 * transform of one source file. It is never presented as an authored line.
 */
export interface GeneratedSource {
  readonly url: string
  /** One-based, as a stack frame counts lines. */
  readonly line: number
  /** One-based, as a stack frame counts columns. */
  readonly column: number
  readonly component: string | null
}

export type SourceProbe =
  | { readonly kind: "resolved"; readonly source: SourceLocation }
  | { readonly kind: "generated"; readonly source: GeneratedSource }
  | { readonly kind: "none" }

/** Framework internals carry no types. Every read of one is guarded at runtime. */
type Meta = any

/**
 * The one function that runs on the page. It takes a selector and gives back the first
 * source the element or its nearest annotated ancestor exposes, in the order React, Vue,
 * Svelte, Astro, generic `data-*`.
 *
 * It travels to the page as its own source text, so it is self-contained in the way
 * `bridge/loader.ts` describes: no import, no closure over this module, every helper
 * inside its own body. Chrome sends it with
 * `chrome.scripting.executeScript({ target, world: "MAIN", func: probeSource, args: [selector] })`,
 * and that call can pass only the selector, so this reads the page's own `document` off
 * `globalThis` instead of taking it as a parameter. A test that needs a different
 * document installs it on `globalThis` for the span of the call.
 *
 * Columns come back one-based. React 18 already counts from one, Svelte counts from zero
 * and is moved by one, and Astro is taken as it is written.
 */
export function probeSource(selector: string): SourceProbe {
  const doc = globalThis.document
  const query = selector
  const none: SourceProbe = { kind: "none" }
  if (doc === null || doc === undefined || query === "") return none
  let picked: Element | null = null
  try {
    picked = doc.querySelector(query)
  } catch {
    return none
  }
  if (picked === null) return none

  const text = (value: unknown): string | null =>
    typeof value === "string" && value.trim() !== "" ? value.trim() : null

  const count = (value: unknown): number | null => {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.trunc(value)
    if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim())
    return null
  }

  const resolved = (file: string, line: number | null, column: number | null, component: string | null): SourceProbe => ({
    kind: "resolved",
    source: { file, line, column, component, precision: "authored" }
  })

  /** `src/App.vue:14:3`, `src/App.vue:14`, or a bare path. */
  const positionOf = (value: string): { readonly file: string; readonly line: number | null; readonly column: number | null } => {
    const both = /^(.+):(\d+):(\d+)$/.exec(value)
    if (both !== null && both[1] !== undefined) return { file: both[1], line: count(both[2]), column: count(both[3]) }
    const one = /^(.+):(\d+)$/.exec(value)
    if (one !== null && one[1] !== undefined) return { file: one[1], line: count(one[2]), column: null }
    return { file: value, line: null, column: null }
  }

  /** A component type is a function, a class, or a wrapper around one. A tag name is not. */
  const nameOf = (type: Meta, depth: number): string | null => {
    if (type === null || type === undefined || depth > 3) return null
    if (typeof type !== "function" && typeof type !== "object") return null
    return (
      text(type.displayName) ??
      text(type.name) ??
      text(type.__name) ??
      nameOf(type.render, depth + 1) ??
      nameOf(type.type, depth + 1)
    )
  }

  /** The first answer from the picked fiber and the fibers that own it, above it. */
  const firstUp = <T>(fiber: Meta, read: (fiber: Meta, hops: number) => T | null): T | null => {
    let current: Meta = fiber
    for (let hops = 0; current !== null && current !== undefined && hops < 30; hops += 1) {
      const found = read(current, hops)
      if (found !== null) return found
      current = current._debugOwner ?? current.return
    }
    return null
  }

  /**
   * A frame belongs to the React runtime, not to the page. Only a clear sign counts: a
   * dependency directory, or a file whose own name is a React runtime file. A directory
   * called `react` is not a sign, because `src/react/Card.tsx` is a page's own file, and
   * neither is a function called `jsx` or `createElement`, which a page may define. The
   * names kept below are React's own dev factories and belong to no page.
   */
  const isReactInternal = (url: string, name: string | null): boolean => {
    const path = url.split("?")[0]?.split("#")[0] ?? ""
    const file = path.slice(path.lastIndexOf("/") + 1)
    return (
      url.includes("/node_modules/") ||
      file.startsWith("react.") ||
      file.startsWith("react-dom") ||
      file.startsWith("react_") ||
      file.includes("react-jsx") ||
      file.includes("jsx-runtime") ||
      file.includes("jsx-dev-runtime") ||
      name === "jsxDEV" ||
      name === "jsxDEVImpl" ||
      name === "Object.jsxDEV" ||
      name === "jsxWithValidation" ||
      name === "jsxWithValidationDynamic" ||
      name === "jsxWithValidationStatic" ||
      name === "createElementWithValidation" ||
      name === "React.createElement"
    )
  }

  /** The first frame of a captured stack that belongs to the page and not to React. */
  const frameOf = (
    value: Meta
  ): { readonly name: string | null; readonly url: string; readonly line: number; readonly column: number } | null => {
    const stack =
      typeof value === "string"
        ? value
        : value !== null && value !== undefined && typeof value.stack === "string"
          ? (value.stack as string)
          : null
    if (stack === null) return null
    for (const raw of stack.split("\n")) {
      const frame = raw.trim()
      if (frame === "") continue
      const named = /^at\s+(.+?)\s+\((.+):(\d+):(\d+)\)$/.exec(frame)
      // The empty group keeps the group numbers of all three forms the same.
      const bare = named === null ? /^at\s+()(.+):(\d+):(\d+)$/.exec(frame) : null
      const firefox = named === null && bare === null ? /^(.*?)@(.+):(\d+):(\d+)$/.exec(frame) : null
      const match = named ?? bare ?? firefox
      if (match === null) continue
      const url = match[2]
      const line = count(match[3])
      const column = count(match[4])
      if (url === undefined || line === null || column === null) continue
      if (/\s/.test(url) || !(url.includes("://") || url.startsWith("/"))) continue
      const name = text(match[1])
      if (isReactInternal(url, name)) continue
      return { name, url, line, column }
    }
    return null
  }

  const reactSource = (node: Meta): SourceProbe | null => {
    let fiber: Meta = null
    for (const key of Object.keys(node)) {
      if (key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$")) {
        fiber = node[key]
        break
      }
    }
    if (fiber === null || fiber === undefined) return null
    const component = firstUp<string>(fiber, (owned, hops) => {
      const owner: Meta = owned._debugOwner
      // React 19 names the owner directly; React 18 names its element type.
      const named = owner === null || owner === undefined ? null : text(owner.name) ?? nameOf(owner.type, 0)
      return named ?? (hops > 0 ? nameOf(owned.type, 0) : null)
    })
    // React 18 wrote the authored position of the JSX onto the fiber.
    const authored = firstUp<SourceProbe>(fiber, (owned) => {
      const debug: Meta = owned._debugSource
      const file = debug === null || debug === undefined ? null : text(debug.fileName)
      return file === null ? null : resolved(file, count(debug.lineNumber), count(debug.columnNumber), component)
    })
    if (authored !== null) return authored
    // React 19 dropped it and kept the JSX call site in a captured stack instead. A stack
    // frame points into the script the browser ran, so it is a generated position.
    return firstUp<SourceProbe>(fiber, (owned) => {
      const frame = frameOf(owned._debugStack)
      return frame === null
        ? null
        : {
            kind: "generated",
            source: { url: frame.url, line: frame.line, column: frame.column, component: component ?? frame.name }
          }
    })
  }

  const vueSource = (node: Meta): SourceProbe | null => {
    const instance: Meta = node.__vueParentComponent ?? node.__vnode?.component
    const type: Meta = instance === null || instance === undefined ? null : instance.type
    const component = type === null || type === undefined ? null : text(type.__name) ?? text(type.name) ?? text(type.displayName)
    // vite-plugin-vue-inspector writes the authored line; the SFC compiler writes only the file.
    const marker =
      text(node.getAttribute?.("data-v-inspector")) ??
      text(node.__v_inspector) ??
      (instance === null || instance === undefined ? null : text(instance.vnode?.props?.["data-v-inspector"]))
    if (marker !== null) {
      const at = positionOf(marker)
      return resolved(at.file, at.line, at.column, component)
    }
    const file = type === null || type === undefined ? null : text(type.__file)
    return file === null ? null : resolved(file, null, null, component)
  }

  const svelteSource = (node: Meta): SourceProbe | null => {
    const loc: Meta = node.__svelte_meta?.loc
    const file = loc === null || loc === undefined ? null : text(loc.file)
    if (file === null) return null
    const column = count(loc.column)
    // Svelte counts columns from zero.
    return resolved(file, count(loc.line), column === null ? null : column + 1, null)
  }

  const astroSource = (node: Meta): SourceProbe | null => {
    const file = text(node.getAttribute?.("data-astro-source-file"))
    if (file === null) return null
    const loc = text(node.getAttribute?.("data-astro-source-loc"))
    const parts = loc === null ? [] : loc.split(":")
    return resolved(file, count(parts[0]), count(parts[1]), null)
  }

  const dataSource = (node: Meta): SourceProbe | null => {
    const attribute = (name: string): string | null => text(node.getAttribute?.(name))
    const file = attribute("data-source-file") ?? attribute("data-inspector-relative-path") ?? attribute("data-inspector-file")
    if (file === null) return null
    const line = count(attribute("data-source-line") ?? attribute("data-inspector-line"))
    const column = count(attribute("data-source-column") ?? attribute("data-inspector-column"))
    return resolved(file, line, column, null)
  }

  let node: Element | null = picked
  for (let depth = 0; node !== null && depth < 200; depth += 1) {
    try {
      const found = reactSource(node) ?? vueSource(node) ?? svelteSource(node) ?? astroSource(node) ?? dataSource(node)
      if (found !== null) return found
    } catch {
      // A page's own metadata can throw from a getter. The next element up is still worth a look.
    }
    node = node.parentElement
  }
  return none
}
