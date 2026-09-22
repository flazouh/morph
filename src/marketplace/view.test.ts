import { describe, expect, test } from "bun:test"
import { parseDeclarativeView } from "./view"

const validView = {
  schema: 1,
  target: "#hnmain",
  sources: [
    {
      id: "stories",
      selector: ".athing",
      many: true,
      fields: {
        title: { selector: ".titleline > a", read: "text" },
        href: { selector: ".titleline > a", read: "attribute", attribute: "href" }
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
      { tag: "h1", text: "Hacker News" },
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

describe("parseDeclarativeView", () => {
  test("accepts selectors, safe text reads, and a bounded element tree", () => {
    expect(parseDeclarativeView(validView)).toEqual(validView)
  })

  test("rejects reads of form values and other sensitive attributes", () => {
    expect(() =>
      parseDeclarativeView({
        ...validView,
        sources: [
          {
            ...validView.sources[0],
            fields: {
              secret: { selector: "input[name=token]", read: "attribute", attribute: "value" }
            }
          }
        ]
      })
    ).toThrow('attribute "value" is not readable')
  })

  test("rejects active and form elements", () => {
    for (const tag of ["script", "iframe", "form", "input"]) {
      expect(() =>
        parseDeclarativeView({
          ...validView,
          root: { tag }
        })
      ).toThrow(`tag ${JSON.stringify(tag)} is not allowed`)
    }
  })

  test("rejects bindings outside their declared repeat source", () => {
    expect(() =>
      parseDeclarativeView({
        ...validView,
        root: {
          tag: "main",
          children: [{ tag: "p", text: { field: "title" } }]
        }
      })
    ).toThrow('field binding "title" must be inside a repeat')
  })

  test("rejects unknown fields in a repeat", () => {
    expect(() =>
      parseDeclarativeView({
        ...validView,
        root: {
          tag: "main",
          children: [
            {
              each: "stories",
              template: { tag: "p", text: { field: "score" } }
            }
          ]
        }
      })
    ).toThrow('source "stories" has no field "score"')
  })

  test("rejects unsafe, unsupported, and unknown style rules", () => {
    expect(() =>
      parseDeclarativeView({
        ...validView,
        styles: { page: { backgroundImage: "url(https://attacker.test/pixel)" } }
      })
    ).toThrow('style property "backgroundImage" is not allowed')

    expect(() =>
      parseDeclarativeView({
        ...validView,
        styles: { page: { color: "url(https://attacker.test/pixel)" } }
      })
    ).toThrow("styles.page.color contains unsafe CSS")

    expect(() =>
      parseDeclarativeView({
        ...validView,
        root: { tag: "main", className: "missing" }
      })
    ).toThrow('style "missing" is not declared')
  })
})
