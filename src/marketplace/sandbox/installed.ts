import type { InstalledLibrary, InstalledRelease } from "../installer"
import type { SandboxCapabilities } from "../manifest"
import type { Persisted } from "../../bridge/persisted"

export interface SandboxInstall {
  readonly slug: string
  readonly mode: "installed" | "temporary"
  readonly js: string
  readonly css: string
  readonly capabilities: SandboxCapabilities
}

export interface PageScope {
  readonly origin: string
  readonly paths: ReadonlyArray<string>
}

export const scopeMatches = (
  scope: PageScope,
  location: Pick<Location, "origin" | "pathname">
): boolean =>
  scope.origin === location.origin && scope.paths.includes(location.pathname)

const sandboxPayload = (
  record: Persisted
): Extract<Persisted["payload"], { kind: "sandbox" }> | undefined =>
  record.payload.kind === "sandbox" ? record.payload : undefined

export const releaseMatches = (
  release: InstalledRelease,
  location: Pick<Location, "origin" | "pathname">
): boolean => {
  return scopeMatches(release.detail.manifest.scope, location)
}

export const installedReleaseOn = (
  library: InstalledLibrary,
  location: Pick<Location, "origin" | "pathname">
): InstalledRelease | undefined =>
  Object.values(library.active).find((release) => releaseMatches(release, location))

/** The sandbox package that owns this page, if one is installed. */
export const sandboxOn = (
  library: InstalledLibrary,
  location: Pick<Location, "origin" | "pathname">
): SandboxInstall | undefined => {
  const release = installedReleaseOn(library, location)
  if (release !== undefined) {
    for (const record of release.records) {
      const payload = sandboxPayload(record)
      if (payload === undefined) continue
      return {
        slug: release.slug,
        mode: "installed",
        js: payload.js,
        css: payload.css,
        capabilities: payload.capabilities
      }
    }
  }
  return undefined
}
