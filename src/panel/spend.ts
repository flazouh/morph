import type { Spend } from "@/session"

/** The short figure the composer shows, or "" when nothing was spent yet. */
export const spendLabel = (spend: Spend): string => {
  if (spend.provider === "cursor") {
    // Cursor's own total when it stated one. A record from before Morph kept it has none,
    // and the sum of the classes is the closest figure that is still Cursor's own data.
    const tokens =
      spend.totalTokens ??
      spend.promptTokens + spend.completionTokens + spend.cacheReadTokens + spend.cacheWriteTokens
    return tokens === 0 ? "" : `${compact(tokens)} tok`
  }
  if (spend.priced > 0) return `$${spend.usd.toFixed(spend.usd < 0.1 ? 3 : 2)}`
  const tokens = spend.promptTokens + spend.completionTokens
  return tokens === 0 ? "" : `${compact(tokens)} tok`
}

/** The long form for the tooltip: tokens in, tokens out, and the price when known. */
export const spendDetail = (spend: Spend): string => {
  const tokens = `${spend.promptTokens.toLocaleString("en-US")} in · ${spend.completionTokens.toLocaleString("en-US")} out`
  if (spend.provider === "cursor") {
    return `Cursor · ${tokens} · ${spend.cacheReadTokens.toLocaleString("en-US")} cache read · ${spend.cacheWriteTokens.toLocaleString("en-US")} cache write`
  }
  return spend.priced > 0 ? `${tokens} · $${spend.usd.toFixed(4)} billed by OpenRouter` : `${tokens} · not priced`
}

const compact = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k` : String(n))
