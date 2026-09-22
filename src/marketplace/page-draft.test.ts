import { expect, test } from "bun:test"
import type { Persisted } from "../bridge/persisted"
import type { CompiledPackage } from "./compiler/compile"
import { pageDraftRecords } from "./page-draft"

const compiled = (mark: string): CompiledPackage => ({
  compiler: "test",
  script: `script:${mark}`,
  style: `style:${mark}`,
  sources: {},
  artifacts: { script: `sha256:${mark}`, css: `sha256:${mark}` }
})

const records: ReadonlyArray<Persisted> = [
  { id: "redesign:style:https://news.ycombinator.com/", matches: "https://news.ycombinator.com/", payload: { kind: "style", css: "style:release" } },
  { id: "redesign:script:https://news.ycombinator.com/", matches: "https://news.ycombinator.com/", payload: { kind: "script", js: "script:release" } }
]

test("a draft is worn under the release's own ids, so a load keeps wearing it", () => {
  const worn = pageDraftRecords(records, compiled("draft"))
  expect(worn.map((record) => record.id)).toEqual(records.map((record) => record.id))
  expect(worn.map((record) => record.matches)).toEqual(records.map((record) => record.matches))
  expect(worn[0]?.payload).toEqual({ kind: "style", css: "style:draft" })
  expect(worn[1]?.payload).toEqual({ kind: "script", js: "script:draft" })
})

test("no draft leaves the release exactly as it was published", () => {
  expect(pageDraftRecords(records, undefined)).toEqual(records)
})

test("a record of another kind is not a page package's, so it is left alone", () => {
  const sandbox: Persisted = {
    id: "redesign:sandbox:https://news.ycombinator.com/",
    matches: "https://news.ycombinator.com/",
    payload: { kind: "skin", js: "skin" }
  }
  expect(pageDraftRecords([sandbox], compiled("draft"))).toEqual([sandbox])
})
