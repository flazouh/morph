import { afterEach, beforeEach, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { act } from "react"
import { pageSourceOf } from "../agent/page-package"
import { skinFilesOf } from "../marketplace/compiler/page"
import { compileSkin, extrasOf, type Icons, type Sheets } from "../skin/compile"
import { createKit, type Kit } from "./mount"
import { skinScript, type SkinBody } from "./skin-script"

/**
 * A package that carries several pages, run the way a reader's page runs it: the real
 * compiler over the generated entry, then the real kit. The entry chooses by pathname, so
 * this is the one test that proves a two-page release shows each reader their own page.
 * Runs under the panel's happy-dom setup (`bun run test:panel`).
 */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")

const icons: Icons = () => import("@hugeicons/core-free-icons")

const sheets: Sheets = {
  "tailwindcss/theme.css": read("../../node_modules/tailwindcss/theme.css"),
  "tailwindcss/preflight.css": read("../../node_modules/tailwindcss/preflight.css"),
  "tailwindcss/utilities.css": read("../../node_modules/tailwindcss/utilities.css"),
  "theme.css": read("../styles/theme.css"),
  "shadow.css": read("../styles/shadow.css")
}

const bodyOf = (js: string): SkinBody => {
  const script = skinScript(js, "")
  const head = "function (require, exports, module) {"
  return new Function("require", "exports", "module", script.slice(script.indexOf(head) + head.length, script.lastIndexOf("}, "))) as SkinBody
}

const two = {
  "/": { skin: { "page.tsx": `export default () => <main className="p-4">the home page</main>` } },
  "/login": {
    skin: {
      "page.tsx": `import { Card } from "./Card"\nexport const target = "#app"\nexport default () => <Card />`,
      "Card.tsx": `export const Card = () => <main className="p-2">the login page</main>`
    }
  }
}

let kit: Kit
beforeEach(() => {
  document.body.innerHTML = `<div id="app">the page itself</div>`
  kit = createKit(new CSSStyleSheet())
})
afterEach(() => {
  document.body.innerHTML = ""
})

/** happy-dom's own handle on the window, the one way to move the test to another URL. */
const browser = (): { readonly setURL: (url: string) => void } =>
  (globalThis as unknown as { readonly happyDOM: { readonly setURL: (url: string) => void } }).happyDOM

/** Renders the package the way the page would, from `path`. */
const at = async (path: string): Promise<Element> => {
  browser().setURL(`https://f5bot.com${path}`)
  const built = pageSourceOf(two, undefined)
  if (built === undefined) throw new Error("the package did not build")
  const out = await compileSkin(skinFilesOf(built.source), sheets, icons)
  let host: Element | undefined
  act(() => {
    host = kit.skin(bodyOf(out.js), out.css, extrasOf(out))
  })
  return host as Element
}

test("one package renders the home page to a reader on /", async () => {
  const host = await at("/")
  expect(host.shadowRoot?.querySelector("main")?.textContent).toBe("the home page")
})

test("the same package renders the login page to a reader on /login", async () => {
  const host = await at("/login")
  expect(host.shadowRoot?.querySelector("main")?.textContent).toBe("the login page")
})

test("the page's own target comes along, so the skin still replaces its region", async () => {
  await at("/login")
  expect(document.querySelector<HTMLElement>("#app")?.style.display).toBe("none")
})

test("a reader on a path the package does not cover sees the page it already had", async () => {
  const host = await at("/pricing")
  expect(host.shadowRoot?.querySelector("main")).toBeNull()
  expect(document.querySelector<HTMLElement>("#app")?.style.display).not.toBe("none")
})
