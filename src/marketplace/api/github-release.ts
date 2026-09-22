/**
 * The release repository, over GitHub's REST API: one shared repo, one branch, one commit
 * per release, and files a reader can fetch without a token.
 *
 * A release folder is immutable, so every question this adapter answers is about identity
 * rather than about content. Did this exact tree already land, from a request whose answer
 * was lost? Then adopt its commit instead of writing a second one. Does the folder hold
 * other bytes? Then it is somebody else's release and this one stops. Did the branch move
 * while the objects were being built? Then nothing is claimed, and the caller tries again.
 *
 * The writes go through git's own objects rather than through the contents API: blobs, one
 * tree on top of the branch's tree, one commit, and a ref update that refuses anything but
 * a fast forward. That last refusal is the whole concurrency story. Two servers publishing
 * at once cannot interleave a half-written folder, because a commit that loses the race
 * never reaches the branch and leaves no file behind.
 *
 * Reads come back through `raw.githubusercontent.com` and are pinned to a commit, so a URL
 * answers with the same bytes forever, and they are fetched with no credentials at all: a
 * release is verified as the reader who installs it will see it, or not at all.
 */
import { messageOf } from "../compiler/error"
import { publicPackageRoot } from "./postgres"
import { GitHubWriteError, PACKAGE_REPOSITORY, type ReleaseGitHub } from "./publishing"
import { sameFiles, type ReleaseFile } from "./release-content"

export type GitHubFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export interface ReleaseGitHubOptions {
  readonly token: string
  /** `owner/repo`, defaulting to the one repository every package release lands in. */
  readonly repository?: string
  readonly branch?: string
  readonly fetch?: GitHubFetch
}

const API = "https://api.github.com"

/** How many requests of one kind are in the air at once, so a release is not a burst. */
const BATCH = 8

/** Fatal on anything that is not UTF-8, so text is only text when it round-trips. */
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

/** The one binary file a release commits. Everything else is text until it proves not. */
const IMAGE = /\.webp$/i

const conflict = (message: string): GitHubWriteError => new GitHubWriteError("conflict", message)

const unavailable = (message: string): GitHubWriteError => new GitHubWriteError("unavailable", message)

const text = (value: unknown): string => (typeof value === "string" ? value : "")

const segments = (value: string): string => value.split("/").map(encodeURIComponent).join("/")

const base64Of = (bytes: Uint8Array): string => {
  let binary = ""
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
  }
  return btoa(binary)
}

/**
 * The shape the file was committed in. It matters beyond taste: an adopted release is
 * recognised by comparing what the repository holds against what this run would write, and
 * the same bytes in the other shape read as a different release.
 */
const fileOf = (path: string, bytes: Uint8Array): ReleaseFile => {
  if (!IMAGE.test(path)) {
    try {
      return decoder.decode(bytes)
    } catch {
      // Not text after all, so the bytes travel as bytes.
    }
  }
  return { base64: base64Of(bytes) }
}

/** What GitHub said went wrong, from its own field, and never a page of HTML. */
const detailOf = async (response: Response): Promise<string> => {
  const body = await response.text().catch(() => "")
  try {
    const parsed: unknown = JSON.parse(body)
    const message = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>).message : null
    if (typeof message === "string" && message !== "") return message
  } catch {
    // Not JSON, so the first line of whatever it was will have to do.
  }
  return body.slice(0, 200)
}

const failed = async (what: string, response: Response): Promise<GitHubWriteError> =>
  unavailable(`${what} failed (${response.status}: ${await detailOf(response)})`)

const batched = async <T, R>(
  items: ReadonlyArray<T>,
  size: number,
  work: (item: T) => Promise<R>
): Promise<ReadonlyArray<R>> => {
  const done: R[] = []
  for (let at = 0; at < items.length; at += size) {
    done.push(...(await Promise.all(items.slice(at, at + size).map((item) => work(item)))))
  }
  return done
}

interface Entry {
  readonly type: string
  readonly path: string
  readonly sha: string
}

