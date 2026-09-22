import { describe, expect, test } from "bun:test"
import { Window } from "happy-dom"
import { probeSource } from "./source"

/** Framework metadata is untyped on the page, so the fixtures write it untyped too. */
type Meta = Record<string, any>

const page = (html: string) => {
  const window = new Window({ url: "https://app.test/dashboard" })
  window.document.body.innerHTML = html
  const doc = window.document as unknown as Document
  return { doc, pick: (selector: string) => doc.querySelector(selector) as unknown as Meta }
}

/** `probeSource` reads the page's own `document` off `globalThis`, as `chrome.scripting`
 * runs it. A test installs the fixture document there for the span of one call. */
const withDocument = <T>(doc: Document, fn: () => T): T => {
  const holder = globalThis as { document?: Document }
  const before = holder.document
  holder.document = doc
  try {
    return fn()
  } finally {
    if (before === undefined) delete holder.document
    else holder.document = before
  }
}

/** The one-argument contract every call site uses: install the page, then probe it. */
const probeIn = (doc: Document, selector: string): ReturnType<typeof probeSource> =>
  withDocument(doc, () => probeSource(selector))

/** React puts the fiber on the node under a key with a random suffix. */
const withFiber = (element: Meta, fiber: Meta): void => {
  element["__reactFiber$k91xj"] = fiber
}

const stackOf = (...frames: ReadonlyArray<string>): string => ["Error: react-stack-top-frame", ...frames].join("\n")

/** React captures the JSX call site as an Error and reads its `stack`, so the fixture sets that. */
const capturedStack = (stack: string): Error => {
  const error = new Error("react-stack-top-frame")
  error.stack = stack
  return error
}

describe("probeSource: React 18", () => {
  test("_debugSource on the host fiber is an authored location with the owner's name", () => {
    const { doc, pick } = page(`<button id="save">Save</button>`)
    withFiber(pick("#save"), {
      _debugSource: { fileName: "/src/ui/Save.tsx", lineNumber: 12, columnNumber: 5 },
      _debugOwner: { type: { name: "SaveButton" } }
    })

    expect(probeIn(doc, "#save")).toEqual({
      kind: "resolved",
      source: { file: "/src/ui/Save.tsx", line: 12, column: 5, component: "SaveButton", precision: "authored" }
    })
  })

  test("a host fiber without its own _debugSource takes the owner's", () => {
    const { doc, pick } = page(`<span id="label">x</span>`)
    withFiber(pick("#label"), {
      _debugOwner: {
        type: { displayName: "Label" },
        _debugSource: { fileName: "/src/ui/Label.tsx", lineNumber: 3, columnNumber: 1 }
      }
    })

    expect(probeIn(doc, "#label")).toEqual({
      kind: "resolved",
      source: { file: "/src/ui/Label.tsx", line: 3, column: 1, component: "Label", precision: "authored" }
    })
  })

  test("a component name comes from the fiber tree when no owner names one", () => {
    const { doc, pick } = page(`<div id="row">x</div>`)
    withFiber(pick("#row"), {
      _debugSource: { fileName: "/src/Row.tsx", lineNumber: 8, columnNumber: 2 },
      return: { type: { name: "Row" } }
    })

    expect(probeIn(doc, "#row")).toMatchObject({ kind: "resolved", source: { component: "Row" } })
  })

  test("a line that is not a number is dropped, and the file is kept", () => {
    const { doc, pick } = page(`<div id="odd">x</div>`)
    withFiber(pick("#odd"), { _debugSource: { fileName: "/src/Odd.tsx", lineNumber: "?", columnNumber: null } })

    expect(probeIn(doc, "#odd")).toEqual({
      kind: "resolved",
      source: { file: "/src/Odd.tsx", line: null, column: null, component: null, precision: "authored" }
    })
  })

  test("a fiber with no source metadata at all is no location", () => {
    const { doc, pick } = page(`<div id="bare">x</div>`)
    withFiber(pick("#bare"), { type: "div", return: null })

    expect(probeIn(doc, "#bare")).toEqual({ kind: "none" })
  })
})

