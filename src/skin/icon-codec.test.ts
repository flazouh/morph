import { describe, expect, test } from "bun:test"
import { packIconSet, unpackIconSet } from "./icon-codec"

describe("the icon set codec", () => {
  test("packing leaves out the shared stroke attributes and the index key, shares each path once, and unpacking puts it all back exactly", () => {
    const set = {
      Search01Icon: [
        ["path", { d: "M17 17L21 21", stroke: "currentColor", strokeLinecap: "round", strokeLinejoin: "round", strokeWidth: "1.5", key: "0" }],
        ["circle", { cx: "11", cy: "11", r: "8", stroke: "currentColor", strokeWidth: "1.5", key: "1" }]
      ],
      Search02Icon: [["path", { d: "M17 17L21 21", stroke: "red", strokeWidth: "2", key: "k" }]]
    }
    const packed = packIconSet(set)
    expect(packed.d).toEqual(["M17 17L21 21"])
    expect(packed.icons["Search01Icon"]).toEqual([
      ["path", { d: 0 }],
      ["circle", { cx: "11", cy: "11", r: "8", strokeLinecap: null, strokeLinejoin: null }]
    ])
    expect(packed.icons["Search02Icon"]).toEqual([["path", { d: 0, stroke: "red", strokeWidth: "2", key: "k", strokeLinecap: null, strokeLinejoin: null }]])
    expect(unpackIconSet(packed)).toEqual(set)
  })

  test("an export that is not a list of elements is not an icon and is left out", () => {
    expect(packIconSet({ default: {}, version: "1", Search01Icon: [["path", { d: "M1 1", key: "0" }]] })).toEqual({
      d: ["M1 1"],
      icons: { Search01Icon: [["path", { d: 0, stroke: null, strokeLinecap: null, strokeLinejoin: null, strokeWidth: null }]] }
    })
  })

  test("the real free set survives the round trip, and packing takes at least two thirds off", async () => {
    const set = await import("@hugeicons/core-free-icons")
    const plain = Object.fromEntries(Object.entries(set))
    const packed = packIconSet(plain)
    expect(Object.keys(packed.icons).length).toBeGreaterThan(4000)
    expect(unpackIconSet(packed)).toEqual(plain)
    expect(JSON.stringify(packed).length).toBeLessThan(JSON.stringify(plain).length / 3)
  })
})
