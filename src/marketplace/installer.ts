import type { Persisted } from "../bridge/persisted"
import { scopeOf } from "../bridge/scope"
import type { PackageDetail } from "./api/http"
import { parseManifest, parseSandboxCapabilities } from "./manifest"
import { parsePackageDetail } from "./package-decode"
import { parseDeclarativeView } from "./view"

export interface InstalledRelease {
  readonly slug: string
  readonly version: string
  readonly installedAt: string
  readonly detail: PackageDetail
  readonly records: ReadonlyArray<Persisted>
}

export interface InstalledLibrary {
  readonly active: Readonly<Record<string, InstalledRelease>>
  readonly history: Readonly<Record<string, ReadonlyArray<InstalledRelease>>>
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined

const parsePersisted = (value: unknown): Persisted | undefined => {
  const item = record(value)
  const payload = record(item?.payload)
  if (
    typeof item?.id !== "string" ||
    typeof item.matches !== "string" ||
    typeof payload?.kind !== "string"
  ) {
    return undefined
  }
  if (
    (payload.kind === "design" || payload.kind === "style") &&
    typeof payload.css === "string"
  ) {
    return { id: item.id, matches: item.matches, payload: { kind: payload.kind, css: payload.css } }
  }
  if (payload.kind === "script" && typeof payload.js === "string") {
    return { id: item.id, matches: item.matches, payload: { kind: "script", js: payload.js } }
  }
  if (payload.kind === "declarative") {
    try {
      return {
        id: item.id,
        matches: item.matches,
        payload: { kind: "declarative", view: parseDeclarativeView(payload.view) }
      }
    } catch {
      return undefined
    }
  }
  if (
    payload.kind === "sandbox" &&
    typeof payload.js === "string" &&
    typeof payload.css === "string"
  ) {
    try {
      return {
        id: item.id,
        matches: item.matches,
        payload: {
          kind: "sandbox",
          js: payload.js,
          css: payload.css,
          capabilities: parseSandboxCapabilities(payload.capabilities)
        }
      }
    } catch {
      return undefined
    }
  }
  return undefined
}

export const parseInstalledRelease = (value: unknown): InstalledRelease | undefined => {
  const item = record(value)
  const detail = parsePackageDetail(item?.detail)
  if (
    typeof item?.slug !== "string" ||
    typeof item.version !== "string" ||
    typeof item.installedAt !== "string" ||
    detail === undefined ||
    detail.slug !== item.slug ||
    detail.version !== item.version ||
    !Array.isArray(item.records)
  ) {
    return undefined
  }
  const records: Persisted[] = []
  for (const value of item.records) {
    const parsed = parsePersisted(value)
    if (parsed === undefined) return undefined
    records.push(parsed)
  }
  return {
    slug: item.slug,
    version: item.version,
    installedAt: item.installedAt,
    detail,
    records
  }
}

export const parseInstalledLibrary = (value: unknown): InstalledLibrary | undefined => {
  const item = record(value)
  const activeInput = record(item?.active)
  const historyInput = record(item?.history)
  if (activeInput === undefined || historyInput === undefined) return undefined
  const active: Record<string, InstalledRelease> = {}
  for (const [slug, value] of Object.entries(activeInput)) {
    const release = parseInstalledRelease(value)
    if (release === undefined || release.slug !== slug) return undefined
    active[slug] = release
  }
  const history: Record<string, ReadonlyArray<InstalledRelease>> = {}
  for (const [slug, value] of Object.entries(historyInput)) {
    if (!Array.isArray(value)) return undefined
    const releases: InstalledRelease[] = []
    for (const item of value) {
      const release = parseInstalledRelease(item)
      if (release === undefined || release.slug !== slug) return undefined
      releases.push(release)
    }
    history[slug] = releases
  }
  return { active, history }
}

interface InstallMemory {
  readonly read: () => Promise<InstalledLibrary>
  readonly write: (library: InstalledLibrary) => Promise<void>
}

interface RegistrationPort {
  readonly replace: (removeIds: ReadonlyArray<string>, records: ReadonlyArray<Persisted>) => Promise<void>
}

type ArtifactFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

interface InstallerPorts {
  readonly fetcher: ArtifactFetch
  readonly registrations: RegistrationPort
  readonly memory: InstallMemory
  readonly now: () => string
}

export interface MarketplaceInstaller {
  readonly install: (detail: PackageDetail) => Promise<InstalledRelease>
  readonly rollback: (slug: string) => Promise<InstalledRelease>
  readonly remove: (slug: string) => Promise<void>
  readonly list: () => Promise<InstalledLibrary>
}

const MAX_ARTIFACT_BYTES = 5_000_000
const MAX_HISTORY = 3

const sha256 = async (bytes: ArrayBuffer): Promise<string> => {
  const value = await crypto.subtle.digest("SHA-256", bytes)
  return `sha256:${[...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`
}

const download = async (fetcher: ArtifactFetch, url: string, expected: string, name: string): Promise<string> => {
  const response = await fetcher(url)
  if (!response.ok) throw new Error(`${name} artifact download failed (${response.status})`)
  const declaredSize = Number(response.headers.get("content-length"))
  if (Number.isFinite(declaredSize) && declaredSize > MAX_ARTIFACT_BYTES) throw new Error(`${name} artifact exceeds ${MAX_ARTIFACT_BYTES} bytes`)
  const bytes = await response.arrayBuffer()
  if (bytes.byteLength > MAX_ARTIFACT_BYTES) throw new Error(`${name} artifact exceeds ${MAX_ARTIFACT_BYTES} bytes`)
  if ((await sha256(bytes)) !== expected) throw new Error(`${name} artifact digest does not match`)
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
}

export const preparePackageRecords = async (
  detail: PackageDetail,
  fetcher: ArtifactFetch
): Promise<ReadonlyArray<Persisted>> => {
  const manifest = parseManifest(detail.manifest)
  if (manifest.slug !== detail.slug || manifest.version !== detail.version) throw new Error("package detail and manifest identity do not match")
  const css = await download(fetcher, detail.files.css, manifest.artifacts.css, "css")
  if (manifest.runtime === "declarative-v1") {
    if (detail.files.view === undefined || manifest.artifacts.view === undefined) throw new Error("declarative package has no view artifact")
    const source = await download(fetcher, detail.files.view, manifest.artifacts.view, "view")
    const view = parseDeclarativeView(JSON.parse(source) as unknown)
    return manifest.scope.paths.map((path) => ({
      ...scopeOf(`${manifest.scope.origin}${path}`, "declarative"),
      payload: { kind: "declarative", view }
    }))
  }
  if (detail.files.script === undefined || manifest.artifacts.script === undefined) {
    throw new Error(`${manifest.runtime} package has no script artifact`)
  }
  const js = await download(fetcher, detail.files.script, manifest.artifacts.script, "script")
  if (manifest.runtime === "sandbox-v1") {
    if (manifest.capabilities === undefined) throw new Error("sandbox package has no capabilities")
    const capabilities = manifest.capabilities
    return manifest.scope.paths.map((path) => ({
      ...scopeOf(`${manifest.scope.origin}${path}`, "sandbox"),
      payload: { kind: "sandbox", js, css, capabilities }
    }))
  }
  return manifest.scope.paths.flatMap((path) => [
    { ...scopeOf(`${manifest.scope.origin}${path}`, "style"), payload: { kind: "style", css } },
    { ...scopeOf(`${manifest.scope.origin}${path}`, "script"), payload: { kind: "script", js } }
  ])
}

const idsOf = (releases: ReadonlyArray<InstalledRelease>): ReadonlyArray<string> => [
  ...new Set(releases.flatMap((release) => release.records.map((record) => record.id)))
]

const injectable = (records: ReadonlyArray<Persisted>): ReadonlyArray<Persisted> =>
  records.filter((record) => record.payload.kind !== "sandbox")

export const marketplaceInstaller = ({ fetcher, registrations, memory, now }: InstallerPorts): MarketplaceInstaller => {
  const save = async (
    before: InstalledLibrary,
    after: InstalledLibrary,
    removeIds: ReadonlyArray<string>,
    records: ReadonlyArray<Persisted>,
    rollbackRecords: ReadonlyArray<Persisted>
  ): Promise<void> => {
    await registrations.replace(removeIds, injectable(records))
    try {
      await memory.write(after)
    } catch (cause) {
      try {
        await registrations.replace(records.map((record) => record.id), injectable(rollbackRecords))
        await memory.write(before)
      } catch (rollbackCause) {
        throw new AggregateError([cause, rollbackCause], "install state and rollback both failed")
      }
      throw cause
    }
  }

  return {
    install: async (detail) => {
      const records = await preparePackageRecords(detail, fetcher)
      const before = await memory.read()
      const recordIds = new Set(records.map((record) => record.id))
      const displaced = Object.values(before.active).filter((release) =>
        release.slug === detail.slug || release.records.some((record) => recordIds.has(record.id))
      )
      const active = { ...before.active }
      const history = { ...before.history }
      for (const release of displaced) {
        delete active[release.slug]
        history[release.slug] = [...(history[release.slug] ?? []).slice(-(MAX_HISTORY - 1)), release]
      }
      const installed: InstalledRelease = { slug: detail.slug, version: detail.version, installedAt: now(), detail, records }
      active[detail.slug] = installed
      await save(before, { active, history }, idsOf(displaced), records, displaced.flatMap((release) => release.records))
      return installed
    },
    rollback: async (slug) => {
      const before = await memory.read()
      const current = before.active[slug]
      const releases = before.history[slug] ?? []
      const previous = releases.at(-1)
      if (current === undefined || previous === undefined) throw new Error(`package ${JSON.stringify(slug)} has no version to restore`)
      const history = { ...before.history, [slug]: releases.slice(0, -1) }
      const after = { active: { ...before.active, [slug]: previous }, history }
      await save(before, after, current.records.map((record) => record.id), previous.records, current.records)
      return previous
    },
    remove: async (slug) => {
      const before = await memory.read()
      const current = before.active[slug]
      if (current === undefined) return
      const active = { ...before.active }
      delete active[slug]
      await save(before, { active, history: before.history }, current.records.map((record) => record.id), [], current.records)
    },
    list: () => memory.read()
  }
}
