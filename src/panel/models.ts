import { Effect, Option, Schema } from "effect"

/** A model the composer can pick, with OpenRouter's input and output price and Artificial Analysis scores. */
export interface CatalogModel {
  readonly value: string
  readonly label: string
  readonly in: string
  readonly out: string
  readonly intelligence?: number
  readonly coding?: number
  readonly agentic?: number
  readonly promptPerM?: number
  readonly completionPerM?: number
}

export type SortKey = "intelligence" | "coding" | "agentic" | "in" | "out" | "name"

export interface Source {
  readonly name: string
  readonly href: string
}

export const AA_SOURCE: Source = {
  name: "Artificial Analysis",
  href: "https://artificialanalysis.ai/leaderboards/models"
}

export const OPENROUTER_SOURCE: Source = {
  name: "OpenRouter",
  href: "https://openrouter.ai/models"
}

export const SORTS: ReadonlyArray<{ readonly key: SortKey; readonly label: string; readonly source?: Source }> = [
  { key: "intelligence", label: "Intelligence", source: AA_SOURCE },
  { key: "coding", label: "Coding", source: AA_SOURCE },
  { key: "agentic", label: "Agentic", source: AA_SOURCE },
  { key: "in", label: "Price in", source: OPENROUTER_SOURCE },
  { key: "out", label: "Price out", source: OPENROUTER_SOURCE },
  { key: "name", label: "Name" }
]

const CATALOG = "https://openrouter.ai/api/v1/models?supported_parameters=tools"
const CURSOR_CATALOG = "https://api.cursor.com/v1/models"

type Fetch = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>

/** OpenRouter models the composer offers until the live catalog lands. The stored value may sit outside this list. */
export const MODELS: ReadonlyArray<CatalogModel> = [
  { value: "moonshotai/kimi-k3", label: "Kimi K3", in: "$3/M", out: "$15/M", intelligence: 43.8, coding: 76.2, agentic: 50.6, promptPerM: 3, completionPerM: 15 },
  { value: "openai/gpt-5.2", label: "GPT-5.2", in: "$1.75/M", out: "$14/M", promptPerM: 1.75, completionPerM: 14 },
  { value: "anthropic/claude-sonnet-4", label: "Claude Sonnet 4", in: "$3/M", out: "$15/M", promptPerM: 3, completionPerM: 15 },
  { value: "google/gemini-3.6-flash", label: "Gemini 3.6 Flash", in: "$0.375/M", out: "$1.875/M", promptPerM: 0.375, completionPerM: 1.875 },
  { value: "x-ai/grok-4.5", label: "Grok 4.5", in: "$2/M", out: "$6/M", promptPerM: 2, completionPerM: 6 }
]

/** The per-token USD figure as money per million tokens. */
export const usdPerMillion = (perToken: string | undefined): string => {
  if (perToken === undefined) return "—"
  const n = Number(perToken)
  if (!Number.isFinite(n)) return "—"
  if (n <= 0) return "free"
  const perM = n * 1_000_000
  const text = perM >= 100 ? perM.toFixed(0) : String(Number(perM.toFixed(3)))
  return `$${text}/M`
}

/** Input and output money on one line, from per-token USD. */
export const moneyLine = (prompt: string | undefined, completion: string | undefined): string =>
  `${usdPerMillion(prompt)} in · ${usdPerMillion(completion)} out`

/** The same line, from a catalog row. */
export const priceLine = (model: CatalogModel): string => `${model.in} in · ${model.out} out`

/** The row's second line: the sort figure, then money in and out. */
export const sortLine = (model: CatalogModel, key: SortKey): string => {
  const score =
    key === "intelligence"
      ? model.intelligence
      : key === "coding"
        ? model.coding
        : key === "agentic"
          ? model.agentic
          : undefined
  const money = priceLine(model)
  if (score === undefined) return money
  const tag = key === "intelligence" ? "intel" : key === "coding" ? "code" : "agent"
  return `${score} ${tag} · ${money}`
}

const shortName = (id: string, name: string | undefined): string => {
  if (name === undefined || name === "") return id
  const split = name.indexOf(": ")
  return split === -1 ? name : name.slice(split + 2)
}

const unknown: Pick<CatalogModel, "in" | "out"> = { in: "—", out: "—" }

const perMillion = (perToken: string | number | undefined): number | undefined => {
  if (perToken === undefined) return undefined
  const n = Number(perToken)
  return Number.isFinite(n) && n >= 0 ? n * 1_000_000 : undefined
}

