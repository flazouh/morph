import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { makePageContext, makePageNavigate, makePageTraverse, pageContextOf } from "./page-ports"

describe("page capability ports", () => {
  test("reads viewer, colour mode, and route from the GitHub document", () => {
    document.documentElement.setAttribute("data-color-mode", "dark")
    const login = document.createElement("meta")
    login.setAttribute("name", "user-login")
    login.setAttribute("content", "flazouh")
    document.head.append(login)

    const face = document.createElement("img")
    face.className = "avatar-user"
    face.setAttribute("src", "https://avatars.githubusercontent.com/u/1?v=4")
    document.body.append(face)

    expect(pageContextOf(document, { pathname: "/pulls/inbox" })).toEqual({
      signedIn: true,
      login: "flazouh",
      faceUrl: "https://avatars.githubusercontent.com/u/1?v=4",
      colorMode: "dark",
      path: "/pulls/inbox"
    })

    face.remove()
    login.remove()
    document.documentElement.removeAttribute("data-color-mode")
  })

  test("hands over GitHub's own choice, and calls anything else auto", () => {
    const modeUnder = (mode: string | null) => {
      if (mode === null) document.documentElement.removeAttribute("data-color-mode")
      else document.documentElement.setAttribute("data-color-mode", mode)
      const found = pageContextOf(document, { pathname: "/pulls" }).colorMode
      document.documentElement.removeAttribute("data-color-mode")
      return found
    }

    expect(modeUnder("dark")).toBe("dark")
    expect(modeUnder("light")).toBe("light")
    // The package resolves this one against the machine, which only its own frame can hear.
    expect(modeUnder("auto")).toBe("auto")
    // A page that carries no choice, and one that carries a word GitHub never writes.
    expect(modeUnder(null)).toBe("auto")
    expect(modeUnder("dark_dimmed_beta")).toBe("auto")
  })

  test("navigates in the same tab by default", async () => {
    const assigned: Array<string> = []
    const view = {
      open: () => null,
      location: {
        assign: (url: string) => {
          assigned.push(url)
        }
      }
    } as unknown as Window
    await Effect.runPromise(makePageNavigate(view)("https://github.com/pulls", "_self"))
    expect(assigned).toEqual(["https://github.com/pulls"])
  })

  test("walks the page's own history, which the package's frame may not", async () => {
    const steps: Array<number> = []
    const view = { history: { go: (delta: number) => steps.push(delta) } } as unknown as Window
    await Effect.runPromise(makePageTraverse(view)(-1))
    await Effect.runPromise(makePageTraverse(view)(2))
    expect(steps).toEqual([-1, 2])
  })

  test("builds a context port from the live document", async () => {
    const context = await Effect.runPromise(makePageContext(document, { pathname: "/pulls" })())
    expect(context.path).toBe("/pulls")
    expect(context.colorMode).toBe("auto")
  })
})
