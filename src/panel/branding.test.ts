import { expect, test } from "bun:test"
import packageJson from "../../package.json"
import wxtConfig from "../../wxt.config"
import { MORPH_LOGO } from "@/brand/morph"

const iconSizes = [16, 32, 48, 128] as const
const manifest = wxtConfig.manifest as chrome.runtime.Manifest

const pngSize = async (path: string): Promise<readonly [number, number]> => {
  const bytes = await Bun.file(new URL(`../../public/${path}`, import.meta.url)).arrayBuffer()
  const view = new DataView(bytes)
  return [view.getUint32(16), view.getUint32(20)]
}

test("the extension ships as Morph with complete icon assets", async () => {
  expect(packageJson.name).toBe("morph")
  expect(manifest.name).toBe("Morph")
  expect(manifest.action.default_title).toBe("Open Morph")

  for (const size of iconSizes) {
    const path = manifest.icons?.[size]
    expect(path).toBe(`icons/morph-${size}.png`)
    if (path === undefined) throw new Error(`missing ${size}px Morph icon`)
    expect(await pngSize(path)).toEqual([size, size])
    expect((manifest.action.default_icon as Record<number, string> | undefined)?.[size]).toBe(path)
  }

  const mark = await Bun.file(new URL("../../public/brand/morph-mark.svg", import.meta.url)).text()
  expect(mark).toContain(">Morph</title>")
  for (const { name, color } of MORPH_LOGO) {
    expect(mark).toContain(`data-shape="${name}"`)
    expect(mark).toContain(`fill="${color}"`)
  }
  expect(mark.match(/data-stripe-eyes/g)?.length).toBe(4)
  expect(await Bun.file(new URL("../entrypoints/panel/index.html", import.meta.url)).text()).toContain("<title>Morph</title>")
  expect(await Bun.file(new URL("../../design-system.html", import.meta.url)).text()).toContain("<title>Morph Interface System</title>")
})