const Price = Schema.Union([Schema.String, Schema.Number])
const OptionalString = Schema.String.pipe(
  Schema.optional,
  Schema.catchDecoding(() => Effect.succeed(Option.some(undefined)))
)
const OptionalFinite = Schema.Finite.pipe(
  Schema.optional,
  Schema.catchDecoding(() => Effect.succeed(Option.some(undefined)))
)
const OptionalPrice = Price.pipe(
  Schema.optional,
  Schema.catchDecoding(() => Effect.succeed(Option.some(undefined)))
)
const ArtificialAnalysis = Schema.Struct({
  intelligence_index: OptionalFinite,
  coding_index: OptionalFinite,
  agentic_index: OptionalFinite
})
const OptionalArtificialAnalysis = ArtificialAnalysis.pipe(
  Schema.optional,
  Schema.catchDecoding(() => Effect.succeed(Option.some(undefined)))
)
const Pricing = Schema.Struct({
  prompt: OptionalPrice,
  completion: OptionalPrice
})
const OptionalPricing = Pricing.pipe(
  Schema.optional,
  Schema.catchDecoding(() => Effect.succeed(Option.some(undefined)))
)
const Benchmarks = Schema.Struct({
  artificial_analysis: OptionalArtificialAnalysis
})
const OptionalBenchmarks = Benchmarks.pipe(
  Schema.optional,
  Schema.catchDecoding(() => Effect.succeed(Option.some(undefined)))
)
const OpenRouterRow = Schema.Struct({
  id: Schema.String,
  name: OptionalString,
  pricing: OptionalPricing,
  benchmarks: OptionalBenchmarks
})
const OpenRouterEnvelope = Schema.Struct({ data: Schema.Array(Schema.Unknown) })
const CursorRow = Schema.Struct({
  id: Schema.String,
  displayName: OptionalString
})
const CursorEnvelope = Schema.Struct({ items: Schema.Array(Schema.Unknown) })
const CursorErrorPayload = Schema.Struct({
  message: OptionalString,
  error: OptionalString
})

const decodeOpenRouterEnvelope = Schema.decodeUnknownOption(OpenRouterEnvelope)
const decodeOpenRouterRow = Schema.decodeUnknownOption(OpenRouterRow)
const decodeCursorEnvelope = Schema.decodeUnknownOption(CursorEnvelope)
const decodeCursorRow = Schema.decodeUnknownOption(CursorRow)
const decodeCursorError = Schema.decodeUnknownOption(CursorErrorPayload)

const aaOf = (row: typeof OpenRouterRow.Type): Pick<CatalogModel, "intelligence" | "coding" | "agentic"> => {
  const intelligence = row.benchmarks?.artificial_analysis?.intelligence_index
  const coding = row.benchmarks?.artificial_analysis?.coding_index
  const agentic = row.benchmarks?.artificial_analysis?.agentic_index
  return {
    ...(intelligence === undefined ? {} : { intelligence }),
    ...(coding === undefined ? {} : { coding }),
    ...(agentic === undefined ? {} : { agentic })
  }
}

/** Read OpenRouter's `{ data }` list. Batch rows and junk rows are dropped. */
export const modelsFrom = (payload: unknown): ReadonlyArray<CatalogModel> => {
  const envelope = decodeOpenRouterEnvelope(payload)
  if (Option.isNone(envelope)) return []
  const models: CatalogModel[] = []
  for (const item of envelope.value.data) {
    const decoded = decodeOpenRouterRow(item)
    if (Option.isNone(decoded)) continue
    const row = decoded.value
    const id = row.id
    if (id === "" || id.endsWith(":batch")) continue
    const prompt = row.pricing?.prompt
    const completion = row.pricing?.completion
    const promptPerM = perMillion(prompt)
    const completionPerM = perMillion(completion)
    models.push({
      value: id,
      label: shortName(id, row.name),
      in: usdPerMillion(prompt === undefined ? undefined : String(prompt)),
      out: usdPerMillion(completion === undefined ? undefined : String(completion)),
      ...aaOf(row),
      ...(promptPerM === undefined ? {} : { promptPerM }),
      ...(completionPerM === undefined ? {} : { completionPerM })
    })
  }
  return models
}

/** Read Cursor's `{ items }` model list. Cursor does not publish token prices here. */
export const cursorModelsFrom = (payload: unknown): ReadonlyArray<CatalogModel> => {
  const envelope = decodeCursorEnvelope(payload)
  if (Option.isNone(envelope)) return []
  const models: CatalogModel[] = []
  for (const item of envelope.value.items) {
    const decoded = decodeCursorRow(item)
    if (Option.isNone(decoded) || decoded.value.id === "") continue
    const { displayName, id } = decoded.value
    models.push({ value: id, label: displayName === undefined || displayName === "" ? id : displayName, ...unknown })
  }
  return models
}

