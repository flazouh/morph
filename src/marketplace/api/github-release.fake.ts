/**
 * A very small GitHub, in memory: blobs, trees, commits and one branch.
 *
 * The release adapter is a protocol, and a protocol is only right if the objects it writes
 * read back as the files it was given. A canned response per URL cannot show that, so this
 * fake keeps real git objects instead: a blob holds bytes, a tree holds a snapshot of the
 * repository, a commit points at a tree and a parent, and the branch only moves when a ref
 * update says so. That last part is what makes a lost race a real 422 rather than a mocked
 * one, and it is why a commit that never reached the branch leaves no files behind.
 *
 * Nothing here reaches a network. `fetch` is the only door in.
 */
import { bytesOfBase64, type ReleaseFile } from "./release-content"

const encoder = new TextEncoder()

export const bytesOfFile = (file: ReleaseFile): Uint8Array<ArrayBuffer> =>
  typeof file === "string" ? new Uint8Array(encoder.encode(file)) : bytesOfBase64(file.base64)

export interface Call {
  readonly method: string
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: Readonly<Record<string, unknown>> | null
}

interface Failure {
  readonly match: string
  readonly status: number
  readonly message: string
}

interface Commit {
  readonly tree: string
  readonly parent: string | null
}

const jsonOf = (body: BodyInit | null | undefined): Record<string, unknown> | null =>
  typeof body === "string" ? (JSON.parse(body) as Record<string, unknown>) : null

const headersOf = (init?: RequestInit): Record<string, string> =>
  init?.headers === undefined ? {} : { ...(init.headers as Record<string, string>) }

const text = (value: unknown): string => (typeof value === "string" ? value : "")

const list = (value: unknown): ReadonlyArray<Record<string, unknown>> =>
  Array.isArray(value) ? (value as ReadonlyArray<Record<string, unknown>>) : []

export interface GitHubFakeOptions {
  readonly repository?: string
  readonly branch?: string
  /** Runs before every answer, so a test can push to the branch mid-flight. */
  readonly onCall?: (call: Call) => void
}

