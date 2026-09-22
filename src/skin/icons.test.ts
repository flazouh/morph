import { describe, expect, test } from "bun:test"
import { packIconSet } from "./icon-codec"
import { iconsFrom, type Load } from "./icons"

const SET = { Search01Icon: [["path", { d: "M17 17L21 21", stroke: "currentColor", strokeLinecap: "round", strokeLinejoin: "round", strokeWidth: "1.5", key: "0" }]] }
const PACKED = packIconSet(SET)

/** A fetch that answers every call the same way and counts them. */
const answering = (respond: () => Response | Promise<Response>) => {
  const calls: Array<string> = []
  const load: Load = (url) => {
    calls.push(url)
    return Promise.resolve(respond())
  }
  return { calls, load }
}

describe("the icon set as a fetched asset", () => {
  test("loads the packed set once from the asset's URL, unpacks it, and answers every later call from memory", async () => {
    const { calls, load } = answering(() => Response.json(PACKED))
    const icons = iconsFrom(() => "chrome-extension://x/hugeicons.json", load)
    expect(await icons()).toEqual(SET)
    expect(await icons()).toEqual(SET)
    expect(calls).toEqual(["chrome-extension://x/hugeicons.json"])
  })

  test("a response that is not the set fails by URL and status, and the next call tries again", async () => {
    let status = 404
    const { calls, load } = answering(() => (status === 200 ? Response.json(PACKED) : new Response("", { status })))
    const icons = iconsFrom(() => "chrome-extension://x/hugeicons.json", load)
    await expect(icons()).rejects.toThrow("the icon set at chrome-extension://x/hugeicons.json did not load: HTTP 404")
    status = 200
    expect(await icons()).toEqual(SET)
    expect(calls).toHaveLength(2)
  })

  test("a body that is not a packed set fails by URL", async () => {
    const { load } = answering(() => Response.json(SET))
    const icons = iconsFrom(() => "chrome-extension://x/hugeicons.json", load)
    await expect(icons()).rejects.toThrow("the icon set at chrome-extension://x/hugeicons.json is not a packed icon set")
  })
})
