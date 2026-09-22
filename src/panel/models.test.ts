import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import {
  AA_SOURCE,
  CursorModelsError,
  cursorModelsFrom,
  loadModels,
  loadCursorModels,
  loadCursorModelsEffect,
  matches,
  modelsFor,
  modelsFrom,
  moneyLine,
  MODELS,
  OPENROUTER_SOURCE,
  priceLine,
  SORTS,
  sortLine,
  sortModels,
  usdPerMillion
} from "./models"

const row = (id: string, name: string, prompt: string, completion: string) => ({
  id,
  name,
  pricing: { prompt, completion },
  benchmarks: id === "moonshotai/kimi-k3" ? { artificial_analysis: { intelligence_index: 43.8, coding_index: 76.2, agentic_index: 50.6 } } : undefined
})

describe("usdPerMillion", () => {
  test("turns a per-token price into a per-million figure, or free, or unknown", () => {
    expect(usdPerMillion("0.000003")).toBe("$3/M")
    expect(usdPerMillion("0.000015")).toBe("$15/M")
    expect(usdPerMillion("0.00000175")).toBe("$1.75/M")
    expect(usdPerMillion("0.000000375")).toBe("$0.375/M")
    expect(usdPerMillion("0")).toBe("free")
    expect(usdPerMillion("nope")).toBe("—")
    expect(usdPerMillion(undefined)).toBe("—")
  })
})

describe("moneyLine", () => {
  test("names input and output money on one line", () => {
    expect(moneyLine("0.000003", "0.000015")).toBe("$3/M in · $15/M out")
    expect(moneyLine("0", "0")).toBe("free in · free out")
    expect(priceLine({ value: "x", label: "X", in: "$3/M", out: "$15/M" })).toBe("$3/M in · $15/M out")
    expect(sortLine({ value: "x", label: "X", in: "$3/M", out: "$15/M", intelligence: 43.8 }, "intelligence")).toBe(
      "43.8 intel · $3/M in · $15/M out"
    )
    expect(sortLine({ value: "x", label: "X", in: "$3/M", out: "$15/M" }, "intelligence")).toBe("$3/M in · $15/M out")
  })
})

describe("modelsFrom", () => {
  test("reads the OpenRouter catalog: short name, money in and out, no batch rows", () => {
    const models = modelsFrom({
      data: [
        row("moonshotai/kimi-k3", "MoonshotAI: Kimi K3", "0.000003", "0.000015"),
        row("openai/gpt-5.2:batch", "OpenAI: GPT-5.2 (batch)", "0.00000175", "0.000014"),
        { id: "", name: "Empty" },
        { name: "No id" },
        row("google/gemini-3.6-flash", "Google: Gemini 3.6 Flash", "0.000000375", "0.000001875"),
        { id: "acme/raw", name: 1, pricing: {} }
      ]
    })
    expect(models.map((m) => m.value)).toEqual(["moonshotai/kimi-k3", "google/gemini-3.6-flash", "acme/raw"])
    expect(models[0]).toEqual({
      value: "moonshotai/kimi-k3",
      label: "Kimi K3",
      in: "$3/M",
      out: "$15/M",
      intelligence: 43.8,
      coding: 76.2,
      agentic: 50.6,
      promptPerM: 3,
      completionPerM: 15
    })
    expect(models[1]?.in).toBe("$0.375/M")
    expect(models[1]?.out).toBe("$1.875/M")
    expect(models[1]?.promptPerM).toBe(0.375)
    expect(models[2]).toEqual({ value: "acme/raw", label: "acme/raw", in: "—", out: "—" })
  })

  test("an empty or junk payload is no models", () => {
    expect(modelsFrom(null)).toEqual([])
    expect(modelsFrom({})).toEqual([])
    expect(modelsFrom({ data: "nope" })).toEqual([])
  })
})

describe("matches", () => {
  const kimi = { value: "moonshotai/kimi-k3", label: "Kimi K3", in: "$3/M", out: "$15/M" }
  test("empty query keeps every model; text matches id or label", () => {
    expect(matches(kimi, "")).toBe(true)
    expect(matches(kimi, "kimi")).toBe(true)
    expect(matches(kimi, "MOONSHOT")).toBe(true)
    expect(matches(kimi, "gpt")).toBe(false)
  })
})

describe("modelsFor", () => {
  test("keeps the stored model when the catalog does not have it", () => {
    expect(modelsFor("openai/gpt-5.2").map((m) => m.value)).toContain("openai/gpt-5.2")
    expect(modelsFor("acme/custom", MODELS).at(-1)).toEqual({ value: "acme/custom", label: "acme/custom", in: "—", out: "—" })
    expect(modelsFor("", MODELS)).toEqual(MODELS)
  })
})

