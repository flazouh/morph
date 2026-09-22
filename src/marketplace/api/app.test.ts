import { expect, test } from "bun:test"
import { marketplaceApp } from "./app"

test("the API sends auth and releases before catalog routes, then serves the web app", async () => {
  const calls: string[] = []
  const app = marketplaceApp({
    auth: async (request) => {
      calls.push(`auth:${new URL(request.url).pathname}`)
      return new URL(request.url).pathname.startsWith("/v1/auth/")
        ? Response.json({ route: "auth" })
        : null
    },
    releases: async (request) => {
      calls.push(`release:${new URL(request.url).pathname}`)
      return new URL(request.url).pathname.startsWith("/v1/releases")
        ? Response.json({ route: "release" })
        : null
    },
    catalog: async () => Response.json({ route: "catalog" }),
    web: async () => new Response("web")
  })

  expect(await (await app(new Request("https://test/v1/auth/device"))).json()).toEqual({ route: "auth" })
  expect(await (await app(new Request("https://test/v1/releases"))).json()).toEqual({ route: "release" })
  expect(await (await app(new Request("https://test/v1/packages"))).json()).toEqual({ route: "catalog" })
  expect(await (await app(new Request("https://test/marketplace"))).text()).toBe("web")
  expect(calls).toEqual([
    "auth:/v1/auth/device",
    "auth:/v1/releases",
    "release:/v1/releases",
    "auth:/v1/packages",
    "release:/v1/packages",
    "auth:/marketplace",
    "release:/marketplace"
  ])
})
