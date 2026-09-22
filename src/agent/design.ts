import { Effect } from "effect"
import { isToken, TOKEN_KEYS, type Token } from "../kit/tokens"

/**
 * A site's design: the beUI tokens it overrides. The page wears it as one stylesheet
 * right after the palette, so a token set here wins over the kit's default in both
 * themes, and every component and every rule that reads the token follows.
 */
export type Tokens = Partial<Readonly<Record<Token, string>>>

export interface Design {
  /** Token values for both themes. */
  readonly tokens: Tokens
  /** Token values for the dark theme only; they win over `tokens` there. */
  readonly dark?: Tokens
}

export class DesignFailure extends Error {
  readonly _tag = "DesignFailure"
  constructor(message: string) {
    super(message)
  }
}

/** A CSS value that cannot close the declaration, the block, or open a comment that eats the rest of the sheet. */
const isValue = (v: unknown): v is string => typeof v === "string" && v.trim() !== "" && !/[;{}]|\/\*|\*\//.test(v)

/**
 * The token a key names, after undoing what models do to dashed keys: a second pair of
 * quotes (Gemini Flash), camelCase, underscores, capitals.
 */
const tokenOf = (key: string): Token | undefined => {
  const plain = key
    .trim()
    .replace(/^["']+|["']+$/g, "")
    .replace(/^--/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .toLowerCase()
  const name = `--${plain}`
  return isToken(name) ? name : undefined
}

const tokensOf = (raw: unknown, where: string): Effect.Effect<Tokens, DesignFailure> => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return Effect.fail(new DesignFailure(`${where} must be an object of token: value`))
  const out: Partial<Record<Token, string>> = {}
  for (const [k, v] of Object.entries(raw)) {
    const token = tokenOf(k)
    if (token === undefined) return Effect.fail(new DesignFailure(`${where}: ${JSON.stringify(k)} is not a token; the tokens are ${TOKEN_KEYS.join(", ")}`))
    if (!isValue(v)) return Effect.fail(new DesignFailure(`${where}: ${k} needs a CSS value without ; { } /* */`))
    out[token] = v.trim()
  }
  return Effect.succeed(out)
}

const isEmpty = (t: Tokens | undefined): boolean => t === undefined || Object.keys(t).length === 0

/** A design with no token at all: the kit's defaults apply. */
export const isDefault = (design: Design): boolean => isEmpty(design.tokens) && isEmpty(design.dark)

/** A design from the model's input, or a DesignFailure that says what is wrong. An empty one is the default. */
export const parseDesign = (input: unknown): Effect.Effect<Design, DesignFailure> => {
  const raw = input as { tokens?: unknown; dark?: unknown } | undefined
  return Effect.flatMap(tokensOf(raw?.tokens ?? {}, "tokens"), (tokens) =>
    Effect.map(raw?.dark === undefined ? Effect.succeed(undefined) : tokensOf(raw.dark, "dark"), (dark) => ({
      tokens,
      ...(isEmpty(dark) ? {} : { dark })
    }))
  )
}

const block = (selector: string, tokens: Tokens): string =>
  isEmpty(tokens) ? "" : `${selector} {\n${Object.entries(tokens).map(([k, v]) => `  ${k}: ${v};`).join("\n")}\n}\n`

/** The stylesheet a design becomes. Selectors match the palette's, so document order decides. */
export const designCss = (design: Design): string =>
  block(':root,\n:root[data-beui-theme="light"],\n:root[data-beui-theme="dark"]', design.tokens) + block(':root[data-beui-theme="dark"]', design.dark ?? {})
