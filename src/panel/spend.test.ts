import { describe, expect, test } from "bun:test"
import { spendDetail, spendLabel } from "./spend"

const openRouter = {
  provider: "openrouter" as const,
  usd: 0,
  promptTokens: 0,
  completionTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  priced: 0
}

describe("spendLabel", () => {
  test("nothing spent: no label", () => {
    expect(spendLabel(openRouter)).toBe("")
  })
  test("priced: three decimals under ten cents, two above; a free attempt reads as zero", () => {
    expect(spendLabel({ ...openRouter, usd: 0.0042, promptTokens: 1, completionTokens: 1, priced: 1 })).toBe("$0.004")
    expect(spendLabel({ ...openRouter, usd: 0.1234, promptTokens: 1, completionTokens: 1, priced: 3 })).toBe("$0.12")
    expect(spendLabel({ ...openRouter, promptTokens: 1, completionTokens: 1, priced: 1 })).toBe("$0.000")
  })
  test("tokens but no price: the token count stands in", () => {
    expect(spendLabel({ ...openRouter, promptTokens: 800, completionTokens: 50 })).toBe("850 tok")
    expect(spendLabel({ ...openRouter, promptTokens: 3100, completionTokens: 420 })).toBe("3.5k tok")
    expect(spendLabel({ ...openRouter, promptTokens: 120_000, completionTokens: 4000 })).toBe("124k tok")
  })
  test("Cursor shows all four token classes and never a dollar figure", () => {
    const spend = {
      provider: "cursor" as const,
      usd: 0,
      promptTokens: 12_480,
      completionTokens: 3_110,
      cacheReadTokens: 42_600,
      cacheWriteTokens: 18_200,
      priced: 0
    }
    expect(spendLabel({ ...spend, totalTokens: 76_390 })).toBe("76k tok")
    expect(spendLabel({ ...spend, totalTokens: 76_390 })).not.toContain("$")
  })
  test("Cursor's own total is the figure, not Morph's sum of the classes", () => {
    const spend = {
      provider: "cursor" as const,
      usd: 0,
      promptTokens: 12_480,
      completionTokens: 3_110,
      cacheReadTokens: 42_600,
      cacheWriteTokens: 18_200,
      // Cursor counts a cache read differently from a fresh input token, so its total is
      // its own number. Morph shows what Cursor bills, not what Morph adds up.
      totalTokens: 20_000,
      priced: 0
    }
    expect(spendLabel(spend)).toBe("20k tok")
  })
  test("a Cursor spend stored before the total was kept still shows a figure", () => {
    expect(
      spendLabel({
        provider: "cursor",
        usd: 0,
        promptTokens: 12_480,
        completionTokens: 3_110,
        cacheReadTokens: 42_600,
        cacheWriteTokens: 18_200,
        priced: 0
      })
    ).toBe("76k tok")
  })
})

describe("spendDetail", () => {
  test("keeps the OpenRouter token and dollar line unchanged", () => {
    expect(spendDetail({ ...openRouter, usd: 0.0042, promptTokens: 3100, completionTokens: 420, priced: 2 })).toBe("3,100 in · 420 out · $0.0042 billed by OpenRouter")
    expect(spendDetail({ ...openRouter, promptTokens: 10, completionTokens: 2 })).toBe("10 in · 2 out · not priced")
  })

  test("Cursor names input, output, cache read and cache write tokens without a dollar figure", () => {
    const detail = spendDetail({
      provider: "cursor",
      usd: 0,
      promptTokens: 12_480,
      completionTokens: 3_110,
      cacheReadTokens: 42_600,
      cacheWriteTokens: 18_200,
      priced: 0
    })
    expect(detail).toBe("Cursor · 12,480 in · 3,110 out · 42,600 cache read · 18,200 cache write")
    expect(detail).not.toContain("$")
  })
})
