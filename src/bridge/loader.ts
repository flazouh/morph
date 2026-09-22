/**
 * What a persisted registration runs on the page, at `document_start`, so a page loads
 * already redesigned: no frame of the old look first. The package script is the one
 * moment early enough to beat a server-rendered page onto the screen is before the DOM is
 * built, and what is not ready by then is hidden until it is.
 *
 * These functions travel as source (`toString()`), into a script Chrome runs in the page's
 * world. So each one is self-contained: no import, no closure over anything in this module,
 * every name it needs comes in as a parameter, helpers included. `call` below does the
 * wrapping; loader.test.ts runs the generated source, not the functions.
 */

/** `<html>` is invisible while this sheet is on it. */
export const GATE = "redesign-gate"

/** How long one hold may keep the page hidden when DOMContentLoaded is slow to come: a flash of the old look beats a blank page. */
export const GATE_MS = 2000

type Hold = (doc: Document, gateId: string, ms: number) => () => void

/**
 * Hides the page until released. Holds count: the styles sheet and the script each take
 * one, in whichever order Chrome runs their registrations, and the gate comes off when the
 * last is released. A release runs once, whether DOMContentLoaded or the timer got there first.
 */
export function hold(doc: Document, gateId: string, ms: number): () => void {
  const gate = doc.getElementById(gateId) ?? doc.createElement("style")
  if (gate.id !== gateId) {
    gate.id = gateId
    gate.textContent = "html{visibility:hidden!important}"
    doc.documentElement.appendChild(gate)
  }
  const holds = Number(gate.getAttribute("data-holds") ?? "0") + 1
  gate.setAttribute("data-holds", String(holds))
  let released = false
  const release = () => {
    if (released) return
    released = true
    clearTimeout(timer)
    const left = Number(gate.getAttribute("data-holds") ?? "1") - 1
    if (left > 0) gate.setAttribute("data-holds", String(left))
    else gate.remove()
  }
  const timer = setTimeout(release, ms)
  return release
}

/**
 * The design sheet, right after the palette (or first, when the kit is not there yet): tokens
 * only, so position is all it needs. Before the DOM exists it goes at the start of `<html>`,
 * and the palette the kit prepends later still lands ahead of it.
 */
export function wearDesign(doc: Document, id: string, css: string, paletteId: string): void {
  const el = doc.getElementById(id) ?? doc.createElement("style")
  el.id = id
  el.textContent = css
  const palette = doc.getElementById(paletteId)
  if (palette !== null) palette.after(el)
  else doc.documentElement.prepend(el)
}

/**
 * The redesign sheet, last in the document, where it wins every tie with the page's own
 * rules. On a page still loading nothing is last yet: the sheet goes in now and, when
 * `gate`, the page is hidden until DOMContentLoaded, where the sheet moves to the end and
 * the hold is released, in one task, before the next paint.
 *
 * A rewrite of a sheet that is still the last element only changes its text. `appendChild`
 * on a mounted element removes it and puts it back, which is a childList mutation every
 * page-level observer sees, and the inspector rewrites its sheet on every keystroke. A
 * sheet the page has since pushed off the end is moved back, because being last is what
 * wins the tie.
 */
export function wearStyles(doc: Document, hold: Hold, id: string, css: string, gate: boolean, gateId: string, ms: number): void {
  const el = doc.getElementById(id) ?? doc.createElement("style")
  el.id = id
  el.textContent = css
  if (doc.documentElement.lastElementChild !== el) doc.documentElement.appendChild(el)
  if (!gate || doc.readyState !== "loading") return
  const release = hold(doc, gateId, ms)
  doc.addEventListener(
    "DOMContentLoaded",
    () => {
      if (doc.documentElement.lastElementChild !== el) doc.documentElement.appendChild(el)
      release()
    },
    { once: true }
  )
}

/**
 * Runs `go` once the DOM is there, and gives back what it returns when that is now. On a
 * page still loading, `go` runs at DOMContentLoaded, behind the gate when `gate`, so what
 * it mounts is painted with the page and not after it.
 */
export function whenReady(doc: Document, hold: Hold, go: () => unknown, gate: boolean, gateId: string, ms: number): unknown {
  if (doc.readyState !== "loading") return go()
  const release = gate ? hold(doc, gateId, ms) : () => {}
  doc.addEventListener(
    "DOMContentLoaded",
    () => {
      try {
        go()
      } finally {
        release()
      }
    },
    { once: true }
  )
  return undefined
}

type PageFn = (doc: Document, ...args: never[]) => unknown

/** One argument as page source: a function by its own text, anything else as JSON. */
const arg = (a: unknown): string => (typeof a === "function" ? `(${a.toString()})` : JSON.stringify(a))

/** The call, as page source: the function's own text applied to `document` and its arguments. */
const call = (fn: PageFn, ...args: ReadonlyArray<unknown>): string => `(${fn.toString()})(document${args.map((a) => `, ${arg(a)}`).join("")});`

export const designScript = (id: string, css: string, paletteId: string): string => call(wearDesign, id, css, paletteId)

/** `gate` for the copy that runs on later loads; the copy applied now, while the reader watches, never hides the page. */
export const stylesScript = (id: string, css: string, gate: boolean): string => call(wearStyles, hold, id, css, gate, GATE, GATE_MS)

/**
 * `js` as the model wrote it, in a function of its own on every run, so what it declares
 * stays out of the page's globals now and on later loads alike, and a `return` gives a value back.
 */
export const readyScript = (js: string, gate: boolean): string =>
  `(${whenReady.toString()})(document, ${arg(hold)}, () => {\n${js}\n}, ${JSON.stringify(gate)}, ${JSON.stringify(GATE)}, ${JSON.stringify(GATE_MS)});`
