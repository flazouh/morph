/**
 * Mounting a package sandbox from Morph's trusted code.
 *
 * The host owns the frame, the nonce, the channel, and the firewall. Package code owns
 * nothing outside its frame. The frame sits in a closed shadow root so page scripts
 * cannot read its URL, which is where the nonce travels.
 */
import { Deferred, Effect, Ref, Scope } from "effect"
import { acceptGuestReady } from "./channel"
import { oneEvent } from "./events"
import { type CapabilityManifest, type CapabilityPorts, type CapabilityResponse, capabilityFirewall } from "./firewall"
import { decodeGuestReadyOption, type HostInit } from "./messages"
import { serveCapabilities } from "./serve"

export interface SandboxMount {
  /** Where the frame goes. The mount appends a host element here. */
  readonly parent: Element
  /** The extension URL of the sandbox page, without a fragment. */
  readonly sandboxUrl: string
  readonly manifest: CapabilityManifest
  readonly ports: CapabilityPorts
  /** The package code the guest runs. */
  readonly code: string
  /** The package's stylesheet, applied inside the frame before its code runs. */
  readonly css?: string
  /** Values Morph holds for `secure.submit`; package code never receives them. */
  readonly secrets?: Effect.Effect<Readonly<Record<string, string>>>
  /** Inline style for the host element, so a caller decides size and placement. */
  readonly hostStyle?: string
  /** Runs for every response the firewall refused. */
  readonly onDenied?: (response: Extract<CapabilityResponse, { ok: false }>) => Effect.Effect<void>
  /** Wait until the guest accepts the package entry before returning. */
  readonly confirmStart?: boolean
}

export interface MountedSandbox {
  readonly host: HTMLElement
  readonly frame: HTMLIFrameElement
}

const FRAME_STYLE = "all:initial;display:block;box-sizing:border-box;width:100%;height:100%;border:0;background:transparent;"

/**
 * Which parts of a browser the guest may stand in for, read off the same manifest the
 * firewall reads.
 *
 * The guest asks the host for each of them, so a package that did not declare the
 * capability would only be refused later. Told here, the guest leaves that part of the
 * frame as it found it and the package meets a sandbox rather than a broken control.
 */
const lendsOf = (manifest: CapabilityManifest): HostInit["lends"] => ({
  storage: manifest.permissions.storage === true,
  navigate: (manifest.permissions.page?.navigate ?? []).length > 0,
  traverse: manifest.permissions.page?.traverse === true,
  assets: (manifest.permissions.assets ?? []).length > 0
})

/** Every attribute the guest frame must carry. `allow-scripts` alone: no same-origin, no forms, no popups, no top navigation. */
const buildFrame = (document: Document): HTMLIFrameElement => {
  const frame = document.createElement("iframe")
  frame.setAttribute("sandbox", "allow-scripts")
  frame.setAttribute("title", "Morph package")
  frame.setAttribute("style", FRAME_STYLE)
  return frame
}

export const mountSandbox = Effect.fn("sandbox.mount")(function* (
  options: SandboxMount
): Effect.fn.Return<MountedSandbox, Error, Scope.Scope> {
  const { document, frame, host, nonce } = yield* Effect.sync(() => {
    const document = options.parent.ownerDocument
    const host = document.createElement("div")
    host.setAttribute("data-morph-sandbox", options.manifest.slug)
    if (options.hostStyle !== undefined) host.setAttribute("style", options.hostStyle)
    const shadow = host.attachShadow({ mode: "closed" })
    const frame = buildFrame(document)
    shadow.append(frame)
    return { document, frame, host, nonce: crypto.randomUUID() }
  })

  const connected = yield* Ref.make(false)
  const started = yield* Deferred.make<void, Error>()
  const run = capabilityFirewall(options.manifest, options.ports)

  const connect = Effect.fn("sandbox.connect")(function* (event: MessageEvent<unknown>) {
    const accepted = yield* acceptGuestReady(connected, {
      sourceMatches: event.source === frame.contentWindow,
      origin: event.origin,
      message: event.data
    })
    if (!accepted) return
    const channel = yield* Effect.sync(() => new MessageChannel())
    yield* serveCapabilities({
      port: channel.port1,
      run,
      secrets: options.secrets ?? Effect.succeed({}),
      onDenied: options.onDenied,
      // The frame belongs to the host, so the package asks rather than resizes.
      onResize: (height) =>
        Effect.sync(() => frame.style.setProperty("height", `${height}px`)),
      onStarted: () => Deferred.succeed(started, undefined).pipe(Effect.asVoid),
      onStartFailed: (error) =>
        Deferred.fail(started, new Error(error)).pipe(Effect.asVoid)
    })
    // "*" because the guest's origin is opaque and no other target matches it. Only the
    // guest window receives this, and only the guest and this host know the nonce.
    yield* Effect.sync(() =>
      frame.contentWindow?.postMessage(
        {
          type: "morph:init",
          nonce,
          code: options.code,
          css: options.css ?? "",
          at: document.defaultView?.location.href ?? "",
          lends: lendsOf(options.manifest)
        },
        "*",
        [channel.port2]
      )
    )
  })

  const view = document.defaultView
  if (view !== null) {
    const ready = yield* oneEvent<MessageEvent<unknown>>(
      view,
      "message",
      (event) =>
        event.source === frame.contentWindow &&
        event.origin === "null" &&
        decodeGuestReadyOption(event.data)._tag === "Some"
    )
    yield* ready.pipe(Effect.flatMap(connect), Effect.forkScoped)
  }
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      options.parent.append(host)
      frame.src = `${options.sandboxUrl}#${nonce}`
    }),
    () => Effect.sync(() => host.remove())
  )
  if (options.confirmStart === true) {
    yield* Deferred.await(started).pipe(
      Effect.timeout("10 seconds"),
      Effect.mapError((error) =>
        error instanceof Error ? error : new Error("the sandbox did not start")
      )
    )
  }

  return { host, frame }
})
