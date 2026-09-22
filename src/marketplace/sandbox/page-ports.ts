import { Effect } from "effect"
import { CapabilityPortFailure, type CapabilityPorts, type PageContext } from "./firewall"

const fail = (message: string) => new CapabilityPortFailure({ message })

const meta = (document: Document, name: string): string | undefined => {
  const value = document.querySelector(`meta[name="${name}"]`)?.getAttribute("content")
  return value === null || value === undefined || value === "" ? undefined : value
}

/**
 * The reader's own face, off GitHub's header rather than asked for.
 *
 * GitHub draws it on every signed-in page and carries no meta tag for it, so this is
 * the only place it is written. Undefined where their markup changed, which leaves the
 * package an initial to draw rather than a broken image.
 */
const faceOn = (document: Document): string | undefined => {
  const found = document.querySelector<HTMLImageElement>(
    'img.avatar-user[src], img[data-testid="github-avatar"][src]'
  )
  const said = found?.getAttribute("src") ?? ""
  return said === "" ? undefined : said
}

/**
 * The page's own colour choice, unresolved.
 *
 * `data-color-mode` is `light`, `dark` or `auto`, and it is handed over as it stands
 * rather than turned into a scheme here. A reader who chose GitHub's dark theme on a
 * light desktop must not get a white package inside a black page, and a reader on `auto`
 * must see the package change with the machine — which only the frame can hear, because
 * it is the frame that draws. So the host reports the choice and the package resolves it.
 */
const colorModeOn = (document: Document): PageContext["colorMode"] => {
  const mode = document.documentElement.getAttribute("data-color-mode")
  return mode === "light" || mode === "dark" ? mode : "auto"
}

export const pageContextOf = (document: Document, location: Pick<Location, "pathname">): PageContext => {
  const login = meta(document, "user-login")
  const faceUrl = faceOn(document)
  return {
    signedIn: login !== undefined,
    login,
    faceUrl,
    colorMode: colorModeOn(document),
    path: location.pathname
  }
}

export const makePageContext = (
  document: Document,
  location: Pick<Location, "pathname">
): CapabilityPorts["context"] => () => Effect.sync(() => pageContextOf(document, location))

export const makePageNavigate = (view: Window): CapabilityPorts["navigate"] =>
  Effect.fn("sandbox.pageNavigate")(function* (url, target) {
    yield* Effect.sync(() => {
      if (target === "_blank") {
        view.open(url, "_blank", "noopener")
        return
      }
      view.location.assign(url)
    })
  })

/**
 * Back and forward, for a package whose own frame cannot do it.
 *
 * A sandboxed frame shares the tab's session history but may not walk it, so the
 * package asks and this moves the page it stands on.
 */
export const makePageTraverse = (view: Window): CapabilityPorts["traverse"] =>
  Effect.fn("sandbox.pageTraverse")(function* (delta) {
    yield* Effect.sync(() => view.history.go(delta))
  })

export const makePackageStorage = (area: {
  readonly get: (key: string) => Promise<Record<string, unknown>>
  readonly set: (items: Record<string, unknown>) => Promise<void>
}): CapabilityPorts["storage"] => ({
  get: (key) =>
    Effect.tryPromise({
      try: async () => (await area.get(key))[key],
      catch: () => fail("package storage read failed")
    }),
  set: (key, value) =>
    Effect.tryPromise({
      try: async () => area.set({ [key]: value }),
      catch: () => fail("package storage write failed")
    })
})

export const chromePackageStorage = (): CapabilityPorts["storage"] =>
  makePackageStorage({
    get: (key) => chrome.storage.local.get(key),
    set: (items) => chrome.storage.local.set(items)
  })