describe("probeSource: React 19", () => {
  test("_debugStack gives a generated bundle position, never an authored line", () => {
    const { doc, pick } = page(`<article id="card">x</article>`)
    withFiber(pick("#card"), {
      _debugStack: capturedStack(
        stackOf(
          "    at jsxDEV (http://localhost:5173/node_modules/.vite/deps/react_jsx-dev-runtime.js:250:19)",
          "    at Card (http://localhost:5173/src/ui/Card.tsx?t=1757:41:32)",
          "    at App (http://localhost:5173/src/App.tsx:9:11)"
        )
      ),
      _debugOwner: { name: "Card" }
    })

    expect(probeIn(doc, "#card")).toEqual({
      kind: "generated",
      source: { url: "http://localhost:5173/src/ui/Card.tsx?t=1757", line: 41, column: 32, component: "Card" }
    })
  })

  test("_debugStack as a plain string works, and the frame names the component", () => {
    const { doc, pick } = page(`<article id="card">x</article>`)
    withFiber(pick("#card"), {
      _debugStack: stackOf("    at Card (https://app.test/assets/index-9f1.js:2:14812)")
    })

    expect(probeIn(doc, "#card")).toEqual({
      kind: "generated",
      source: { url: "https://app.test/assets/index-9f1.js", line: 2, column: 14812, component: "Card" }
    })
  })

  test("a Firefox stack is read too", () => {
    const { doc, pick } = page(`<article id="card">x</article>`)
    withFiber(pick("#card"), {
      _debugStack: { stack: "Card@https://app.test/assets/index-9f1.js:2:14812\n" }
    })

    expect(probeIn(doc, "#card")).toMatchObject({
      kind: "generated",
      source: { url: "https://app.test/assets/index-9f1.js", line: 2, column: 14812 }
    })
  })

  test("a stack of nothing but React internals is no location", () => {
    const { doc, pick } = page(`<article id="card">x</article>`)
    withFiber(pick("#card"), {
      _debugStack: capturedStack(
        stackOf(
          "    at jsxDEV (http://localhost:5173/node_modules/.vite/deps/react_jsx-dev-runtime.js:250:19)",
          "    at renderWithHooks (http://localhost:5173/node_modules/.vite/deps/react-dom_client.js:11548:26)",
          "    at <anonymous>"
        )
      )
    })

    expect(probeIn(doc, "#card")).toEqual({ kind: "none" })
  })

  test("React served from a CDN is skipped by its file name, not by node_modules", () => {
    const { doc, pick } = page(`<article id="card">x</article>`)
    withFiber(pick("#card"), {
      _debugStack: capturedStack(
        stackOf(
          "    at y (https://unpkg.com/react@19/cjs/react-jsx-dev-runtime.development.js:320:11)",
          "    at Card (https://app.test/app.js:2:88)"
        )
      )
    })

    expect(probeIn(doc, "#card")).toMatchObject({ kind: "generated", source: { url: "https://app.test/app.js" } })
  })

  test("React DOM served from a CDN is skipped by its file name", () => {
    const { doc, pick } = page(`<article id="card">x</article>`)
    withFiber(pick("#card"), {
      _debugStack: capturedStack(
        stackOf(
          "    at ta (https://unpkg.com/react-dom@19/cjs/react-dom.development.js:11548:26)",
          "    at Card (https://app.test/app.js:2:88)"
        )
      )
    })

    expect(probeIn(doc, "#card")).toMatchObject({ kind: "generated", source: { url: "https://app.test/app.js" } })
  })

  test("an app file in a directory named react is the answer, not a React internal", () => {
    const { doc, pick } = page(`<article id="card">x</article>`)
    withFiber(pick("#card"), {
      _debugStack: capturedStack(stackOf("    at Card (http://localhost:5173/src/react/Card.tsx:12:7)"))
    })

    expect(probeIn(doc, "#card")).toEqual({
      kind: "generated",
      source: { url: "http://localhost:5173/src/react/Card.tsx", line: 12, column: 7, component: "Card" }
    })
  })

  test("an app function named jsx or createElement is the answer, not a React internal", () => {
    const { doc, pick } = page(`<article id="card">x</article>`)
    const first = pick("#card")
    withFiber(first, {
      _debugStack: capturedStack(stackOf("    at jsx (http://localhost:5173/src/ui/render.ts:4:9)"))
    })
    expect(probeIn(doc, "#card")).toMatchObject({
      kind: "generated",
      source: { url: "http://localhost:5173/src/ui/render.ts", line: 4, column: 9 }
    })

    const { doc: other, pick: pickOther } = page(`<article id="card">x</article>`)
    withFiber(pickOther("#card"), {
      _debugStack: capturedStack(stackOf("    at createElement (http://localhost:5173/src/ui/dom.ts:8:3)"))
    })
    expect(probeIn(other, "#card")).toMatchObject({
      kind: "generated",
      source: { url: "http://localhost:5173/src/ui/dom.ts", line: 8, column: 3 }
    })
  })

  test("the stack of the nearest owner is used when the host fiber carries none", () => {
    const { doc, pick } = page(`<article id="card">x</article>`)
    withFiber(pick("#card"), {
      _debugOwner: {
        name: "Card",
        _debugStack: stackOf("    at Card (https://app.test/assets/index-9f1.js:2:88)")
      }
    })

    expect(probeIn(doc, "#card")).toMatchObject({ kind: "generated", source: { line: 2, column: 88, component: "Card" } })
  })
})