export const gitHubFake = (options: GitHubFakeOptions = {}) => {
  const [owner = "", name = ""] = (options.repository ?? "flazouh/morph-packages").split("/")
  const branch = options.branch ?? "main"
  const calls: Call[] = []
  const failures: Failure[] = []
  const blobs = new Map<string, Uint8Array<ArrayBuffer>>()
  const trees = new Map<string, Map<string, string>>()
  const commits = new Map<string, Commit>()
  let head: string | null = null
  let ids = 0

  const sha = (kind: string): string => `${kind}${++ids}`.padEnd(40, "0")

  const snapshot = (commit: string): Map<string, string> =>
    trees.get(commits.get(commit)?.tree ?? "") ?? new Map()

  const store = (tree: Map<string, string>, parent: string | null): string => {
    const treeSha = sha("tree")
    trees.set(treeSha, new Map(tree))
    const commitSha = sha("commit")
    commits.set(commitSha, { tree: treeSha, parent })
    head = commitSha
    return commitSha
  }

  /** One commit that writes these files, the way a hand-made history is built. */
  const seed = (files: Readonly<Record<string, ReleaseFile>>, folder = ""): string => {
    const tree = new Map(head === null ? [] : snapshot(head))
    for (const [path, file] of Object.entries(files)) {
      const blob = sha("blob")
      blobs.set(blob, bytesOfFile(file))
      tree.set(folder === "" ? path : `${folder}/${path}`, blob)
    }
    return store(tree, head)
  }

  const under = (commit: string | null, folder: string): string =>
    commit === null
      ? "[]"
      : JSON.stringify(
          [...snapshot(commit)]
            .filter(([path]) => path === folder || path.startsWith(`${folder}/`))
            .sort()
        )

  /** The newest commit on the branch that changed anything under the folder. */
  const touching = (folder: string): string | null => {
    for (let commit = head; commit !== null; commit = commits.get(commit)?.parent ?? null) {
      const parent = commits.get(commit)?.parent ?? null
      if (under(commit, folder) !== under(parent, folder)) return commit
    }
    return null
  }

  const listing = (folder: string, ref: string): ReadonlyArray<Record<string, unknown>> | null => {
    const files = snapshot(ref)
    const children = new Map<string, "file" | "dir">()
    for (const path of files.keys()) {
      if (!path.startsWith(`${folder}/`)) continue
      const rest = path.slice(folder.length + 1)
      children.set(rest.split("/")[0] ?? "", rest.includes("/") ? "dir" : "file")
    }
    if (children.size === 0) return null
    return [...children]
      .sort(([left], [right]) => (left < right ? -1 : 1))
      .map(([child, type]) => ({
        type,
        name: child,
        path: `${folder}/${child}`,
        sha: type === "file" ? (files.get(`${folder}/${child}`) ?? "") : sha("tree"),
        size: blobs.get(files.get(`${folder}/${child}`) ?? "")?.length ?? 0
      }))
  }

  const decoded = (pathname: string): string => pathname.split("/").map(decodeURIComponent).join("/")

  const notFound = (): Response => Response.json({ message: "Not Found" }, { status: 404 })

  const api = (route: string, method: string, url: URL, body: Record<string, unknown> | null): Response => {
    if (method === "GET" && route === "/commits") {
      if (url.searchParams.get("sha") !== branch) return notFound()
      const commit = touching(url.searchParams.get("path") ?? "")
      return Response.json(commit === null ? [] : [{ sha: commit }])
    }
    if (method === "GET" && route.startsWith("/contents/")) {
      const entries = listing(route.slice("/contents/".length), url.searchParams.get("ref") ?? "")
      return entries === null ? notFound() : Response.json(entries)
    }
    if (method === "GET" && route.startsWith("/git/blobs/")) {
      const bytes = blobs.get(route.slice("/git/blobs/".length))
      return bytes === undefined ? notFound() : new Response(bytes)
    }
    if (method === "POST" && route === "/git/blobs") {
      const content = text(body?.content)
      const bytes = body?.encoding === "base64" ? bytesOfBase64(content) : new Uint8Array(encoder.encode(content))
      const blob = sha("blob")
      blobs.set(blob, bytes)
      return Response.json({ sha: blob }, { status: 201 })
    }
    if (method === "POST" && route === "/git/trees") {
      const tree = new Map(trees.get(text(body?.base_tree)) ?? [])
      for (const entry of list(body?.tree)) tree.set(text(entry.path), text(entry.sha))
      const treeSha = sha("tree")
      trees.set(treeSha, tree)
      return Response.json({ sha: treeSha }, { status: 201 })
    }
    if (method === "POST" && route === "/git/commits") {
      // A commit object exists whether or not a branch ever points at it.
      const commit = sha("commit")
      commits.set(commit, { tree: text(body?.tree), parent: text(list(body?.parents)[0] ?? "") || null })
      return Response.json({ sha: commit }, { status: 201 })
    }
    if (method === "GET" && route.startsWith("/git/commits/")) {
      const target = route.slice("/git/commits/".length)
      const commit = commits.get(target)
      return commit === undefined ? notFound() : Response.json({ sha: target, tree: { sha: commit.tree } })
    }
    if (method === "GET" && route === `/git/ref/heads/${branch}`) {
      return head === null
        ? notFound()
        : Response.json({ ref: `refs/heads/${branch}`, object: { sha: head, type: "commit" } })
    }
    if (method === "PATCH" && route === `/git/refs/heads/${branch}`) {
      const target = text(body?.sha)
      // Only a fast forward, unless the caller asked to overwrite whatever is there.
      if (body?.force !== true && (commits.get(target)?.parent ?? null) !== head) {
        return Response.json({ message: "Update is not a fast forward" }, { status: 422 })
      }
      head = target
      return Response.json({ ref: `refs/heads/${branch}`, object: { sha: target, type: "commit" } })
    }
    return notFound()
  }

  const raw = (pathname: string): Response => {
    const [, rawOwner, rawName, commit = "", ...rest] = decoded(pathname).split("/")
    if (rawOwner !== owner || rawName !== name || !commits.has(commit)) {
      return new Response("404: Not Found", { status: 404 })
    }
    const blob = snapshot(commit).get(rest.join("/"))
    return blob === undefined ? new Response("404: Not Found", { status: 404 }) : new Response(blobs.get(blob))
  }

  const fetchFake = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input))
    const call: Call = {
      method: init?.method ?? "GET",
      url: url.toString(),
      headers: headersOf(init),
      body: jsonOf(init?.body)
    }
    calls.push(call)
    options.onCall?.(call)
    const failure = failures[0]
    if (failure !== undefined && call.url.includes(failure.match)) {
      failures.shift()
      return Response.json({ message: failure.message }, { status: failure.status })
    }
    if (url.host === "raw.githubusercontent.com") return raw(url.pathname)
    if (url.host !== "api.github.com") return notFound()
    const prefix = `/repos/${owner}/${name}`
    const route = decoded(url.pathname)
    return route.startsWith(prefix) ? api(route.slice(prefix.length), call.method, url, call.body) : notFound()
  }

  return {
    fetch: fetchFake,
    calls,
    seed,
    /** The next request whose URL contains `match` answers with this status instead. */
    failOnce: (match: string, status: number, message = "boom"): void => {
      failures.push({ match, status, message })
    },
    head: (): string => head ?? "",
    /** Every file the branch holds under a folder, keyed the way a release names them. */
    filesAt: (folder: string, commit = head ?? ""): Readonly<Record<string, Uint8Array<ArrayBuffer>>> =>
      Object.fromEntries(
        [...snapshot(commit)]
          .filter(([path]) => folder === "" || path.startsWith(`${folder}/`))
          .map(([path, blob]) => [
            folder === "" ? path : path.slice(folder.length + 1),
            blobs.get(blob) ?? new Uint8Array()
          ])
      )
  }
}
