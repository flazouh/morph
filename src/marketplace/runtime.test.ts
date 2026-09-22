import { afterEach, describe, expect, test } from "bun:test"
import { applyDeclarativeView, renderDeclarativeView } from "./runtime"

const view = {
  schema: 1,
  target: "#original",
  sources: [
    {
      id: "stories",
      selector: ".story",
      many: true,
      fields: {
        title: { selector: ".title", read: "text" },
        href: { selector: ".title", read: "attribute", attribute: "href" }
      }
    }
  ],
  styles: {
    page: { maxWidth: "720px", margin: "0 auto" },
    story: { display: "grid", gap: "8px" }
  },
  root: {
    tag: "main",
    className: "page",
    children: [
      {
        each: "stories",
        template: {
          tag: "article",
          className: "story",
          children: [
            {
              tag: "a",
              attributes: { href: { field: "href" } },
              text: { field: "title" }
            }
          ]
        }
      }
    ]
  }
} as const

afterEach(() => {
  document.body.replaceChildren()
})

describe("declarative redesign runtime", () => {
  test("renders repeated page text and safe links without package code", () => {
    document.body.innerHTML = `
      <div class="story"><a class="title" href="/one">One</a></div>
      <div class="story"><a class="title" href="javascript:alert(1)">Unsafe</a></div>
    `

    const root = renderDeclarativeView(view, document)
    const links = root.querySelectorAll("a")
    expect([...links].map((link) => link.textContent)).toEqual(["One", "Unsafe"])
    expect([...links].map((link) => link.getAttribute("href"))).toEqual(["/one", null])
    expect(root.style.maxWidth).toBe("720px")
    expect(root.querySelector<HTMLElement>("article")?.style.display).toBe("grid")
  })

  test("apply hides the original region and undo restores its prior state", () => {
    document.body.innerHTML = `
      <div class="story"><a class="title" href="/one">One</a></div>
      <section id="original">Original</section>
    `
    const original = document.querySelector<HTMLElement>("#original")!
    const undo = applyDeclarativeView(view, document)

    expect(original.hidden).toBe(true)
    const host = original.previousElementSibling
    expect(host?.tagName).toBe("REDESIGN-VIEW")
    expect(host?.shadowRoot?.querySelector("main.page")).not.toBeNull()

    undo()
    expect(original.hidden).toBe(false)
    expect(document.querySelector("redesign-view")).toBeNull()
  })

  test("undo preserves an original region that was already hidden", () => {
    document.body.innerHTML = '<section id="original" hidden>Original</section>'
    const original = document.querySelector<HTMLElement>("#original")!

    applyDeclarativeView(view, document)()
    expect(original.hidden).toBe(true)
  })
})