describe("probeSource: Vue", () => {
  test("the inspector attribute is an authored file, line and column", () => {
    const { doc } = page(`<div id="hero" data-v-inspector="src/components/Hero.vue:14:3">x</div>`)

    expect(probeIn(doc, "#hero")).toEqual({
      kind: "resolved",
      source: { file: "src/components/Hero.vue", line: 14, column: 3, component: null, precision: "authored" }
    })
  })

  test("the inspector marker on the node property carries the component instance name", () => {
    const { doc, pick } = page(`<div id="hero">x</div>`)
    const element = pick("#hero")
    element.__v_inspector = "src/components/Hero.vue:14:3"
    element.__vueParentComponent = { type: { __name: "Hero", __file: "/repo/src/components/Hero.vue" } }

    expect(probeIn(doc, "#hero")).toEqual({
      kind: "resolved",
      source: { file: "src/components/Hero.vue", line: 14, column: 3, component: "Hero", precision: "authored" }
    })
  })

  test("__vueParentComponent alone gives the authored file with no position", () => {
    const { doc, pick } = page(`<div id="hero">x</div>`)
    pick("#hero").__vueParentComponent = { type: { name: "Hero", __file: "/repo/src/components/Hero.vue" } }

    expect(probeIn(doc, "#hero")).toEqual({
      kind: "resolved",
      source: { file: "/repo/src/components/Hero.vue", line: null, column: null, component: "Hero", precision: "authored" }
    })
  })

  test("a vnode prop marker is read when neither the attribute nor the property is there", () => {
    const { doc, pick } = page(`<div id="hero">x</div>`)
    pick("#hero").__vueParentComponent = {
      type: { __name: "Hero" },
      vnode: { props: { "data-v-inspector": "src/components/Hero.vue:9" } }
    }

    expect(probeIn(doc, "#hero")).toEqual({
      kind: "resolved",
      source: { file: "src/components/Hero.vue", line: 9, column: null, component: "Hero", precision: "authored" }
    })
  })
})

describe("probeSource: Svelte", () => {
  test("__svelte_meta.loc is authored, and its zero-based column becomes one-based", () => {
    const { doc, pick } = page(`<p id="note">x</p>`)
    pick("#note").__svelte_meta = { loc: { file: "src/lib/Note.svelte", line: 4, column: 2, char: 87 } }

    expect(probeIn(doc, "#note")).toEqual({
      kind: "resolved",
      source: { file: "src/lib/Note.svelte", line: 4, column: 3, component: null, precision: "authored" }
    })
  })

  test("a loc without a column keeps the line and says nothing about the column", () => {
    const { doc, pick } = page(`<p id="note">x</p>`)
    pick("#note").__svelte_meta = { loc: { file: "src/lib/Note.svelte", line: 4, char: 87 } }

    expect(probeIn(doc, "#note")).toEqual({
      kind: "resolved",
      source: { file: "src/lib/Note.svelte", line: 4, column: null, component: null, precision: "authored" }
    })
  })
})

