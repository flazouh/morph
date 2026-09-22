import { makeTabMap, type TabMapStorage } from "@/lib/tab-map"
import { STYLE_PROPERTIES } from "./model"
import type {
  ChangeRecord,
  SourceLocation,
  StyleChange
} from "./model"

export const INSPECTOR_STORAGE_KEY = "inspector-records"

export interface InspectorStore {
  load(tabId: number, page: string): Promise<ChangeRecord | null>
  save(tabId: number, page: string, record: ChangeRecord): Promise<void>
  clear(tabId: number): Promise<void>
}

export type InspectorStorage = TabMapStorage

interface StoredInspector {
  readonly page: string
  readonly record: ChangeRecord
}

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const countOrNull = (value: unknown): value is number | null =>
  value === null ||
  (typeof value === "number" && Number.isInteger(value) && value >= 0)

const sourceLocation = (value: unknown): value is SourceLocation => {
  if (!object(value)) return false
  return (
    typeof value.file === "string" &&
    countOrNull(value.line) &&
    countOrNull(value.column) &&
    (value.component === null || typeof value.component === "string") &&
    (
      value.precision === "authored" ||
      value.precision === "transformed" ||
      value.precision === "unknown"
    )
  )
}

/** The record owns source metadata, so a change that carries its own is a shape this build never wrote. */
const styleChange = (value: unknown): value is StyleChange => {
  if (!object(value)) return false
  return (
    typeof value.selector === "string" &&
    typeof value.property === "string" &&
    STYLE_PROPERTIES.includes(value.property as StyleChange["property"]) &&
    typeof value.before === "string" &&
    typeof value.after === "string" &&
    !("source" in value)
  )
}

const sourceMap = (value: unknown): value is Record<string, SourceLocation> =>
  object(value) && Object.values(value).every(sourceLocation)

export const isChangeRecord = (value: unknown): value is ChangeRecord => {
  if (!object(value)) return false
  return (
    typeof value.url === "string" &&
    typeof value.tailwind === "boolean" &&
    sourceMap(value.sources) &&
    Array.isArray(value.changes) &&
    value.changes.every(styleChange)
  )
}

const storedInspector = (value: unknown): value is StoredInspector =>
  object(value) &&
  typeof value.page === "string" &&
  isChangeRecord(value.record)

export const makeInspectorStore = (
  storage: InspectorStorage
): InspectorStore => {
  const records = makeTabMap(storage, INSPECTOR_STORAGE_KEY, storedInspector)

  return {
    load: async (tabId, page) => {
      const entry = await records.get(tabId)
      return entry?.page === page ? entry.record : null
    },
    save: (tabId, page, record) => records.update(tabId, () => ({ page, record })),
    clear: (tabId) => records.update(tabId, () => undefined)
  }
}

export const chromeInspectorStore = (): InspectorStore =>
  makeInspectorStore(chrome.storage.session)
