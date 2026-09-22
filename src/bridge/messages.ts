/**
 * What the panel asks a page's content script, and what comes back.
 *
 * One message shape per question, carried as the `page` kind of the extension protocol
 * (`bridge/messaging.ts`); the answer rides back on the same ask.
 */

import { Option, Schema } from "effect"

export const PageAsk = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("readPage"),
    selector: Schema.optionalKey(Schema.String),
    maxNodes: Schema.optionalKey(Schema.Number)
  }),
  Schema.Struct({ type: Schema.Literal("readStyles"), selector: Schema.String, limit: Schema.optionalKey(Schema.Number) }),
  Schema.Struct({ type: Schema.Literal("readText"), selector: Schema.String, limit: Schema.optionalKey(Schema.Number) }),
  Schema.Struct({ type: Schema.Literal("readDesign") })
])
export type PageAsk = typeof PageAsk.Type

const askOf = Schema.decodeUnknownOption(PageAsk)
export const decodePageAsk = (value: unknown): PageAsk | undefined => Option.getOrUndefined(askOf(value))

export interface PageOutline {
  readonly url: string
  readonly title: string
  readonly viewport: { readonly width: number; readonly height: number }
  readonly stylesheets: ReadonlyArray<string>
  /** One line per node: indentation is depth. See `outlineOf`. */
  readonly outline: string
  readonly nodes: number
  readonly truncated: boolean
}

export interface StyledNode {
  readonly selector: string
  readonly rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  readonly styles: Readonly<Record<string, string>>
}

/** The design tokens as the page resolves them now, and the theme the kit chose. */
export interface DesignReport {
  readonly theme: string | null
  readonly tokens: Readonly<Record<string, string>>
}

export type PageAnswer =
  | { readonly type: "readPage"; readonly page: PageOutline }
  | { readonly type: "readStyles"; readonly nodes: ReadonlyArray<StyledNode> }
  | { readonly type: "readText"; readonly texts: ReadonlyArray<string> }
  | { readonly type: "readDesign"; readonly design: DesignReport }
  | { readonly type: "error"; readonly message: string }
