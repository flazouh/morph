import { afterEach, expect, test } from "bun:test"
import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { marketplaceWeb } from "./web"

const root = join(import.meta.dir, ".web-test")

afterEach(() => rm(root, { recursive: true, force: true }))

test("the marketplace routes serve the app while assets keep immutable cache headers", async () => {
  await mkdir(join(root, "assets"), { recursive: true })
  await Promise.all([
    Bun.write(join(root, "marketplace.html"), "<main>Morphs</main>"),
    Bun.write(join(root, "assets/app.js"), "export {}")
  ])
  const web = marketplaceWeb(root)

  for (const path of ["/", "/marketplace", "/marketplace/device?user_code=ABCD-EFGH"]) {
    const response = await web(new Request(`https://test${path}`))
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("<main>Morphs</main>")
    expect(response.headers.get("cache-control")).toBe("no-cache")
  }
  const asset = await web(new Request("https://test/assets/app.js"))
  expect(await asset.text()).toBe("export {}")
  expect(asset.headers.get("cache-control")).toContain("immutable")
  expect((await web(new Request("https://test/%2e%2e/package.json"))).status).toBe(404)
})
