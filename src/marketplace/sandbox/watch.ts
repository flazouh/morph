import { Deferred, Effect, Fiber, Option, Ref, Scope, Stream } from "effect"
import type { InstalledLibrary } from "../installer"
import { eventStream } from "./events"
import {
  CapabilityPortFailure,
  type CapabilityManifest,
  type CapabilityPorts,
  type FetchRequest
} from "./firewall"
import { sandboxOn, type SandboxInstall } from "./installed"
import { mountSandbox } from "./mount"
import { takePage } from "./takeover"

export interface InstalledSandboxWatch {
  readonly document: Document
  readonly location: Pick<Location, "origin" | "pathname">
  readonly sandboxUrl: string
  readonly library: () => Effect.Effect<InstalledLibrary>
  /** A temporary package can override the installed library without changing it. */
  readonly current?: () => Effect.Effect<SandboxInstall | undefined>
  /** Local preview changes that must remount the current package. */
  readonly changes?: EventTarget
  readonly onRefresh?: (installed: SandboxInstall | undefined, mounted: boolean) => void
  readonly fetchPage: (request: FetchRequest) => Effect.Effect<unknown, CapabilityPortFailure>
  readonly readPage?: CapabilityPorts["read"]
  readonly navigatePage?: CapabilityPorts["navigate"]
  readonly traversePage?: CapabilityPorts["traverse"]
  readonly pageContext?: CapabilityPorts["context"]
  readonly loadAsset?: CapabilityPorts["loadAsset"]
  readonly storage?: CapabilityPorts["storage"]
}

const unavailable = (message: string) => Effect.fail(new CapabilityPortFailure({ message }))

const portsFor = (
  options: InstalledSandboxWatch,
  stepAside: Effect.Effect<void>
): CapabilityPorts => ({
  read: options.readPage ?? (() => unavailable("page read is not declared")),
  fetch: options.fetchPage,
  navigate: options.navigatePage ?? (() => unavailable("navigation is not declared")),
  traverse: options.traversePage ?? (() => unavailable("page traversal is not declared")),
  context: options.pageContext ?? (() => unavailable("page context is not declared")),
  restore: () => stepAside,
  loadAsset: options.loadAsset ?? (() => unavailable("assets are not declared")),
  storage: options.storage ?? {
    get: () => unavailable("storage is not declared"),
    set: () => unavailable("storage is not declared")
  },
  secureSubmit: () => unavailable("secure forms are not declared")
})

export const mountInstalledSandbox = Effect.fn("sandbox.mountInstalled")(function* (
  options: InstalledSandboxWatch
): Effect.fn.Return<
  Option.Option<{
    readonly host: HTMLElement
    readonly installed: SandboxInstall
    readonly steppedAside: Effect.Effect<void>
  }>,
  never,
  Scope.Scope
> {
  const installed =
    options.current === undefined
      ? sandboxOn(yield* options.library(), options.location)
      : yield* options.current()
  if (installed === undefined || installed.js === "") return Option.none()

  /**
   * The reader asking for GitHub's own page back.
   *
   * Unhiding their dashboard is not enough on its own: the frame keeps the height the
   * package reported and pushes their page down by it. So the package's ask ends the
   * mount, and the releases below take the frame away and put their page back.
   */
  const asked = yield* Deferred.make<void>()

  const takeover = installed.capabilities.takeover
  const taken = yield* Effect.acquireRelease(
    Effect.sync(() => (takeover === undefined ? undefined : takePage(options.document, takeover))),
    (page) =>
      Effect.sync(() => {
        page?.restore()
      })
  )
  const parent = taken?.parent ?? options.document.querySelector("main") ?? options.document.body
  if (parent === null) return Option.none()

  const manifest: CapabilityManifest = {
    slug: installed.slug,
    permissions: installed.capabilities
  }

  const mountedOption = yield* mountSandbox({
    parent,
    sandboxUrl: options.sandboxUrl,
    manifest,
    ports: portsFor(options, Deferred.succeed(asked, undefined).pipe(Effect.asVoid)),
    code: installed.js,
    css: installed.css,
    confirmStart: installed.mode === "temporary",
    hostStyle: [
      "all:initial",
      "display:block",
      "box-sizing:border-box",
      "width:100%",
      "min-height:100%",
      "border:0",
      "background:transparent"
    ].join(";")
  }).pipe(Effect.option)
  if (Option.isNone(mountedOption)) return Option.none()
  const mounted = mountedOption.value

  return Option.some({
    host: mounted.host,
    installed,
    steppedAside: Deferred.await(asked)
  })
})

export const watchInstalledSandboxes = Effect.fn("sandbox.watchInstalled")(function* (
  options: InstalledSandboxWatch
): Effect.fn.Return<void, never, Scope.Scope> {
  const turboLoads = yield* eventStream<Event>(options.document, "turbo:load")
  const view = options.document.defaultView
  const historyChanges =
    view === null ? Stream.empty : yield* eventStream<PopStateEvent>(view, "popstate")
  const navigation = (
    view as (Window & { readonly navigation?: Stream.EventListener<Event> }) | null
  )?.navigation
  const navigationChanges =
    navigation === undefined ? Stream.empty : yield* eventStream<Event>(navigation, "navigatesuccess")
  const packageChanges =
    options.changes === undefined
      ? Stream.empty
      : yield* eventStream<Event>(options.changes, "change")
  const active = yield* Ref.make<Option.Option<Fiber.Fiber<void, never>>>(Option.none())

  const refresh = Effect.fn("sandbox.refreshInstalled")(function* () {
    const previous = yield* Ref.getAndSet(active, Option.none())
    if (Option.isSome(previous)) yield* Fiber.interrupt(previous.value)
    const fiber = yield* Effect.scoped(
      Effect.gen(function* () {
        const mounted = yield* mountInstalledSandbox(options)
        options.onRefresh?.(
          Option.isSome(mounted) ? mounted.value.installed : undefined,
          Option.isSome(mounted)
        )
        if (Option.isSome(mounted)) return yield* mounted.value.steppedAside
      })
    ).pipe(Effect.forkScoped)
    yield* Ref.set(active, Option.some(fiber))
  })

  yield* Stream.merge(
    Stream.merge(Stream.merge(turboLoads, historyChanges), navigationChanges),
    packageChanges
  ).pipe(
    Stream.runForEach(refresh),
    Effect.forkScoped
  )
  yield* refresh()
})