export const releaseGitHub = (options: ReleaseGitHubOptions): ReleaseGitHub => {
  const repository = options.repository ?? PACKAGE_REPOSITORY
  const [owner = "", name = ""] = repository.split("/")
  if (owner === "" || name === "" || repository !== `${owner}/${name}`) {
    throw new Error("the package repository must be owner/repo")
  }
  if (options.token === "") throw new Error("the release repository needs a GitHub token")
  const branch = options.branch ?? "main"
  const call = options.fetch ?? fetch
  const repo = `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`

  const send = async (url: string, init: RequestInit): Promise<Response> => {
    try {
      return await call(url, init)
    } catch (cause) {
      throw unavailable(`${url} could not be reached (${messageOf(cause)})`)
    }
  }

  const api = (
    route: string,
    init: { readonly method?: string; readonly body?: unknown; readonly accept?: string } = {}
  ): Promise<Response> =>
    send(`${repo}${route}`, {
      method: init.method ?? "GET",
      headers: {
        Accept: init.accept ?? "application/vnd.github+json",
        Authorization: `Bearer ${options.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "morph-release",
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" })
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) })
    })

  const recordOf = async (response: Response, what: string): Promise<Record<string, unknown>> => {
    const value: unknown = await response.json().catch(() => null)
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw unavailable(`${what} answered with no JSON object`)
    }
    return value as Record<string, unknown>
  }

  const shaOf = async (response: Response, what: string): Promise<string> => {
    if (!response.ok) throw await failed(what, response)
    const sha = text((await recordOf(response, what)).sha)
    if (sha === "") throw unavailable(`${what} answered with no sha`)
    return sha
  }

  /** A sha one level down, as `object.sha` and `tree.sha` both are. */
  const shaIn = (value: Record<string, unknown>, key: string): string => {
    const nested = value[key]
    return typeof nested === "object" && nested !== null ? text((nested as Record<string, unknown>).sha) : ""
  }

  /**
   * The newest commit on the branch that changed anything under the folder, which for a
   * folder nobody ever rewrites is the commit that published it.
   */
  const commitOfFolder = async (folder: string): Promise<string | null> => {
    const query = new URLSearchParams({ sha: branch, path: folder, per_page: "1" })
    const response = await api(`/commits?${query.toString()}`)
    // An empty repository has no history to search, and no release in it either.
    if (response.status === 409) return null
    if (!response.ok) throw await failed(`reading the history of ${folder}`, response)
    const history: unknown = await response.json().catch(() => null)
    if (!Array.isArray(history)) throw unavailable(`the history of ${folder} is not a list`)
    const newest = (history as ReadonlyArray<Record<string, unknown>>)[0]
    const sha = newest === undefined ? "" : text(newest.sha)
    return sha === "" ? null : sha
  }

  const listing = async (folder: string, ref: string): Promise<ReadonlyArray<Entry> | null> => {
    const response = await api(`/contents/${segments(folder)}?ref=${encodeURIComponent(ref)}`)
    if (response.status === 404) return null
    if (!response.ok) throw await failed(`listing ${folder}`, response)
    const entries: unknown = await response.json().catch(() => null)
    if (!Array.isArray(entries)) throw unavailable(`${folder} is a file rather than a folder`)
    return (entries as ReadonlyArray<Record<string, unknown>>).map((entry) => ({
      type: text(entry.type),
      path: text(entry.path),
      sha: text(entry.sha)
    }))
  }

  const bytesOf = async (entry: Entry): Promise<Uint8Array> => {
    // The raw media type rather than the base64 field: no size ceiling, and no line breaks
    // to strip out of bytes that a digest is about to be taken over.
    const response = await api(`/git/blobs/${encodeURIComponent(entry.sha)}`, {
      accept: "application/vnd.github.raw"
    })
    if (!response.ok) throw await failed(`reading ${entry.path}`, response)
    return new Uint8Array(await response.arrayBuffer())
  }

  /** Every file under the folder at one commit, keyed the way a release names them. */
  const treeAt = async (folder: string, ref: string, root: string): Promise<Record<string, ReleaseFile> | null> => {
    const entries = await listing(folder, ref)
    if (entries === null) return null
    const unreadable = entries.find((entry) => entry.type !== "file" && entry.type !== "dir")
    if (unreadable !== undefined) {
      // A release folder holds files and folders. A symlink or a submodule in one is
      // somebody else's tree, and reading around it would adopt a release nobody published.
      throw unavailable(`${unreadable.path} is a ${unreadable.type}, which a release never commits`)
    }
    const files: Record<string, ReleaseFile> = {}
    for (const [path, file] of await batched(
      entries.filter((entry) => entry.type === "file"),
      BATCH,
      async (entry) => [entry.path.slice(root.length + 1), fileOf(entry.path, await bytesOf(entry))] as const
    )) {
      files[path] = file
    }
    for (const entry of entries.filter((item) => item.type === "dir")) {
      Object.assign(files, (await treeAt(entry.path, ref, root)) ?? {})
    }
    return files
  }

  const existing: ReleaseGitHub["existing"] = async ({ path }) => {
    const commit = await commitOfFolder(path)
    if (commit === null) return null
    // The commit that last touched the folder may be the one that emptied it again.
    const files = await treeAt(path, commit, path)
    return files === null ? null : { commit, files }
  }

  const headOf = async (): Promise<{ readonly commit: string; readonly tree: string }> => {
    const ref = await api(`/git/ref/heads/${segments(branch)}`)
    if (!ref.ok) throw await failed(`reading ${branch}`, ref)
    const commit = shaIn(await recordOf(ref, `reading ${branch}`), "object")
    if (commit === "") throw unavailable(`${branch} names no commit`)
    const response = await api(`/git/commits/${encodeURIComponent(commit)}`)
    if (!response.ok) throw await failed(`reading commit ${commit}`, response)
    const tree = shaIn(await recordOf(response, `reading commit ${commit}`), "tree")
    if (tree === "") throw unavailable(`commit ${commit} names no tree`)
    return { commit, tree }
  }

  const blobOf = async (file: ReleaseFile, path: string): Promise<string> =>
    shaOf(
      await api("/git/blobs", {
        method: "POST",
        // Text as text and bytes as the base64 they arrived in: neither is re-encoded on
        // the way through, so what the digests were taken over is what GitHub stores.
        body:
          typeof file === "string"
            ? { content: file, encoding: "utf-8" }
            : { content: file.base64, encoding: "base64" }
      }),
      `writing ${path}`
    )

  return {
    repository,
    existing,
    commit: async ({ path, files, message }) => {
      const found = await existing({ path })
      if (found !== null) {
        // The same tree is this same release, from a commit whose answer never arrived.
        if (sameFiles(found.files, files)) return { commit: found.commit }
        throw conflict(`${path} already holds a different release`)
      }
      const head = await headOf()
      // One blob at a time: GitHub asks for a token's mutative requests to be made
      // serially, and a burst of them is what its secondary rate limit is looking for.
      const tree: Array<Record<string, string>> = []
      for (const file of Object.keys(files).sort()) {
        tree.push({
          path: `${path}/${file}`,
          mode: "100644",
          type: "blob",
          sha: await blobOf(files[file] ?? "", file)
        })
      }
      const written = await shaOf(
        await api("/git/trees", { method: "POST", body: { base_tree: head.tree, tree } }),
        "writing the release tree"
      )
      const commit = await shaOf(
        await api("/git/commits", { method: "POST", body: { message, tree: written, parents: [head.commit] } }),
        "writing the release commit"
      )
      // No force: the branch takes the commit only if it still stands where it stood when
      // the tree was built. Anything else is a race this release lost, and can rerun.
      const update = await api(`/git/refs/heads/${segments(branch)}`, {
        method: "PATCH",
        body: { sha: commit, force: false }
      })
      if (update.ok) return { commit }
      if (update.status === 409 || update.status === 422) {
        throw conflict(`${branch} moved past ${head.commit} before the release commit landed`)
      }
      throw await failed(`updating ${branch}`, update)
    },
    read: async ({ commit, path, files }) => {
      const root = publicPackageRoot({ owner, repository: name, commit, path })
      return Object.fromEntries(
        await batched(files, BATCH, async (file) => {
          // No credentials: the release is checked as the reader who installs it sees it.
          const response = await send(`${root}/${segments(file)}`, { method: "GET" })
          // A commit is public a moment before its files are, and the raw host says so with
          // a 404 or a 503. Neither is a bad release, so both are a wait rather than a no.
          if (response.status === 404 || response.status >= 500) return [file, null] as const
          if (!response.ok) throw await failed(`reading ${file}`, response)
          return [file, fileOf(file, new Uint8Array(await response.arrayBuffer()))] as const
        })
      )
    }
  }
}
