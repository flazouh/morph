import { describe, expect, test } from "bun:test"
import type { CompiledPackage } from "../compiler/compile"
import { PackageCompileError } from "../compiler/error"
import type { PackageSource } from "../compiler/source"
import { HIDE_REDESIGN, pageScopeOf, preparePageRelease, showRedesign, type PageReleasePorts, type PageTab } from "./page-release"

const skin: PackageSource = { entry: "page.tsx", style: "style.css", files: { "page.tsx": "export default () => null", "style.css": "body{}" } }
const script: PackageSource = { entry: "page.js", style: "style.css", files: { "page.js": "document.title = 'x'", "style.css": "" } }

const compiled = (source: PackageSource): CompiledPackage => ({
  compiler: "test",
  script: source.entry === "page.js" ? source.files["page.js"] ?? "" : "window.__beui.skin(function(){}, '', {})",
  style: source.files["style.css"] ?? "",
  sources: Object.fromEntries(Object.keys(source.files).map((path) => [path, `sha256:${path}`])),
  artifacts: { script: "sha256:script", css: "sha256:css" }
})

const world = (tab: Partial<PageTab> = {}, wears = true) => {
  const log: string[] = []
  // Numbered by their own order, so a new port in the flow never renumbers the pictures.
  let captures = 0
  const ports: PageReleasePorts = {
    tab: async () => ({ url: "https://example.com/inbox?tab=2", active: true, windowId: 7, ...tab }),
    wears: async (url) => {
      log.push(`wears:${new URL(url).pathname}`)
      return wears
    },
    compile: async (source) => {
      log.push("compile")
      return compiled(source)
    },
    execute: async (_tabId, code) => {
      log.push(code === HIDE_REDESIGN ? "hide" : code.includes("__beui.skin") ? "show+skin" : "show")
    },
    capture: async (windowId) => {
      log.push(`capture:${windowId}`)
      captures += 1
      return `png-${captures}`
    },
    preview: async (png) => ({ data: `webp:${png}`, digest: `sha256:${png}` }),
    withChatHidden: async (_tabId, action) => {
      log.push("chat:hide")
      try {
        return await action()
      } finally {
        log.push("chat:show")
      }
    }
  }
  return { ports, log }
}

describe("preparePageRelease", () => {
  test("compiles, pictures after then before with the chat hidden, and puts the redesign back", async () => {
    const { ports, log } = world()
    const { release, previews } = await preparePageRelease(ports, 12, skin)
    expect(log).toEqual(["wears:/inbox", "compile", "chat:hide", "capture:7", "hide", "capture:7", "show+skin", "chat:show"])
    expect(release.scope).toEqual({ kind: "page", origin: "https://example.com", paths: ["/inbox"] })
    expect(release.source).toEqual(skin)
    expect(release.compiled).toEqual({ sources: compiled(skin).sources, artifacts: compiled(skin).artifacts })
    // The first picture is the page as it is: the after. The second is the page undressed: the before.
    expect(previews.after.data).toBe("webp:png-1")
    expect(previews.before.data).toBe("webp:png-2")
  })

  test("a page that no longer wears the redesign is refused, so no release pictures a bare page", async () => {
    const { ports, log } = world({}, false)
    await expect(preparePageRelease(ports, 12, skin)).rejects.toThrow(
      "this page no longer wears the redesign; apply it again before publishing"
    )
    expect(log).toEqual(["wears:/inbox"])
  })

  test("a page.js package is shown again without re-running its script", async () => {
    const { ports, log } = world()
    await preparePageRelease(ports, 12, script)
    expect(log).toContain("show")
    expect(log).not.toContain("show+skin")
  })

  test("the redesign goes back on even when the before picture fails", async () => {
    const { ports, log } = world()
    let captures = 0
    const failing: PageReleasePorts = {
      ...ports,
      capture: async () => {
        captures += 1
        if (captures === 2) throw new Error("the window went away")
        return "png"
      }
    }
    await expect(preparePageRelease(failing, 12, skin)).rejects.toThrow("the window went away")
    expect(log.slice(-3)).toEqual(["hide", "show+skin", "chat:show"])
  })

  test("a tab that is not in front is refused before anything changes on the page", async () => {
    const { ports, log } = world({ active: false })
    await expect(preparePageRelease(ports, 12, skin)).rejects.toThrow("keep the Morph page active")
    expect(log).toEqual([])
  })

  test("a source that fails the page contract is refused before the compile", async () => {
    const { ports, log } = world()
    await expect(preparePageRelease(ports, 12, { ...skin, files: { "page.tsx": "" } })).rejects.toBeInstanceOf(PackageCompileError)
    expect(log).toEqual([])
  })
})

describe("the page scripts", () => {
  test("hiding disables both redesign sheets and unmounts the skin", () => {
    expect(HIDE_REDESIGN).toContain('"redesign-design","redesign-styles"')
    expect(HIDE_REDESIGN).toContain("sheet.disabled = true")
    expect(HIDE_REDESIGN).toContain("window.__beui?.unskin?.()")
  })

  test("showing re-enables the sheets, and re-runs the skin script only for a skin", () => {
    expect(showRedesign(skin, compiled(skin))).toContain(compiled(skin).script)
    expect(showRedesign(script, compiled(script))).not.toContain("document.title")
    expect(showRedesign(script, compiled(script))).toContain("sheet.disabled = false")
  })

  test("the scope is the origin and the path, without the query", () => {
    expect(pageScopeOf("https://news.ycombinator.com/news?p=2")).toEqual({ kind: "page", origin: "https://news.ycombinator.com", paths: ["/news"] })
  })
})
