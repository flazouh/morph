import { normalise } from "../../compiler/bundle"
import type { InstalledRelease } from "../installer"
import type { CompiledPackage } from "../compiler/compile"
import { digestOf } from "../compiler/digest"
import {
  PACKAGE_SOURCE_LIMITS,
  type PackageSource
} from "../compiler/source"
import { PAGE_STYLE } from "../compiler/page"
import type { ForkParent } from "./model"

type SourceFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

const sourceUrl = (release: InstalledRelease, path: string): string => {
  const repository = release.detail.source.repository.split("/")
  if (repository.length !== 2 || repository.some((part) => part === "")) {
    throw new Error("the package source repository must contain an owner and name")
  }
  const [owner, name] = repository
  const pathParts = release.detail.source.path.split("/")
  if (
    pathParts.length === 0 ||
    pathParts.some(
      (part) => part === "" || part === "." || part === ".." || !/^[A-Za-z0-9._-]+$/.test(part)
    )
  ) {
    throw new Error("the package source path must be canonical")
  }
  const folder = pathParts
    .map(encodeURIComponent)
    .join("/")
  const root = `https://raw.githubusercontent.com/${encodeURIComponent(owner!)}/${encodeURIComponent(name!)}/${encodeURIComponent(release.detail.source.commit)}/${folder}`
  if (release.detail.files.manifest !== `${root}/manifest.json`) {
    throw new Error("the package manifest URL does not match its source lineage")
  }
  const encoded = path.split("/").map(encodeURIComponent).join("/")
  return `${root}/source/${encoded}`
}

const CSS_IMPORT =
  /\bimport\s*(?:[^"'`;]*?\bfrom\s*)?["']([^"']+\.css)["']/g

const styleEntry = (
  entry: string,
  files: Readonly<Record<string, string>>
): string => {
  const imported = Array.from(
    (files[entry] ?? "").matchAll(CSS_IMPORT),
    (match) => match[1] ?? ""
  )
    .filter((path) => path.startsWith("."))
    .map((path) => normalise(entry, path))
    .filter((path) => Object.hasOwn(files, path))
  if (imported.length === 1) return imported[0]!
  const styles = Object.keys(files).filter((path) => path.endsWith(".css"))
  if (styles.length === 1) return styles[0]!
  throw new Error("the package source must identify one stylesheet entry")
}

const sameRecord = (
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>
): boolean =>
  JSON.stringify(Object.entries(left).sort()) ===
  JSON.stringify(Object.entries(right).sort())

export const loadForkParent = async (
  release: InstalledRelease,
  fetcher: SourceFetch,
  compile: (source: PackageSource) => Promise<CompiledPackage>
): Promise<ForkParent> => {
  const manifest = release.detail.manifest
  const runtime = manifest.runtime
  if (runtime !== "sandbox-v1" && runtime !== "script-v1") {
    throw new Error(`a ${runtime} Morph cannot be changed locally`)
  }
  if (runtime === "sandbox-v1" && manifest.capabilities === undefined) {
    throw new Error("the sandbox Morph names no capabilities, so its source cannot be trusted")
  }
  const paths = Object.keys(manifest.files).sort()
  if (paths.length > PACKAGE_SOURCE_LIMITS.files) {
    throw new Error(`the package has more than ${PACKAGE_SOURCE_LIMITS.files} source files`)
  }
  let totalBytes = 0
  const files: Record<string, string> = {}
  for (const path of paths) {
    const response = await fetcher(sourceUrl(release, path))
    if (!response.ok) throw new Error(`source download failed for ${path} (${response.status})`)
    const text = await response.text()
    const bytes = new TextEncoder().encode(text).byteLength
    if (bytes > PACKAGE_SOURCE_LIMITS.fileBytes) {
      throw new Error(`${path} exceeds ${PACKAGE_SOURCE_LIMITS.fileBytes} bytes`)
    }
    totalBytes += bytes
    if (totalBytes > PACKAGE_SOURCE_LIMITS.totalBytes) {
      throw new Error(`package source exceeds ${PACKAGE_SOURCE_LIMITS.totalBytes} bytes`)
    }
    if ((await digestOf(text)) !== manifest.files[path]) {
      throw new Error(`source digest does not match for ${path}`)
    }
    files[path] = text
  }
  // A page package's stylesheet is style.css by contract; a sandbox package's is whichever
  // stylesheet its entry imports.
  const source: PackageSource = {
    entry: manifest.entry,
    style: runtime === "script-v1" ? PAGE_STYLE : styleEntry(manifest.entry, files),
    files
  }
  const compiled = await compile(source)
  if (
    !sameRecord(compiled.sources, manifest.files) ||
    compiled.artifacts.script !== manifest.artifacts.script ||
    compiled.artifacts.css !== manifest.artifacts.css
  ) {
    throw new Error("local compiler output does not match the published release")
  }
  return {
    slug: release.slug,
    version: release.version,
    commit: release.detail.source.commit,
    runtime,
    license: manifest.license,
    compatibility: manifest.compatibility,
    scope: manifest.scope,
    source,
    compiled,
    ...(manifest.capabilities === undefined ? {} : { capabilities: manifest.capabilities })
  }
}