describe("probeSource: Astro and generic metadata", () => {
  test("the Astro attributes are an authored location", () => {
    const { doc } = page(
      `<section id="hero" data-astro-source-file="/repo/src/pages/index.astro" data-astro-source-loc="7:2">x</section>`
    )

    expect(probeIn(doc, "#hero")).toEqual({
      kind: "resolved",
      source: { file: "/repo/src/pages/index.astro", line: 7, column: 2, component: null, precision: "authored" }
    })
  })

  test("an Astro file with no loc keeps the file", () => {
    const { doc } = page(`<section id="hero" data-astro-source-file="/repo/src/pages/index.astro">x</section>`)

    expect(probeIn(doc, "#hero")).toMatchObject({
      kind: "resolved",
      source: { file: "/repo/src/pages/index.astro", line: null, column: null }
    })
  })

  test("generic data-source attributes are an authored location", () => {
    const { doc } = page(`<i id="mark" data-source-file="src/Mark.ts" data-source-line="21" data-source-column="6"></i>`)

    expect(probeIn(doc, "#mark")).toEqual({
      kind: "resolved",
      source: { file: "src/Mark.ts", line: 21, column: 6, component: null, precision: "authored" }
    })
  })

  test("react-dev-inspector data attributes are an authored location", () => {
    const { doc } = page(
      `<i id="mark" data-inspector-relative-path="src/Mark.tsx" data-inspector-line="21" data-inspector-column="6"></i>`
    )

    expect(probeIn(doc, "#mark")).toMatchObject({
      kind: "resolved",
      source: { file: "src/Mark.tsx", line: 21, column: 6, precision: "authored" }
    })
  })
})

describe("probeSource: no metadata and order", () => {
  test("a page with no framework metadata is no location", () => {
    const { doc } = page(`<div id="plain"><span>x</span></div>`)

    expect(probeIn(doc, "#plain")).toEqual({ kind: "none" })
  })

  test("a selector that matches nothing is no location", () => {
    const { doc } = page(`<div id="plain">x</div>`)

    expect(probeIn(doc, "#missing")).toEqual({ kind: "none" })
  })

  test("a selector the browser refuses is no location, not a throw", () => {
    const { doc } = page(`<div id="plain">x</div>`)

    expect(probeIn(doc, ":::")).toEqual({ kind: "none" })
  })

  test("React metadata wins over a generic data attribute on the same element", () => {
    const { doc, pick } = page(`<div id="both" data-source-file="src/Generic.ts" data-source-line="1"></div>`)
    withFiber(pick("#both"), { _debugSource: { fileName: "/src/Both.tsx", lineNumber: 2, columnNumber: 3 } })

    expect(probeIn(doc, "#both")).toMatchObject({ kind: "resolved", source: { file: "/src/Both.tsx" } })
  })

  test("the nearest annotated ancestor answers when the picked element carries nothing", () => {
    const { doc } = page(
      `<section data-astro-source-file="/repo/src/pages/index.astro" data-astro-source-loc="7:2"><b id="deep">x</b></section>`
    )

    expect(probeIn(doc, "#deep")).toMatchObject({
      kind: "resolved",
      source: { file: "/repo/src/pages/index.astro", line: 7 }
    })
  })

  test("the picked element wins over an annotated ancestor", () => {
    const { doc, pick } = page(
      `<section data-astro-source-file="/repo/src/pages/index.astro" data-astro-source-loc="7:2"><b id="deep">x</b></section>`
    )
    pick("#deep").__svelte_meta = { loc: { file: "src/lib/Deep.svelte", line: 1, column: 0 } }

    expect(probeIn(doc, "#deep")).toMatchObject({ kind: "resolved", source: { file: "src/lib/Deep.svelte" } })
  })
})

describe("probeSource: runs as page source", () => {
  test("it works after a round trip through its own source text, as chrome.scripting sends it", () => {
    const isolated = new Function(`"use strict"; return (${probeSource.toString()})`)() as typeof probeSource
    const { doc, pick } = page(`<p id="note">x</p>`)
    pick("#note").__svelte_meta = { loc: { file: "src/lib/Note.svelte", line: 4, column: 2 } }

    expect(withDocument(doc, () => isolated("#note"))).toEqual({
      kind: "resolved",
      source: { file: "src/lib/Note.svelte", line: 4, column: 3, component: null, precision: "authored" }
    })
  })

  test("one argument is the selector, so executeScript can pass it through args", () => {
    const { doc } = page(`<i id="astro" data-astro-source-file="src/pages/index.astro" data-astro-source-loc="7:2"></i>`)
    expect(probeIn(doc, "#astro")).toMatchObject({
      kind: "resolved",
      source: { file: "src/pages/index.astro", line: 7, column: 2 }
    })
  })
})
