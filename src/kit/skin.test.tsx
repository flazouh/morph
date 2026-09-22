import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { act } from "react"
import { compileSkin, extrasOf, type Icons, type Sheets, type SkinFiles } from "../skin/compile"
import { createKit, type Kit } from "./mount"
import { skinScript, type SkinBody } from "./skin-script"

/**
 * The compiler-to-kit seam, end to end: the real compiler's output, evaluated the way the
 * page evaluates it, handed to the real kit. Every other skin test stops on one side of
 * that seam, and a guard that refused correct modules once lived in the gap.
 * Runs under the panel's happy-dom setup (`bun run test:panel`).
 */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")

/** The real set, from the package: the extension's binding fetches it as a build asset. */
const icons: Icons = () => import("@hugeicons/core-free-icons")

const sheets: Sheets = {
  "tailwindcss/theme.css": read("../../node_modules/tailwindcss/theme.css"),
  "tailwindcss/preflight.css": read("../../node_modules/tailwindcss/preflight.css"),
  "tailwindcss/utilities.css": read("../../node_modules/tailwindcss/utilities.css"),
  "theme.css": read("../styles/theme.css"),
  "shadow.css": read("../styles/shadow.css")
}

let kit: Kit
beforeEach(() => {
  document.body.innerHTML = `<div id="app" style="display: flex"><a href="/x">x</a></div><p id="p">p</p>`
  kit = createKit(new CSSStyleSheet())
})
afterEach(() => {
  document.body.innerHTML = ""
})

/** The page's side of the seam: the script text becomes the function the kit is called with. */
const bodyOf = (js: string): SkinBody => {
  const script = skinScript(js, "")
  const open = script.indexOf("function (require, exports, module) {") + "function (require, exports, module) {".length
  const close = script.lastIndexOf("}, ")
  return new Function("require", "exports", "module", script.slice(open, close)) as SkinBody
}

const apply = async (tsx: string | SkinFiles): Promise<Element> => {
  const out = await compileSkin(typeof tsx === "string" ? { "page.tsx": tsx } : tsx, sheets, icons)
  let host: Element | undefined
  act(() => {
    host = kit.skin(bodyOf(out.js), out.css, extrasOf(out))
  })
  return host as Element
}

describe("a compiled skin through the kit", () => {
  test("export default function", async () => {
    const host = await apply(`export default function Skin() { return <main className="p-4">one</main> }`)
    expect(host.shadowRoot?.querySelector("main")?.textContent).toBe("one")
  })

  test("export default <expression>, the shape sucrase writes with a space", async () => {
    const host = await apply(`export default () => <main>two</main>`)
    expect(host.shadowRoot?.querySelector("main")?.textContent).toBe("two")
  })

  test("a named component exported as default, with a React default import", async () => {
    const host = await apply(`import React from "react"\nconst C = () => React.createElement("main", null, "three")\nexport default C`)
    expect(host.shadowRoot?.querySelector("main")?.textContent).toBe("three")
  })

  test("a beui import and a hook", async () => {
    const host = await apply(`import { useState } from "react"\nimport { Button } from "beui"\nexport const target = "#app"\nexport default function Skin() { const [n] = useState(4); return <Button>{n}</Button> }`)
    expect(host.shadowRoot?.querySelector("button")?.textContent).toBe("4")
    expect(host.nextElementSibling?.id).toBe("app")
  })

  test("a project: the page renders a component from another file, and the target from the entry holds", async () => {
    const host = await apply({
      "page.tsx": `import { Row } from "./components/Row"\nexport const target = "#app"\nexport default () => <main>{["x", "y"].map((t) => <Row key={t} text={t} />)}</main>`,
      "components/Row.tsx": `export const Row = ({ text }: { text: string }) => <p className="p-4">{text}</p>`
    })
    expect(host.shadowRoot?.querySelectorAll("p")).toHaveLength(2)
    expect(host.shadowRoot?.textContent).toBe("xy")
    expect(getComputedStyle(document.getElementById("app") as HTMLElement).display).toBe("none")
  })

  test("a Hugeicon: the component from the kit, the icon inlined by the compiler, an svg in the shadow root", async () => {
    const host = await apply(`import { HugeiconsIcon } from "@hugeicons/react"\nimport { Search01Icon } from "@hugeicons/core-free-icons"\nexport default () => <HugeiconsIcon icon={Search01Icon} size={16} strokeWidth={1.5} />`)
    const svg = host.shadowRoot?.querySelector("svg")
    expect(svg?.getAttribute("width")).toBe("16")
    expect(svg?.querySelector("path")).not.toBeNull()
  })

  test("module.exports = C is honoured", async () => {
    const host = await apply(`const C = () => <main>five</main>\nmodule.exports = C`)
    expect(host.shadowRoot?.querySelector("main")?.textContent).toBe("five")
  })

  test("a module without a component is refused where the exports are in hand, with the sentence the model needs", async () => {
    await expect(apply(`export const target = "#app"`)).rejects.toThrow("default export")
  })
})

describe("hiding the target", () => {
  const body: SkinBody = (_req, exports) => {
    exports["target"] = "#app"
    exports["default"] = () => null
  }

  test("an author display rule on the target does not keep it on screen", () => {
    act(() => void kit.skin(body, ""))
    const app = document.getElementById("app") as HTMLElement
    expect(getComputedStyle(app).display).toBe("none")
    expect(app.style.getPropertyPriority("display")).toBe("important")
  })

  test("unskin removes the host and gives the target its own display back", () => {
    act(() => void kit.skin(body, ""))
    act(() => kit.unskin())
    expect(document.querySelector('[data-beui="Skin"]')).toBeNull()
    expect((document.getElementById("app") as HTMLElement).style.display).toBe("flex")
    // And a skin after that starts fresh.
    act(() => void kit.skin(body, ""))
    expect(document.querySelectorAll('[data-beui="Skin"]')).toHaveLength(1)
  })

  test("re-skinning onto another target gives the first its display back", () => {
    act(() => void kit.skin(body, ""))
    act(() => void kit.skin((_req, exports) => void (exports["default"] = () => null), ""))
    expect((document.getElementById("app") as HTMLElement).style.display).toBe("flex")
  })

  // Gmail sizes its nav with script: hidden, it measured 0px and wrote that inline. Nothing
  // but a resize makes it measure again, so letting a target go tells the page the window resized.
  test("giving the target back tells the page the window resized", () => {
    const resizes: Event[] = []
    window.addEventListener("resize", (event) => resizes.push(event))
    act(() => void kit.skin(body, ""))
    expect(resizes).toHaveLength(0)
    act(() => kit.unskin())
    expect(resizes).toHaveLength(1)
    act(() => void kit.skin(body, ""))
    act(() => void kit.skin((_req, exports) => void (exports["default"] = () => null), ""))
    expect(resizes).toHaveLength(2)
  })

  test("unskin with a full-page skin has no target to give back and sends no resize", () => {
    const resizes: Event[] = []
    window.addEventListener("resize", (event) => resizes.push(event))
    act(() => void kit.skin((_req, exports) => void (exports["default"] = () => null), ""))
    act(() => kit.unskin())
    expect(resizes).toHaveLength(0)
  })

  test("unskin with no skin is a no-op", () => {
    expect(() => kit.unskin()).not.toThrow()
  })
})
