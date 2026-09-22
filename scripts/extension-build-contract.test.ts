import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { Effect, Schema } from "effect"

class BuildArtifactError extends Schema.TaggedError<BuildArtifactError>()("BuildArtifactError", {
  path: Schema.String,
  cause: Schema.Unknown
}) {}

const Manifest = Schema.Struct({
  manifest_version: Schema.Literal(3),
  name: Schema.Literal("Morph"),
  version: Schema.String,
  minimum_chrome_version: Schema.Literal("135"),
  permissions: Schema.Array(Schema.String),
  host_permissions: Schema.Array(Schema.String),
  background: Schema.Struct({
    service_worker: Schema.String,
    type: Schema.Literal("module")
  }),
  sandbox: Schema.Struct({ pages: Schema.Array(Schema.String) }),
  content_security_policy: Schema.Struct({
    extension_pages: Schema.String,
    sandbox: Schema.String
  }),
  content_scripts: Schema.Array(
    Schema.Struct({
      matches: Schema.Array(Schema.String),
      js: Schema.Array(Schema.String),
      run_at: Schema.Literal("document_idle")
    })
  ),
  web_accessible_resources: Schema.Array(
    Schema.Struct({
      resources: Schema.Array(Schema.String),
      matches: Schema.Array(Schema.String)
    })
  )
})

const output = resolve(import.meta.dirname, "../.output/chrome-mv3")

const readArtifact = Effect.fn("extensionBuild.readArtifact")(function* (file: string) {
  const path = join(output, file)
  return yield* Effect.tryPromise({
    try: () => readFile(path),
    catch: (cause) => new BuildArtifactError({ path, cause })
  })
})

const readManifest = Effect.fn("extensionBuild.readManifest")(function* () {
  const bytes = yield* readArtifact("manifest.json")
  const json = yield* Effect.try({
    try: () => JSON.parse(new TextDecoder().decode(bytes)) as unknown,
    catch: (cause) => new BuildArtifactError({ path: join(output, "manifest.json"), cause })
  })
  return yield* Schema.decodeUnknownEffect(Manifest)(json)
})

describe("WXT Chrome MV3 build contract", () => {
  test("generates the required manifest behavior", async () => {
    const manifest = await Effect.runPromise(readManifest())

    expect(manifest.permissions).toEqual([
      "storage",
      "unlimitedStorage",
      "userScripts",
      "activeTab",
      "scripting",
      "tabs"
    ])
    expect(manifest.host_permissions).toEqual(["<all_urls>"])
    expect(manifest.background).toEqual({ service_worker: "background.js", type: "module" })
    expect(manifest.sandbox.pages).toEqual(["sandbox.html"])
    expect(manifest.content_scripts).toEqual([
      {
        matches: ["<all_urls>"],
        js: ["content-scripts/content.js"],
        run_at: "document_idle"
      }
    ])
    expect(manifest.content_security_policy.extension_pages).toBe(
      "script-src 'self'; object-src 'none'; frame-src 'self'"
    )
    expect(manifest.content_security_policy.sandbox).toContain("sandbox allow-scripts")

    const resources = manifest.web_accessible_resources.flatMap(({ resources }) => resources)
    expect(resources).toEqual([
      "panel.html",
      "sandbox.html",
      "kit.js",
      "declarative.js",
      "assets/*",
      "chunks/*",
      "fonts/*"
    ])
  })

  test("writes every runtime artifact loaded by file name", async () => {
    const files = [
      "panel.html",
      "sandbox.html",
      "kit.js",
      "declarative.js"
    ]
    const artifacts = await Effect.runPromise(
      Effect.all(files.map(readArtifact), { concurrency: "unbounded" })
    )
    expect(artifacts.every(({ byteLength }) => byteLength > 0)).toBe(true)
  })

  test("ships the icon set as a JSON asset the service worker can fetch, since it cannot import() a chunk", async () => {
    const bytes = await Effect.runPromise(readArtifact("hugeicons.json"))
    const packed = JSON.parse(new TextDecoder().decode(bytes)) as { d: Array<string>; icons: Record<string, unknown> }
    expect(packed.d.length).toBeGreaterThan(4000)
    expect(Object.keys(packed.icons).length).toBeGreaterThan(4000)
    expect(Array.isArray(packed.icons["Search01Icon"])).toBe(true)
  })
})
