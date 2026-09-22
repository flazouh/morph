export type PackageRuntime = "declarative-v1" | "script-v1" | "sandbox-v1"
export type PagePermission = "read:text" | "read:attributes" | "navigate"
export type NetworkMethod = "GET" | "POST"
export type NetworkHeader = "Accept" | "X-Requested-With" | "Content-Type" | "GitHub-Verified-Fetch" | "X-Fetch-Nonce"

export interface SandboxNetworkGrant {
  readonly origin: string
  readonly paths: ReadonlyArray<string>
  readonly methods: ReadonlyArray<NetworkMethod>
  readonly credentials: "omit" | "include"
  readonly headers: ReadonlyArray<NetworkHeader>
}

export interface SandboxCapabilities {
  readonly takeover?: {
    readonly slot: string
    readonly fallback?: string
  }
  readonly page: {
    readonly read: ReadonlyArray<string>
    readonly navigate: ReadonlyArray<string>
    /**
     * Whether the package may walk the page's history rather than only add to it.
     *
     * Separate from `navigate` because the two powers are not the same one. A grant of
     * `navigate` names the origins a package may send the reader to; a traversal names
     * no address at all and returns them to a page they already reached, which may be
     * an origin nobody granted.
     */
    readonly traverse: boolean
  }
  readonly network: ReadonlyArray<SandboxNetworkGrant>
  readonly storage: boolean
  readonly context: {
    readonly viewer: boolean
    readonly theme: boolean
    readonly route: boolean
  }
  /**
   * The origins a package may load an image or a font from, through `assets.load`.
   *
   * Origins rather than a switch. The frame's own policy allows no remote resource at
   * all, so every one of them is fetched by the host and handed back as data — and a
   * host that fetches whatever it is asked for is the firewall with a hole in it.
   */
  readonly assets: ReadonlyArray<string>
  readonly secureForms: ReadonlyArray<string>
}

export interface RedesignManifest {
  readonly schema: 1
  readonly slug: string
  readonly version: string
  readonly summary: string
  readonly license: string
  readonly author: { readonly handle: string }
  readonly scope: {
    readonly kind: "page" | "site"
    readonly origin: string
    readonly paths: ReadonlyArray<string>
  }
  readonly runtime: PackageRuntime
  readonly entry: string
  readonly files: Readonly<Record<string, string>>
  readonly compatibility: {
    readonly kit: string
    readonly chrome: string
  }
  readonly artifacts: {
    readonly view?: string
    readonly script?: string
    readonly css: string
  }
  readonly previews: {
    readonly before: string
    readonly after: string
  }
  readonly permissions: {
    readonly page: ReadonlyArray<PagePermission>
    readonly network: ReadonlyArray<string>
  }
  readonly capabilities?: SandboxCapabilities
}

const NETWORK_METHODS = new Set<NetworkMethod>(["GET", "POST"])
const NETWORK_HEADERS = new Set<NetworkHeader>(["Accept", "X-Requested-With", "Content-Type", "GitHub-Verified-Fetch", "X-Fetch-Nonce"])

