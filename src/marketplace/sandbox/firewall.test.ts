import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { CapabilityPortFailure, capabilityFirewall, type CapabilityManifest, type CapabilityPorts } from "./firewall"

const manifest: CapabilityManifest = {
  slug: "flazouh/focus",
  permissions: {
    page: {
      read: ["#repo-content"],
      navigate: ["https://github.com"]
    },
    network: [
      {
        origin: "https://api.github.com",
        paths: ["/user"],
        methods: ["GET"],
        credentials: "omit",
        headers: ["Accept"]
      }
    ],
    storage: true,
    secureForms: ["login"]
  }
}

const harness = () => {
  const calls: string[] = []
  const values = new Map<string, unknown>()
  const ports: CapabilityPorts = {
    read: (selector) =>
      Effect.sync(() => {
        calls.push(`read:${selector}`)
        return { text: "Pull requests" }
      }),
    fetch: (request) =>
      Effect.sync(() => {
        calls.push(`fetch:${request.url}:${request.accept ?? "default"}:${request.credentials}`)
        return { status: 200, body: { login: "octocat" } }
      }),
    navigate: (url, target) =>
      Effect.sync(() => {
        calls.push(`navigate:${url}:${target}`)
      }),
    traverse: (delta) =>
      Effect.sync(() => {
        calls.push(`traverse:${delta}`)
      }),
    context: () => Effect.fail(new CapabilityPortFailure({ message: "page context is not declared" })),
    restore: () => Effect.fail(new CapabilityPortFailure({ message: "page takeover is not declared" })),
    loadAsset: () => Effect.fail(new CapabilityPortFailure({ message: "assets are not declared" })),
    storage: {
      get: (key) => Effect.sync(() => values.get(key)),
      set: (key, value) => Effect.sync(() => values.set(key, value))
    },
    secureSubmit: (form, fields) =>
      Effect.sync(() => {
        calls.push(`submit:${form}:${String(fields.password)}`)
      })
  }
  return { calls, run: capabilityFirewall(manifest, ports), values, ports }
}

const execute = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

