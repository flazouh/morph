/**
 * A visible host page for the sandbox capability model.
 *
 * Open it from the extension to watch package code ask for things and Morph answer or
 * refuse. It exercises every capability with a demo package; production packages mount
 * through `mountSandbox` from the content script instead.
 */
import { Effect } from "effect"
import "@/styles/globals.css"
import "./host.css"
import { CapabilityPortFailure, type CapabilityManifest, type CapabilityPorts } from "./firewall"
import { mountSandbox } from "./mount"

const manifest: CapabilityManifest = {
  slug: "morph/capability-demo",
  permissions: {
    page: { read: ["#repo-content"], navigate: ["https://github.com"], traverse: false },
    network: [
      {
        origin: "https://api.github.com",
        paths: ["/rate_limit"],
        methods: ["GET"],
        credentials: "omit",
        headers: ["Accept"]
      }
    ],
    storage: true,
    secureForms: ["login"]
  }
}

const packageCode = String.raw`
const { Effect, Stream } = require("effect")

const show = (program) => program.pipe(
  Effect.tap((value) => Effect.sync(() => {
    document.getElementById("result").textContent = JSON.stringify(value, null, 2)
  })),
  Effect.catch((error) => Effect.sync(() => {
    document.getElementById("result").textContent = "Blocked: " + error.message
  }))
)

const packageStart = Effect.gen(function* () {
  const directNetwork = yield* Effect.tryPromise({
    try: () => fetch("https://api.github.com/rate_limit"),
    catch: () => "blocked"
  }).pipe(
    Effect.as("visible"),
    Effect.catch(() => Effect.succeed("blocked"))
  )
  yield* Effect.sync(() => {
    const root = document.getElementById("package-root")
    root.innerHTML = [
      '<strong>Demo package sandbox</strong>',
      '<p id="sandbox-proof"></p>',
      '<button id="read">Read declared page region</button>',
      '<button id="fetch">Fetch declared GitHub API</button>',
      '<button id="blocked">Try blocked external fetch</button>',
      '<button id="navigate">Request navigation</button>',
      '<button id="submit">Submit host-owned password</button>',
      '<pre id="result">Ready.</pre>'
    ].join("")
    document.getElementById("sandbox-proof").textContent =
      "extension API: " + (globalThis.chrome?.runtime?.id ? "visible" : "blocked") +
      " · parent DOM: " + (() => { try { return parent.document.body ? "visible" : "blocked" } catch { return "blocked" } })() +
      " · direct network: " + directNetwork
  })
  const onClick = (id, program) =>
    Stream.fromEventListener(document.getElementById(id), "click").pipe(
      Stream.runForEach(() => show(program)),
      Effect.forkScoped
    )
  yield* onClick("read", morph.request("page.read", { selector: "#repo-content" }))
  yield* onClick("fetch", morph.request("network.fetch", {
    url: "https://api.github.com/rate_limit",
    method: "GET",
    accept: "application/json"
  }))
  yield* onClick("blocked", morph.request("network.fetch", { url: "https://evil.example/collect", method: "GET" }))
  yield* onClick("navigate", morph.request("page.navigate", { url: "https://github.com/pulls" }))
  yield* onClick("submit", morph.request("secure.submit", { form: "login" }))
  return yield* Effect.never
})

return packageStart
`

const required = <A extends Element>(selector: string): A => {
  const element = document.querySelector<A>(selector)
  if (element === null) throw new Error(`Host element ${selector} is missing`)
  return element
}

const fail = (message: string) => new CapabilityPortFailure({ message })

const start = Effect.gen(function* () {
  const page = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const root = required<HTMLElement>("#root")
      root.innerHTML = `
        <main class="sandbox-shell">
          <header>
            <span class="sandbox-kicker">SANDBOX HOST</span>
            <h1>Morph capability firewall</h1>
            <p>Package code runs below. It can reach the host only through declared Effect programs.</p>
          </header>
          <section id="repo-content" class="host-region">
            <strong>Trusted page region</strong>
            <span>Pull requests need your review.</span>
          </section>
          <section class="secure-region">
            <label for="secure-password">Host-owned password</label>
            <input id="secure-password" type="password" value="never-enters-the-package" />
          </section>
          <div id="package-slot"></div>
          <section>
            <strong>Trusted Morph audit log</strong>
            <ol id="audit-log"></ol>
          </section>
        </main>`
      return {
        root,
        password: required<HTMLInputElement>("#secure-password"),
        packageSlot: required<HTMLElement>("#package-slot"),
        audit: required<HTMLOListElement>("#audit-log")
      }
    }),
    ({ root }) => Effect.sync(() => root.replaceChildren())
  )

  const log = (message: string) =>
    Effect.sync(() => {
      const item = document.createElement("li")
      item.textContent = message
      page.audit.prepend(item)
    })

  const ports: CapabilityPorts = {
    read: (selector) =>
      Effect.gen(function* () {
        yield* log(`allowed page.read ${selector}`)
        return yield* Effect.sync(() => ({ text: document.querySelector(selector)?.textContent?.trim() ?? "" }))
      }),
    fetch: ({ url, method, accept, requestedWith, credentials }) =>
      Effect.gen(function* () {
        yield* log(`allowed network.fetch ${url}`)
        const response = yield* Effect.tryPromise({
          try: () =>
            fetch(url, {
              method,
              headers: {
                ...(accept === undefined ? {} : { Accept: accept }),
                ...(requestedWith === undefined ? {} : { "X-Requested-With": requestedWith })
              },
              credentials,
              redirect: "error",
              referrerPolicy: "no-referrer"
            }),
          catch: () => fail("declared network request failed")
        })
        return yield* Effect.tryPromise({
          try: async () => ({
            status: response.status,
            body: accept === "application/json" ? ((await response.json()) as unknown) : await response.text()
          }),
          catch: () => fail("declared network response could not be read")
        })
      }),
    navigate: (url, target) => log(`allowed page.navigate ${url} ${target} (dry run)`),
    traverse: (delta) => log(`allowed page.traverse ${delta} (dry run)`),
    context: () =>
      Effect.succeed({
        signedIn: false,
        login: undefined,
        faceUrl: undefined,
        colorMode: "auto" as const,
        path: location.pathname
      }),
    restore: () => log("allowed page.restore (dry run)"),
    loadAsset: (url) => Effect.succeed(url),
    storage: {
      get: (key) =>
        Effect.tryPromise({
          try: async () => (await chrome.storage.local.get(key))[key],
          catch: () => fail("package storage read failed")
        }),
      set: (key, value) =>
        Effect.tryPromise({
          try: async () => chrome.storage.local.set({ [key]: value }),
          catch: () => fail("package storage write failed")
        })
    },
    secureSubmit: (form, fields) =>
      log(`allowed secure.submit ${form}; Morph received ${fields.password?.length ?? 0} secret characters`)
  }

  yield* mountSandbox({
    parent: page.packageSlot,
    sandboxUrl: "/sandbox.html",
    manifest,
    ports,
    code: packageCode,
    secrets: Effect.sync(() => ({ password: page.password.value })),
    hostStyle:
      "display:block;height:380px;border:1px solid var(--border);border-radius:14px;background:var(--card);overflow:hidden;",
    onDenied: (response) => log(`blocked ${response.id}: ${response.error}`)
  })
  return yield* Effect.never
})

Effect.runFork(Effect.scoped(start))
