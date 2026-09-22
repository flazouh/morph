/**
 * The guest: this file runs inside the manifest sandbox frame.
 *
 * It has an opaque origin and no extension API. Downloaded package code receives one
 * frozen object, `morph`, whose `request` sends typed data to Morph's trusted host over a
 * private `MessageChannel` and waits for the answer.
 */
import { Effect, Ref } from "effect"
import * as effect from "effect"
import * as SchemaIssue from "effect/SchemaIssue"
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult"
import * as Atom from "effect/unstable/reactivity/Atom"
import * as AtomRegistry from "effect/unstable/reactivity/AtomRegistry"
import * as React from "react"
import * as ReactDOM from "react-dom"
import * as ReactDOMClient from "react-dom/client"
import * as jsxRuntime from "react/jsx-runtime"
import { acceptHostInit } from "./channel"
import { oneEvent } from "./events"
import { installGuestEnvironment } from "./guestEnvironment"
import { LENT_MODULE_IDS, type LentModuleId } from "./lentModules"
import { decodeHostInitOption } from "./messages"
import { makeRequester, SandboxFailure } from "./request"
import { startPackage } from "./start"
import "./guest.css"

/**
 * What sandbox-v1 lends a package, under the names its source imports.
 *
 * One copy of each, rather than a copy per package: an Effect a package builds has to
 * run on the same runtime the guest forks it on, and one React has to own the frame.
 * A package bundles everything else it needs.
 *
 * Keyed by {@link LentModuleId}, so a name added to the list a package's build reads and
 * not to this table is a type error here.
 */
const lent: Readonly<Record<LentModuleId, unknown>> = {
  effect,
  "effect/SchemaIssue": SchemaIssue,
  "effect/unstable/reactivity/AsyncResult": AsyncResult,
  "effect/unstable/reactivity/Atom": Atom,
  "effect/unstable/reactivity/AtomRegistry": AtomRegistry,
  react: React,
  "react-dom": ReactDOM,
  "react-dom/client": ReactDOMClient,
  "react/jsx-runtime": jsxRuntime
}

/** By name, not by lookup: `require("constructor")` must not answer with Object.prototype's. */
const requireLent = (id: string): unknown => {
  if (!Object.hasOwn(lent, id)) {
    throw new Error(`morph.sandbox: no module named ${JSON.stringify(id)}; a package may import ${LENT_MODULE_IDS.join(", ")}`)
  }
  return lent[id as LentModuleId]
}

/**
 * Tells the host how tall the package drew itself, for as long as the frame lives.
 *
 * A frame does not grow with its document, and this one has an opaque origin, so
 * nothing on either side can measure across the boundary. The guest measures and the
 * host sizes: a page takeover that reports nothing stays 150 pixels tall, which is
 * the iframe's own default.
 *
 * The package's own element is measured, never the document. `scrollHeight` on the
 * document element is the larger of the content and the viewport, and the viewport here
 * is the frame the host just sized — so a report could only ever grow, and a list that
 * lost half its rows kept the empty space and pushed the page below it down.
 */
const reportHeight = Effect.fn("sandbox.reportHeight")(function* (port: MessagePort, root: Element) {
  const send = (height: number) => port.postMessage({ type: "morph:size", height })
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      let last = 0
      const measure = () => {
        const height = Math.ceil(root.getBoundingClientRect().height)
        if (height === last) return
        last = height
        send(height)
      }
      const watch = new ResizeObserver(measure)
      watch.observe(root)
      measure()
      return watch
    }),
    (watch) => Effect.sync(() => watch.disconnect())
  )
})

const start = Effect.gen(function* () {
  const connected = yield* Ref.make(false)
  const nonce = location.hash.slice(1)

  const connect = Effect.fn("sandbox.connect")(function* (event: MessageEvent<unknown>) {
    const init = yield* acceptHostInit(connected, {
      nonce,
      sourceIsParent: event.source === parent,
      ports: event.ports.length,
      message: event.data
    })
    const port = event.ports[0]
    if (init._tag === "None" || port === undefined) return
    const packageCss = init.value.css
    if (packageCss !== "") {
      yield* Effect.sync(() => {
        const style = document.createElement("style")
        style.textContent = packageCss
        document.head.append(style)
      })
    }
    const morph = Object.freeze(yield* makeRequester(port))
    const root = document.getElementById("package-root")
    if (root !== null) yield* reportHeight(port, root)
    yield* installGuestEnvironment(morph, init.value.lends, init.value.at)
    const packageProgram = yield* Effect.try({
      try: () => {
        const exports: Record<string, unknown> = {}
        return Function(
          "require",
          "exports",
          "module",
          "morph",
          `"use strict";\n${init.value.code}`
        )(requireLent, exports, { exports }, morph)
      },
      catch: (cause) => new SandboxFailure({ message: cause instanceof Error ? cause.message : "Package failed to start" })
    }).pipe(
      Effect.tapError((failure) =>
        Effect.sync(() =>
          port.postMessage({ type: "morph:start-failed", error: failure.message })
        )
      )
    )
    yield* startPackage(port, packageProgram)
  })

  const init = yield* oneEvent<MessageEvent<unknown>>(
    window,
    "message",
    (event) => {
      if (event.source !== parent || event.ports.length !== 1) return false
      const message = decodeHostInitOption(event.data)
      return message._tag === "Some" && message.value.nonce === nonce
    }
  )
  yield* init.pipe(
    Effect.flatMap(connect),
    Effect.catch((cause) =>
      Effect.sync(() => {
        const root = document.getElementById("package-root")
        if (root !== null) root.textContent = cause.message
      })
    ),
    Effect.forkScoped
  )
  yield* Effect.sync(() => parent.postMessage({ type: "morph:ready" }, "*"))
  return yield* Effect.never
})

Effect.runFork(Effect.scoped(start))