describe("SORTS", () => {
  test("names the source for scores and for prices", () => {
    expect(SORTS.find((sort) => sort.key === "intelligence")?.source).toEqual(AA_SOURCE)
    expect(SORTS.find((sort) => sort.key === "coding")?.source).toEqual(AA_SOURCE)
    expect(SORTS.find((sort) => sort.key === "in")?.source).toEqual(OPENROUTER_SOURCE)
    expect(SORTS.find((sort) => sort.key === "name")?.source).toBeUndefined()
  })
})

describe("sortModels", () => {
  const cheap = { value: "cheap", label: "Cheap", in: "$0.1/M", out: "$0.2/M", intelligence: 10, coding: 90, agentic: 20, promptPerM: 0.1, completionPerM: 0.2 }
  const smart = { value: "smart", label: "Smart", in: "$5/M", out: "$15/M", intelligence: 50, coding: 40, agentic: 10, promptPerM: 5, completionPerM: 15 }
  const bare = { value: "bare", label: "Bare", in: "—", out: "—" }

  test("intelligence, coding, and agentic put the high score first; a missing score sits last", () => {
    expect(sortModels([cheap, smart, bare], "intelligence").map((model) => model.value)).toEqual(["smart", "cheap", "bare"])
    expect(sortModels([cheap, smart, bare], "coding").map((model) => model.value)).toEqual(["cheap", "smart", "bare"])
    expect(sortModels([cheap, smart, bare], "agentic").map((model) => model.value)).toEqual(["cheap", "smart", "bare"])
  })

  test("price in and price out put the cheap model first; name is A to Z", () => {
    expect(sortModels([smart, cheap, bare], "in").map((model) => model.value)).toEqual(["cheap", "smart", "bare"])
    expect(sortModels([smart, cheap, bare], "out").map((model) => model.value)).toEqual(["cheap", "smart", "bare"])
    expect(sortModels([smart, cheap, bare], "name").map((model) => model.value)).toEqual(["bare", "cheap", "smart"])
  })
})

describe("loadModels", () => {
  test("decodes a live payload and falls back when the request fails or is empty", async () => {
    const payload = { data: [row("x-ai/grok-4.5", "SpaceXAI: Grok 4.5", "0.000002", "0.000006")] }
    const ok = await loadModels(async () => new Response(JSON.stringify(payload), { status: 200 }))
    expect(ok).toEqual([{ value: "x-ai/grok-4.5", label: "Grok 4.5", in: "$2/M", out: "$6/M", promptPerM: 2, completionPerM: 6 }])

    expect(await loadModels(async () => new Response("{}", { status: 200 }))).toEqual(MODELS)
    expect(await loadModels(async () => new Response("no", { status: 500 }))).toEqual(MODELS)
    expect(await loadModels(async () => Promise.reject(new Error("offline")))).toEqual(MODELS)
  })
})

describe("loadCursorModels", () => {
  test("trims the key at the API boundary and reads Cursor's official models response", async () => {
    let seenInput: Parameters<typeof fetch>[0] | undefined
    let seenInit: Parameters<typeof fetch>[1] | undefined
    const models = await loadCursorModels("  cursor-key  ", async (input, init) => {
      seenInput = input
      seenInit = init
      return new Response(JSON.stringify({ items: [{ id: "composer-2", displayName: "Composer 2" }] }), { status: 200 })
    })

    expect(seenInput).toBe("https://api.cursor.com/v1/models")
    expect(new Headers(seenInit?.headers).get("Authorization")).toBe("Bearer cursor-key")
    expect(models).toEqual([{ value: "composer-2", label: "Composer 2", in: "—", out: "—" }])
  })

  test("reports an empty key and a Cursor 401 reason", async () => {
    expect(loadCursorModels("", async () => new Response("{}"))).rejects.toThrow("Enter a Cursor API key.")
    expect(
      loadCursorModels("bad", async () => new Response(JSON.stringify({ message: "API key is invalid or expired" }), { status: 401 }))
    ).rejects.toThrow("API key is invalid or expired")
    expect(loadCursorModels("key", async () => new Response(JSON.stringify({ models: [] }), { status: 200 }))).rejects.toThrow(
      "Cursor returned an unexpected models response."
    )
  })

  test("keeps API failures typed inside the Effect boundary", async () => {
    const failure = await Effect.runPromise(Effect.flip(loadCursorModelsEffect("", async () => new Response("{}"))))
    expect(failure).toBeInstanceOf(CursorModelsError)
    expect(failure._tag).toBe("CursorModelsError")
  })
})

describe("cursorModelsFrom", () => {
  test("drops malformed Cursor rows and falls back to the id for a missing display name", () => {
    expect(cursorModelsFrom({ items: [{ id: "gpt-5", displayName: "GPT-5" }, { id: "auto-smart" }, { displayName: "No id" }] })).toEqual([
      { value: "gpt-5", label: "GPT-5", in: "—", out: "—" },
      { value: "auto-smart", label: "auto-smart", in: "—", out: "—" }
    ])
  })
})