/** True when the query is empty or it sits in the id or the label. */
export const matches = (model: CatalogModel, query: string): boolean => {
  if (query === "") return true
  const q = query.toLowerCase()
  return model.value.toLowerCase().includes(q) || model.label.toLowerCase().includes(q)
}

const scoreOf = (model: CatalogModel, key: SortKey): number | undefined => {
  if (key === "intelligence") return model.intelligence
  if (key === "coding") return model.coding
  if (key === "agentic") return model.agentic
  if (key === "in") return model.promptPerM
  if (key === "out") return model.completionPerM
  return undefined
}

/** Rank the catalog. Intelligence, coding, and agentic go high first. Price goes cheap first. A missing score sits last. */
export const sortModels = (models: ReadonlyArray<CatalogModel>, key: SortKey): ReadonlyArray<CatalogModel> => {
  const higher = key === "intelligence" || key === "coding" || key === "agentic"
  return [...models].sort((a, b) => {
    if (key === "name") return a.label.localeCompare(b.label)
    const av = scoreOf(a, key)
    const bv = scoreOf(b, key)
    if (av === undefined && bv === undefined) return a.label.localeCompare(b.label)
    if (av === undefined) return 1
    if (bv === undefined) return -1
    const cmp = av - bv
    return higher ? -cmp : cmp
  })
}

/** The list plus the stored model when it is not one of the known choices. */
export const modelsFor = (current: string, catalog: ReadonlyArray<CatalogModel> = MODELS): ReadonlyArray<CatalogModel> =>
  catalog.some((m) => m.value === current) || current === "" ? catalog : [...catalog, { value: current, label: current, ...unknown }]

/** The live OpenRouter catalog, or the static list when the request fails or is empty. */
export const loadModels = async (fetchImpl: Fetch = fetch): Promise<ReadonlyArray<CatalogModel>> => {
  try {
    const res = await fetchImpl(CATALOG)
    if (!res.ok) return MODELS
    const models = modelsFrom(await res.json())
    return models.length === 0 ? MODELS : models
  } catch {
    return MODELS
  }
}

export class CursorModelsError extends Schema.TaggedError<CursorModelsError>()("CursorModelsError", {
  detail: Schema.String
}) {
  override readonly message = this.detail
}

const cursorError = Effect.fn("CursorModels.statusError")(function* (res: Response) {
  const payload = yield* Effect.tryPromise(() => res.json()).pipe(Effect.option)
  if (Option.isSome(payload)) {
    const decoded = decodeCursorError(payload.value)
    if (Option.isSome(decoded)) {
      if (decoded.value.message !== undefined && decoded.value.message !== "") return decoded.value.message
      if (decoded.value.error !== undefined && decoded.value.error !== "") return decoded.value.error
    }
  }
  if (res.status === 401) return "Cursor rejected this API key (401)."
  return `Cursor model check failed (${res.status}).`
})

export const loadCursorModelsEffect = Effect.fn("CursorModels.load")(function* (
  key: string,
  fetchImpl: Fetch = fetch
) {
  const apiKey = key.trim()
  if (apiKey === "") return yield* new CursorModelsError({ detail: "Enter a Cursor API key." })
  const res = yield* Effect.tryPromise({
    try: () => fetchImpl(CURSOR_CATALOG, { headers: { Authorization: `Bearer ${apiKey}` } }),
    catch: (cause) =>
      new CursorModelsError({
        detail: `Could not reach Cursor: ${cause instanceof Error ? cause.message : String(cause)}`
      })
  })
  if (!res.ok) return yield* new CursorModelsError({ detail: yield* cursorError(res) })
  const payload = yield* Effect.tryPromise({
    try: () => res.json(),
    catch: () => new CursorModelsError({ detail: "Cursor returned an unreadable models response." })
  })
  const envelope = yield* Schema.decodeUnknownEffect(CursorEnvelope)(payload).pipe(
    Effect.mapError(() => new CursorModelsError({ detail: "Cursor returned an unexpected models response." }))
  )
  return cursorModelsFrom(envelope)
})

/** Models available to a Cursor API key through Cursor's official v1 endpoint. */
export const loadCursorModels = async (
  key: string,
  fetchImpl: Fetch = fetch
): Promise<ReadonlyArray<CatalogModel>> => Effect.runPromise(loadCursorModelsEffect(key, fetchImpl))
