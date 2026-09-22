/**
 * The beUI tokens palette.css defines, in the order the model reads them. Pure data:
 * the content script reads them off the page, the kit doc lists them, and the agent
 * validates a design against them. A test pins this list to palette.css.
 */
export const TOKENS = [
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--popover",
  "--popover-foreground",
  "--primary",
  "--primary-foreground",
  "--secondary",
  "--secondary-foreground",
  "--muted",
  "--muted-foreground",
  "--accent",
  "--accent-foreground",
  "--destructive",
  "--destructive-foreground",
  "--border",
  "--input",
  "--ring",
  "--success",
  "--warning",
  "--border-strong",
  "--neon",
  "--violet",
  "--glass-bg",
  "--glass-border",
  "--glass-strong-bg",
  "--glass-thin-bg",
  "--gradient-bg",
  "--gradient-accent",
  "--radius"
] as const

export type Token = (typeof TOKENS)[number]

/** The same names as the model writes them: without the dashes, which models mangle inside JSON keys. */
export const TOKEN_KEYS: ReadonlyArray<string> = TOKENS.map((t) => t.slice(2))

export const isToken = (k: string): k is Token => (TOKENS as ReadonlyArray<string>).includes(k)

/** The ids of the stylesheets a page wears, in document order. */
export const SHEETS = {
  /** The kit's default tokens; first in the document. */
  palette: "redesign-palette",
  /** The site's token overrides; right after the palette. */
  design: "redesign-design",
  /** The redesign stylesheet; always last. */
  styles: "redesign-styles"
} as const
