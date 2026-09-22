/**
 * Checks a published package the way a reader's browser will read it.
 *
 * The marketplace stores digests and builds addresses; it never stores a file. So the
 * only thing that proves a package installs is fetching what those addresses point at and
 * hashing it. This walks a package folder from `raw.githubusercontent.com`, parses the
 * manifest, and compares every digest in it against the bytes actually served.
 *
 *   bun scripts/verify-package.ts flazouh/morph-packages <commit> flazouh/focus
 */
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseManifest } from "../src/marketplace/manifest"
import { publicFilesOf, publicPackageRoot } from "../src/marketplace/api/postgres"

const [repository, commit, folder] = process.argv.slice(2)
if (repository === undefined || commit === undefined || folder === undefined) {
  console.error("usage: bun scripts/verify-package.ts <owner/repo> <commit> <package folder>")
  process.exit(1)
}
const [owner, repo] = repository.split("/")
if (owner === undefined || repo === undefined || repository !== `${owner}/${repo}` || owner === "" || repo === "") {
  console.error("the repository must be owner/repo")
  process.exit(1)
}
if (!/^[a-f0-9]{40}$/.test(commit)) {
  console.error("the commit must be a full 40-character hexadecimal SHA")
  process.exit(1)
}
if (folder === "" || folder.startsWith("/") || folder.includes("\\") || folder.split("/").some((part) => part === "" || part === "." || part === "..")) {
  console.error("the package folder must be a repository-relative path")
  process.exit(1)
}

const digestOf = (bytes: ArrayBuffer | Uint8Array): string =>
  `sha256:${createHash("sha256").update(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).digest("hex")}`

/**
 * raw.githubusercontent.com answers 503 for a few seconds after a push, while the commit
 * spreads, so a first miss is not a missing file.
 */
const fetchAfterPublish = async (url: string): Promise<Response> => {
  for (let left = 6; ; left--) {
    const answer = await fetch(url)
    if (answer.ok || answer.status !== 503 || left === 0) return answer
    await new Promise((resume) => setTimeout(resume, 5000))
  }
}

const rawRoot = publicPackageRoot({ owner, repository: repo, commit, path: folder })

const said = await fetchAfterPublish(`${rawRoot}/manifest.json`)
if (!said.ok) {
  console.error(`manifest ${said.status} at ${rawRoot}/manifest.json`)
  process.exit(1)
}
const manifest = parseManifest(await said.json())
const files = publicFilesOf({ owner, repository: repo, commit, path: folder, runtime: manifest.runtime })
console.log(`manifest  ok  ${manifest.slug} ${manifest.version} (${manifest.runtime})`)

const wrong: Array<string> = []

const check = async (name: string, url: string, want: string): Promise<void> => {
  const answer = await fetchAfterPublish(url)
  if (!answer.ok) {
    wrong.push(`${name} ${answer.status}`)
    return
  }
  const got = digestOf(await answer.arrayBuffer())
  if (got !== want) wrong.push(`${name} digest ${got} wanted ${want}`)
  else console.log(`${name.padEnd(9)} ok  ${want}`)
}

if (manifest.runtime === "declarative-v1") {
  await check("view", files.view ?? "", manifest.artifacts.view ?? "")
} else {
  await check("script", files.script ?? "", manifest.artifacts.script ?? "")
}
await check("css", files.css, manifest.artifacts.css)
await check("before", files.before, manifest.previews.before)
await check("after", files.after, manifest.previews.after)

const source = Object.entries(manifest.files)
let checked = 0

// GitHub throttles a burst of small raw-file requests. One archive proves the commit's
// whole source tree without turning package verification into minutes of retries.
const archive = await fetchAfterPublish(`https://github.com/${owner}/${repo}/archive/${commit}.tar.gz`)
if (!archive.ok) {
  wrong.push(`source archive ${archive.status}`)
} else {
  const temporary = await mkdtemp(join(tmpdir(), "morph-package-"))
  try {
    const path = join(temporary, "source.tar.gz")
    await Bun.write(path, await archive.arrayBuffer())
    const unpack = Bun.spawn(["tar", "-xzf", path, "-C", temporary])
    if ((await unpack.exited) !== 0) throw new Error("tar could not read the source archive")
    const packageRoot = join(temporary, `${repo}-${commit}`, folder)
    for (const [path, want] of source) {
      const bytes = await readFile(join(packageRoot, path))
      if (digestOf(bytes) !== want) {
        wrong.push(`${path} digest`)
      } else checked++
    }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}
console.log(`source    ok  ${checked} of ${source.length} files`)

if (wrong.length > 0) {
  for (const line of wrong) console.error(`wrong: ${line}`)
  process.exit(1)
}
console.log("every address the marketplace builds serves the bytes the manifest names")