export const parseSandboxCapabilities = (input: unknown): SandboxCapabilities => {
  const capabilities = record(input, "capabilities")
  const page = record(capabilities.page, "capabilities.page")
  const read = strings(page.read, "capabilities.page.read")
  const navigate = strings(page.navigate, "capabilities.page.navigate")
  unique(read, "capabilities.page.read")
  unique(navigate, "capabilities.page.navigate")
  for (const url of navigate) origin(url, "capabilities.page.navigate")
  if (page.traverse !== undefined && typeof page.traverse !== "boolean") {
    throw new Error("capabilities.page.traverse must be a boolean")
  }
  const traverse = page.traverse === true

  if (!Array.isArray(capabilities.network)) throw new Error("capabilities.network must be an array")
  const network = capabilities.network.map((item, index) => {
    const grant = record(item, `capabilities.network[${index}]`)
    const methods = strings(grant.methods, `capabilities.network[${index}].methods`)
    const headers = strings(grant.headers, `capabilities.network[${index}].headers`)
    const paths = strings(grant.paths, `capabilities.network[${index}].paths`)
    unique(methods, `capabilities.network[${index}].methods`)
    unique(headers, `capabilities.network[${index}].headers`)
    unique(paths, `capabilities.network[${index}].paths`)
    for (const method of methods) {
      if (!NETWORK_METHODS.has(method as NetworkMethod)) {
        throw new Error(`capabilities.network[${index}].methods contains unsupported method ${JSON.stringify(method)}`)
      }
    }
    for (const header of headers) {
      if (!NETWORK_HEADERS.has(header as NetworkHeader)) {
        throw new Error(`capabilities.network[${index}].headers contains unsupported header ${JSON.stringify(header)}`)
      }
    }
    for (const path of paths) {
      if (!path.startsWith("/") || path.includes("?") || path.includes("#") || path.split("/").includes("..")) {
        throw new Error(`capabilities.network[${index}].paths contains invalid path ${JSON.stringify(path)}`)
      }
    }
    if (grant.credentials !== "omit" && grant.credentials !== "include") {
      throw new Error(`capabilities.network[${index}].credentials must be omit or include`)
    }
    return {
      origin: origin(grant.origin, `capabilities.network[${index}].origin`),
      paths,
      methods: methods as ReadonlyArray<NetworkMethod>,
      credentials: grant.credentials as "omit" | "include",
      headers: headers as ReadonlyArray<NetworkHeader>
    }
  })

  const context = record(capabilities.context, "capabilities.context")
  if (typeof context.viewer !== "boolean") throw new Error("capabilities.context.viewer must be a boolean")
  if (typeof context.theme !== "boolean") throw new Error("capabilities.context.theme must be a boolean")
  if (typeof context.route !== "boolean") throw new Error("capabilities.context.route must be a boolean")
  if (typeof capabilities.storage !== "boolean") throw new Error("capabilities.storage must be a boolean")
  const assets = strings(capabilities.assets, "capabilities.assets")
  unique(assets, "capabilities.assets")
  for (const url of assets) origin(url, "capabilities.assets")
  const secureForms = strings(capabilities.secureForms, "capabilities.secureForms")
  unique(secureForms, "capabilities.secureForms")

  let takeover: SandboxCapabilities["takeover"]
  if (capabilities.takeover !== undefined) {
    const named = record(capabilities.takeover, "capabilities.takeover")
    takeover = {
      slot: string(named.slot, "capabilities.takeover.slot"),
      ...(named.fallback === undefined ? {} : { fallback: string(named.fallback, "capabilities.takeover.fallback") })
    }
  }

  return {
    ...(takeover === undefined ? {} : { takeover }),
    page: { read, navigate, traverse },
    network,
    storage: capabilities.storage,
    context: {
      viewer: context.viewer,
      theme: context.theme,
      route: context.route
    },
    assets,
    secureForms
  }
}

const HASH = /^sha256:[a-f0-9]{64}$/
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const SLUG_PART = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/
const PAGE_PERMISSIONS = new Set<PagePermission>(["read:text", "read:attributes", "navigate"])

const record = (value: unknown, name: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} must be an object`)
  return value as Record<string, unknown>
}

const string = (value: unknown, name: string): string => {
  if (typeof value !== "string" || value === "") throw new Error(`${name} must be a non-empty string`)
  return value
}

const strings = (value: unknown, name: string): ReadonlyArray<string> => {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${name} must be an array of strings`)
  return value
}

const origin = (value: unknown, name: string): string => {
  const input = string(value, name)
  try {
    const url = new URL(input)
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin !== input || url.username !== "" || url.password !== "") throw new Error()
    return input
  } catch {
    throw new Error(`${name} must be an http or https origin`)
  }
}

const hash = (value: unknown, name: string): string => {
  const input = string(value, name)
  if (!HASH.test(input)) throw new Error(`${name} must be a sha256 digest`)
  return input
}

const unique = (values: ReadonlyArray<string>, name: string): void => {
  if (new Set(values).size !== values.length) throw new Error(`${name} must not contain duplicates`)
}

const filePath = (value: string, name: string): void => {
  if (value.startsWith("/") || value.split("/").includes("..") || value.includes("\\") || value === ".") {
    throw new Error(`${name} must be a package-relative path`)
  }
}