describe("capability firewall", () => {
  test("allows only declared page and network access", async () => {
    const { calls, run } = harness()

    await expect(execute(run({ id: "1", capability: "page.read", selector: "#repo-content" }))).resolves.toMatchObject({ ok: true })
    await expect(execute(run({ id: "2", capability: "network.fetch", url: "https://api.github.com/user", method: "GET" }))).resolves.toMatchObject({
      ok: true
    })
    await expect(
      execute(run({ id: "3", capability: "network.fetch", url: "https://api.github.com/user", method: "GET", accept: "application/json" }))
    ).resolves.toMatchObject({ ok: true })
    await expect(execute(run({ id: "4", capability: "network.fetch", url: "https://evil.example/collect", method: "GET" }))).resolves.toEqual({
      id: "4",
      ok: false,
      error: "network origin is not declared"
    })

    expect(calls).toEqual([
      "read:#repo-content",
      "fetch:https://api.github.com/user:default:omit",
      "fetch:https://api.github.com/user:application/json:omit"
    ])
  })

  test("grants only the declared headers and credentials for an authenticated route", async () => {
    const requests: unknown[] = []
    const sessionManifest = {
      ...manifest,
      permissions: {
        ...manifest.permissions,
        network: [
          {
            origin: "https://github.com",
            paths: ["/pulls/inbox/queries"],
            methods: ["GET"],
            credentials: "include",
            headers: ["Accept", "X-Requested-With"]
          }
        ]
      }
    } satisfies CapabilityManifest
    const run = capabilityFirewall(sessionManifest, {
      ...harness().ports,
      fetch: (request) =>
        Effect.sync(() => {
          requests.push(request)
          return { status: 200, body: { results: [] } }
        })
    })

    await expect(
      execute(
        run({
          id: "github",
          capability: "network.fetch",
          url: "https://github.com/pulls/inbox/queries?filter=needs-action",
          method: "GET",
          accept: "application/json",
          requestedWith: "XMLHttpRequest"
        })
      )
    ).resolves.toMatchObject({ ok: true })
    expect(requests).toEqual([
      {
        url: "https://github.com/pulls/inbox/queries?filter=needs-action",
        method: "GET",
        accept: "application/json",
        requestedWith: "XMLHttpRequest",
        credentials: "include",
        body: undefined,
        contentType: undefined,
        verifiedFetch: undefined
      }
    ])
    await expect(
      execute(
        run({
          id: "profile",
          capability: "network.fetch",
          url: "https://github.com/settings/profile",
          method: "GET"
        })
      )
    ).resolves.toEqual({ id: "profile", ok: false, error: "network path is not declared" })
  })

  test("namespaces storage by package slug", async () => {
    const { run, values } = harness()

    await expect(execute(run({ id: "1", capability: "storage.set", key: "last-pr", value: 42 }))).resolves.toEqual({
      id: "1",
      ok: true,
      value: null
    })
    await expect(execute(run({ id: "2", capability: "storage.get", key: "last-pr" }))).resolves.toEqual({
      id: "2",
      ok: true,
      value: 42
    })
    expect([...values.keys()]).toEqual(["morph-package:flazouh/focus:last-pr"])
  })

  test("keeps secret values outside the package request", async () => {
    const { calls, run } = harness()
    const request = { id: "1", capability: "secure.submit", form: "login" } as const

    await expect(execute(run(request, { password: "secret" }))).resolves.toEqual({ id: "1", ok: true, value: null })
    expect(calls).toEqual(["submit:login:secret"])
  })

  test("rejects malformed and undeclared requests without calling a port", async () => {
    const { calls, run } = harness()

    await expect(execute(run({ id: "1", capability: "page.read", selector: "input[type=password]" }))).resolves.toEqual({
      id: "1",
      ok: false,
      error: "page selector is not declared"
    })
    await expect(execute(run({ id: "2", capability: "network.fetch", url: "not a url", method: "GET" }))).resolves.toEqual({
      id: "2",
      ok: false,
      error: "network URL is invalid"
    })
    await expect(execute(run({ id: "3", capability: "network.fetch", url: "https://api.github.com/user", method: "POST" }))).resolves.toEqual({
      id: "3",
      ok: false,
      error: "network method is not allowed"
    })
    await expect(
      execute(run({ id: "4", capability: "network.fetch", url: "https://api.github.com/user", method: "GET", accept: "text/plain" }))
    ).resolves.toEqual({ id: "4", ok: false, error: "capability request is invalid" })
    await expect(execute(run({ id: "5", capability: "secure.submit", form: "login", password: "leak" }))).resolves.toEqual({
      id: "5",
      ok: false,
      error: "capability request is invalid"
    })
    await expect(execute(run({ id: "6", capability: "page.navigate", url: "https://evil.example" }))).resolves.toEqual({
      id: "6",
      ok: false,
      error: "navigation origin is not declared"
    })
    await expect(execute(run({ id: "7", capability: "page.navigate", url: "javascript:alert(1)" }))).resolves.toEqual({
      id: "7",
      ok: false,
      error: "navigation URL is invalid"
    })

    expect(calls).toEqual([])
  })

  test("denies storage and secure forms that the manifest did not declare", async () => {
    const restricted = capabilityFirewall(
      { ...manifest, permissions: { ...manifest.permissions, storage: false, secureForms: [] } },
      harness().ports
    )

    await expect(execute(restricted({ id: "1", capability: "storage.get", key: "x" }))).resolves.toMatchObject({
      ok: false,
      error: "storage is not declared"
    })
    await expect(execute(restricted({ id: "2", capability: "secure.submit", form: "login" }))).resolves.toMatchObject({
      ok: false,
      error: "secure form is not declared"
    })
  })

  test("allows a declared POST write and denies an undeclared one", async () => {
    const writes: unknown[] = []
    const writeManifest = {
      ...manifest,
      permissions: {
        ...manifest.permissions,
        network: [
          {
            origin: "https://github.com",
            paths: ["/octo/repo/pull/1/page_data/close_pull_request"],
            methods: ["POST"] as const,
            credentials: "include" as const,
            headers: ["Accept", "Content-Type", "GitHub-Verified-Fetch"] as const
          }
        ]
      }
    } satisfies CapabilityManifest
    const run = capabilityFirewall(writeManifest, {
      ...harness().ports,
      fetch: (request) =>
        Effect.sync(() => {
          writes.push(request)
          return { status: 200, body: {} }
        })
    })

    await expect(
      execute(
        run({
          id: "close",
          capability: "network.fetch",
          url: "https://github.com/octo/repo/pull/1/page_data/close_pull_request",
          method: "POST",
          accept: "application/json",
          body: "{\"state\":\"closed\"}",
          contentType: "application/json",
          verifiedFetch: true
        })
      )
    ).resolves.toMatchObject({ ok: true })
    expect(writes).toEqual([
      {
        url: "https://github.com/octo/repo/pull/1/page_data/close_pull_request",
        method: "POST",
        accept: "application/json",
        requestedWith: undefined,
        credentials: "include",
        body: "{\"state\":\"closed\"}",
        contentType: "application/json",
        verifiedFetch: true
      }
    ])
    await expect(
      execute(
        run({
          id: "merge",
          capability: "network.fetch",
          url: "https://github.com/octo/repo/pull/1/page_data/merge",
          method: "POST"
        })
      )
    ).resolves.toEqual({ id: "merge", ok: false, error: "network path is not declared" })
  })

  test("answers page context, restore, and asset loads only when declared", async () => {
    const calls: string[] = []
    const run = capabilityFirewall(
      {
        ...manifest,
        permissions: {
          ...manifest.permissions,
          takeover: { slot: '[data-testid="pulls-dashboard-surface-layout"]' },
          context: { viewer: true, theme: true, route: true },
          assets: ["https://avatars.githubusercontent.com"]
        }
      },
      {
        ...harness().ports,
        context: () =>
          Effect.sync(() => {
            calls.push("context")
            return { signedIn: true, login: "octocat", faceUrl: undefined, colorMode: "dark", path: "/pulls" } as const
          }),
        restore: () =>
          Effect.sync(() => {
            calls.push("restore")
          }),
        loadAsset: (url) =>
          Effect.sync(() => {
            calls.push(`asset:${url}`)
            return "data:image/png;base64,aaa"
          })
      }
    )

    await expect(execute(run({ id: "1", capability: "page.context" }))).resolves.toMatchObject({
      ok: true,
      value: { login: "octocat", path: "/pulls" }
    })
    await expect(execute(run({ id: "2", capability: "page.restore" }))).resolves.toMatchObject({ ok: true })
    await expect(
      execute(run({ id: "3", capability: "assets.load", url: "https://avatars.githubusercontent.com/u/1" }))
    ).resolves.toMatchObject({ ok: true, value: "data:image/png;base64,aaa" })
    expect(calls).toEqual(["context", "restore", "asset:https://avatars.githubusercontent.com/u/1"])

    const denied = capabilityFirewall(manifest, {
      ...harness().ports,
      context: () => Effect.die("unused"),
      restore: () => Effect.die("unused"),
      loadAsset: () => Effect.die("unused")
    })
    await expect(execute(denied({ id: "4", capability: "page.context" }))).resolves.toEqual({
      id: "4",
      ok: false,
      error: "page context is not declared"
    })
    await expect(execute(denied({ id: "5", capability: "page.restore" }))).resolves.toEqual({
      id: "5",
      ok: false,
      error: "page takeover is not declared"
    })
    await expect(
      execute(denied({ id: "6", capability: "assets.load", url: "https://avatars.githubusercontent.com/u/1" }))
    ).resolves.toEqual({ id: "6", ok: false, error: "asset origin is not declared" })
  })

  test("refuses an asset from an origin the package did not name", async () => {
    const run = capabilityFirewall(
      {
        ...manifest,
        permissions: { ...manifest.permissions, assets: ["https://avatars.githubusercontent.com"] }
      },
      { ...harness().ports, loadAsset: () => Effect.die("unused") }
    )
    // A declared origin is not a declared internet: the host fetches whatever it is given.
    await expect(
      execute(run({ id: "1", capability: "assets.load", url: "https://tracker.example/pixel.png" }))
    ).resolves.toEqual({ id: "1", ok: false, error: "asset origin is not declared" })
    await expect(
      execute(run({ id: "2", capability: "assets.load", url: "http://avatars.githubusercontent.com/u/1" }))
    ).resolves.toEqual({ id: "2", ok: false, error: "asset URL is invalid" })
  })

  test("opens a declared navigation in a new tab", async () => {
    const { calls, run } = harness()
    await expect(
      execute(run({ id: "1", capability: "page.navigate", url: "https://github.com/octo/repo/pull/1", target: "_blank" }))
    ).resolves.toMatchObject({ ok: true })
    expect(calls).toContain("navigate:https://github.com/octo/repo/pull/1:_blank")
  })

  test("refuses to walk the tab's history for a package that did not declare it", async () => {
    const { calls, run } = harness()
    await expect(execute(run({ id: "1", capability: "page.traverse", delta: -1 }))).resolves.toEqual({
      id: "1",
      ok: false,
      error: "page traversal is not declared"
    })
    expect(calls).toEqual([])
  })

  test("walks the tab's history where the package declared it, and only by whole steps in reach", async () => {
    const walking = capabilityFirewall(
      { ...manifest, permissions: { ...manifest.permissions, page: { ...manifest.permissions.page, traverse: true } } },
      harness().ports
    )
    const step = (delta: number) => execute(walking({ id: "1", capability: "page.traverse", delta }))

    await expect(step(-1)).resolves.toMatchObject({ ok: true })
    await expect(step(3)).resolves.toMatchObject({ ok: true })
    // Nowhere, a fraction of a page, and further than any menu offers.
    for (const refused of [0, 1.5, 40, -40, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(step(refused)).resolves.toEqual({ id: "1", ok: false, error: "traversal step is invalid" })
    }
  })

  test("returns port failures to the matching package request", async () => {
    const failing = capabilityFirewall(manifest, {
      read: () => Effect.fail(new CapabilityPortFailure({ message: "page disappeared" })),
      fetch: () => Effect.fail(new CapabilityPortFailure({ message: "fetch failed" })),
      navigate: () => Effect.fail(new CapabilityPortFailure({ message: "navigation failed" })),
      traverse: () => Effect.fail(new CapabilityPortFailure({ message: "traversal failed" })),
      context: () => Effect.fail(new CapabilityPortFailure({ message: "context failed" })),
      restore: () => Effect.fail(new CapabilityPortFailure({ message: "restore failed" })),
      loadAsset: () => Effect.fail(new CapabilityPortFailure({ message: "asset failed" })),
      storage: {
        get: () => Effect.fail(new CapabilityPortFailure({ message: "storage failed" })),
        set: () => Effect.fail(new CapabilityPortFailure({ message: "storage failed" }))
      },
      secureSubmit: () => Effect.fail(new CapabilityPortFailure({ message: "form disappeared" }))
    })

    await expect(execute(failing({ id: "request-7", capability: "page.read", selector: "#repo-content" }))).resolves.toEqual({
      id: "request-7",
      ok: false,
      error: "page disappeared"
    })
  })
})
