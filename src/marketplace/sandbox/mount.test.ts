import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mountSandbox, type SandboxMount } from "./mount"

const options = (parent: Element): SandboxMount => ({
  parent,
  sandboxUrl: "about:blank",
  manifest: {
    slug: "morph/test",
    permissions: {
      page: { read: [], navigate: [], traverse: false },
      network: [],
      storage: false,
      secureForms: []
    }
  },
  ports: {
    read: () => Effect.die("unused"),
    fetch: () => Effect.die("unused"),
    navigate: () => Effect.die("unused"),
    traverse: () => Effect.die("unused"),
    context: () => Effect.die("unused"),
    restore: () => Effect.die("unused"),
    loadAsset: () => Effect.die("unused"),
    storage: {
      get: () => Effect.die("unused"),
      set: () => Effect.die("unused")
    },
    secureSubmit: () => Effect.die("unused")
  },
  code: ""
})

describe("sandbox mount", () => {
  test("owns the frame for the lifetime of its Effect scope", async () => {
    const parent = document.createElement("div")
    document.body.append(parent)

    const host = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const mounted = yield* mountSandbox(options(parent))
          expect(parent.contains(mounted.host)).toBe(true)
          expect(mounted.frame.getAttribute("sandbox")).toBe("allow-scripts")
          expect(mounted.frame.src).toStartWith("about:blank#")
          return mounted.host
        })
      )
    )

    expect(parent.contains(host)).toBe(false)
    parent.remove()
  })

  test("hands the package its stylesheet in the init, where the guest can reach it", async () => {
    const parent = document.createElement("div")
    document.body.append(parent)

    const init = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const mounted = yield* mountSandbox({
            ...options(parent),
            code: "return require('effect').Effect.void",
            css: ":root{color:red}"
          })
          const guest = mounted.frame.contentWindow
          const sent: Array<unknown> = []
          if (guest !== null) guest.postMessage = (message: unknown) => sent.push(message)

          yield* Effect.sync(() =>
            window.dispatchEvent(
              new MessageEvent("message", { data: { type: "morph:ready" }, origin: "null", source: guest })
            )
          )
          yield* Effect.sleep(25)
          return sent[0]
        })
      )
    )

    expect(init).toMatchObject({ type: "morph:init", code: "return require('effect').Effect.void", css: ":root{color:red}" })
    parent.remove()
  })
})