export const parseManifest = (input: unknown): RedesignManifest => {
  const manifest = record(input, "manifest")
  if (manifest.schema !== 1) throw new Error("schema must be 1")

  const slug = string(manifest.slug, "slug")
  const parts = slug.split("/")
  if (parts.length !== 2 || parts.some((part) => !SLUG_PART.test(part ?? ""))) throw new Error("slug must be handle/name")

  const version = string(manifest.version, "version")
  if (!SEMVER.test(version)) throw new Error("version must be semantic versioning")
  string(manifest.summary, "summary")
  string(manifest.license, "license")

  const author = record(manifest.author, "author")
  const handle = string(author.handle, "author.handle")
  if (handle !== parts[0]) throw new Error("author.handle must match the slug namespace")

  const scope = record(manifest.scope, "scope")
  if (scope.kind !== "page" && scope.kind !== "site") throw new Error('scope.kind must be "page" or "site"')
  origin(scope.origin, "scope.origin")
  const paths = strings(scope.paths, "scope.paths")
  if (paths.length === 0) throw new Error("scope.paths must not be empty")
  unique(paths, "scope.paths")
  for (const path of paths) {
    if (!path.startsWith("/") || path.includes("*") || path.includes("?") || path.includes("#") || path.split("/").includes("..")) {
      throw new Error(`scope.paths contains invalid path ${JSON.stringify(path)}`)
    }
  }

  if (manifest.runtime !== "declarative-v1" && manifest.runtime !== "script-v1" && manifest.runtime !== "sandbox-v1") {
    throw new Error("runtime is not supported")
  }
  const entry = string(manifest.entry, "entry")
  filePath(entry, "entry")
  if (manifest.runtime === "declarative-v1" && !entry.endsWith(".redesign.json")) {
    throw new Error("declarative-v1 entry must end with .redesign.json")
  }

  const files = record(manifest.files, "files")
  if (!(entry in files)) throw new Error("entry must name a source file")
  for (const [path, digest] of Object.entries(files)) {
    filePath(path, `files.${path}`)
    hash(digest, `files.${path}`)
  }

  const compatibility = record(manifest.compatibility, "compatibility")
  string(compatibility.kit, "compatibility.kit")
  string(compatibility.chrome, "compatibility.chrome")

  const artifacts = record(manifest.artifacts, "artifacts")
  hash(artifacts.css, "artifacts.css")
  if (manifest.runtime === "declarative-v1" && artifacts.view === undefined) throw new Error("declarative-v1 requires artifacts.view")
  if (manifest.runtime === "declarative-v1" && artifacts.script !== undefined) throw new Error("declarative-v1 cannot contain artifacts.script")
  if ((manifest.runtime === "script-v1" || manifest.runtime === "sandbox-v1") && artifacts.script === undefined) {
    throw new Error(`${manifest.runtime} requires artifacts.script`)
  }
  if ((manifest.runtime === "script-v1" || manifest.runtime === "sandbox-v1") && artifacts.view !== undefined) {
    throw new Error(`${manifest.runtime} cannot contain artifacts.view`)
  }
  if (manifest.runtime === "sandbox-v1" && manifest.capabilities === undefined) throw new Error("sandbox-v1 requires capabilities")
  if (manifest.runtime !== "sandbox-v1" && manifest.capabilities !== undefined) throw new Error("capabilities are only valid for sandbox-v1")
  if (manifest.capabilities !== undefined) parseSandboxCapabilities(manifest.capabilities)
  if (artifacts.view !== undefined) hash(artifacts.view, "artifacts.view")
  if (artifacts.script !== undefined) hash(artifacts.script, "artifacts.script")

  const previews = record(manifest.previews, "previews")
  hash(previews.before, "previews.before")
  hash(previews.after, "previews.after")

  const permissions = record(manifest.permissions, "permissions")
  const page = strings(permissions.page, "permissions.page")
  unique(page, "permissions.page")
  for (const permission of page) {
    if (!PAGE_PERMISSIONS.has(permission as PagePermission)) {
      throw new Error(`permissions.page contains unsupported permission ${JSON.stringify(permission)}`)
    }
  }
  const network = strings(permissions.network, "permissions.network")
  unique(network, "permissions.network")
  for (const host of network) origin(host, "permissions.network")

  return input as RedesignManifest
}
