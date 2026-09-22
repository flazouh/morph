import type { ChangeRecord, SourceLocation } from "./model"
import { probeSource, type SourceProbe } from "./source"
import type { ResolveSource } from "./source-resolver"
import {
  isChangeRecord,
  type InspectorStore
} from "./session-store"

export type InspectorAsk =
  | { readonly type: "loadInspector" }
  | { readonly type: "saveInspector"; readonly record: ChangeRecord }
  | { readonly type: "clearInspector" }
  | { readonly type: "resolveInspectorSource"; readonly selector: string }

export type InspectorAnswer =
  | { readonly type: "inspectorLoaded"; readonly record: ChangeRecord | null }
  | { readonly type: "inspectorSaved" }
  | { readonly type: "inspectorCleared" }
  | { readonly type: "inspectorSourceResolved"; readonly source: SourceLocation | null }
  | { readonly type: "inspectorError"; readonly message: string }

export interface InspectorSender {
  readonly tab?: {
    readonly id?: number
    readonly url?: string
  }
}

export interface InspectorScripting {
  executeScript(details: {
    readonly target: { readonly tabId: number }
    readonly world: "MAIN"
    readonly func: typeof probeSource
    readonly args: [string]
  }): Promise<ReadonlyArray<{ readonly result?: SourceProbe }>>
}

export interface InspectorHandlerPorts {
  readonly store: InspectorStore
  readonly scripting: InspectorScripting
  readonly resolveSource: ResolveSource
}

export type InspectorHandler = (
  ask: InspectorAsk,
  sender: InspectorSender
) => Promise<InspectorAnswer>

export const isInspectorAsk = (value: unknown): value is InspectorAsk => {
  if (typeof value !== "object" || value === null) return false
  const ask = value as Record<string, unknown>
  switch (ask.type) {
    case "loadInspector":
    case "clearInspector":
      return true
    case "saveInspector":
      return isChangeRecord(ask.record)
    case "resolveInspectorSource":
      return typeof ask.selector === "string"
    default:
      return false
  }
}

export const createInspectorHandler = ({
  store,
  scripting,
  resolveSource
}: InspectorHandlerPorts): InspectorHandler => {
  const probe = async (
    tabId: number,
    selector: string
  ): Promise<SourceProbe | undefined> => {
    const results = await scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: probeSource,
      args: [selector]
    })
    return results[0]?.result
  }

  return async (
    ask: InspectorAsk,
    sender: InspectorSender
  ): Promise<InspectorAnswer> => {
    const tabId = sender.tab?.id
    const page = sender.tab?.url
    if (tabId === undefined || page === undefined) {
      return {
        type: "inspectorError",
        message: "Open Morph in a website tab and try again."
      }
    }

    switch (ask.type) {
      case "loadInspector":
        return {
          type: "inspectorLoaded",
          record: await store.load(tabId, page)
        }
      case "saveInspector":
        await store.save(tabId, page, ask.record)
        return { type: "inspectorSaved" }
      case "clearInspector":
        await store.clear(tabId)
        return { type: "inspectorCleared" }
      case "resolveInspectorSource": {
        const found = await probe(tabId, ask.selector)
        const source =
          found === undefined || found.kind === "none"
            ? null
            : found.kind === "resolved"
              ? found.source
              : await resolveSource(found.source, page)
        return {
          type: "inspectorSourceResolved",
          source
        }
      }
    }
  }
}

export const inspectorError = (error: unknown): InspectorAnswer => {
  const reason = error instanceof Error && error.message.trim() !== ""
    ? error.message.trim().replace(/[.!?]+$/, "")
    : "unknown error"
  return {
    type: "inspectorError",
    message: `Inspector request failed: ${reason}. Reload the page and try again.`
  }
}
