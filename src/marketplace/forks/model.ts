import type { CompiledPackage } from "../compiler/compile"
import type { PackageSource } from "../compiler/source"
import type { SandboxCapabilities } from "../manifest"

export interface ForkParent {
  readonly slug: string
  readonly version: string
  readonly commit: string
  /** What the package is: a sandbox program, or a page's own style and script. */
  readonly runtime: "sandbox-v1" | "script-v1"
  readonly license: string
  readonly compatibility: { readonly kit: string; readonly chrome: string }
  readonly scope: {
    readonly kind: "page" | "site"
    readonly origin: string
    readonly paths: ReadonlyArray<string>
  }
  readonly source: PackageSource
  readonly compiled: CompiledPackage
  /** A sandbox package asks for capabilities; a page package has none to ask for. */
  readonly capabilities?: SandboxCapabilities
}

export interface PermissionDelta {
  readonly added: ReadonlyArray<string>
  readonly removed: ReadonlyArray<string>
}

export interface ForkRevision {
  readonly id: string
  readonly createdAt: string
  readonly source: PackageSource
  readonly compiled: CompiledPackage
  readonly capabilities?: SandboxCapabilities
  readonly permissions: PermissionDelta
}

export interface ForkDraft {
  readonly id: string
  readonly name?: string
  readonly parent: {
    readonly slug: string
    readonly version: string
    readonly commit: string
    readonly license: string
    readonly compatibility: { readonly kit: string; readonly chrome: string }
  }
  readonly runtime: ForkParent["runtime"]
  readonly parentCapabilities?: SandboxCapabilities
  readonly scope: ForkParent["scope"]
  readonly revisions: ReadonlyArray<ForkRevision>
  readonly currentRevision: string
  readonly createdAt: string
  readonly updatedAt: string
}

export interface ForkDraftLibrary {
  readonly drafts: Readonly<Record<string, ForkDraft>>
}

const permissionSet = (capabilities: SandboxCapabilities): ReadonlySet<string> => {
  const permissions = new Set<string>()
  for (const selector of capabilities.page.read) permissions.add(`page.read:${selector}`)
  for (const origin of capabilities.page.navigate) permissions.add(`page.navigate:${origin}`)
  if (capabilities.page.traverse) permissions.add("page.traverse")
  if (capabilities.storage) permissions.add("storage")
  if (capabilities.context.viewer) permissions.add("context.viewer")
  if (capabilities.context.theme) permissions.add("context.theme")
  if (capabilities.context.route) permissions.add("context.route")
  for (const origin of capabilities.assets) permissions.add(`assets:${origin}`)
  for (const form of capabilities.secureForms) permissions.add(`secureForms:${form}`)
  if (capabilities.takeover !== undefined) {
    permissions.add(
      `takeover:${capabilities.takeover.slot}:${capabilities.takeover.fallback ?? ""}`
    )
  }
  for (const grant of capabilities.network) {
    permissions.add(
      `network:${grant.origin}:${[...grant.paths].sort().join(",")}:${[...grant.methods].sort().join(",")}:${grant.credentials}:${[...grant.headers].sort().join(",")}`
    )
  }
  return permissions
}

/**
 * What a revision asks for that its parent did not, and what it gave up. A package with no
 * capabilities asks for nothing, so a page fork's delta is empty on both sides.
 */
export const permissionDelta = (
  parent: SandboxCapabilities | undefined,
  current: SandboxCapabilities | undefined
): PermissionDelta => {
  const before = parent === undefined ? new Set<string>() : permissionSet(parent)
  const after = current === undefined ? new Set<string>() : permissionSet(current)
  return {
    added: [...after].filter((permission) => !before.has(permission)).sort(),
    removed: [...before].filter((permission) => !after.has(permission)).sort()
  }
}

export const currentRevisionOf = (draft: ForkDraft): ForkRevision => {
  const revision = draft.revisions.find((item) => item.id === draft.currentRevision)
  if (revision === undefined) {
    throw new Error(`draft ${JSON.stringify(draft.id)} has no current revision`)
  }
  return revision
}

export const parentKey = (
  parent: Pick<ForkParent, "slug" | "version" | "commit">
): string => `${parent.slug}@${parent.version}#${parent.commit}`
