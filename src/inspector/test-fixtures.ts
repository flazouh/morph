/**
 * Test-only helpers shared by `controller.test.ts` and `src/overlay/host-handoff.test.ts`:
 * a fake Task 3 runtime port and event constructors for a test running a controller
 * directly against a standalone happy-dom `Window` instead of a preloaded, globally
 * registered document.
 */

import type { InspectorAsk, InspectorAnswer } from "./messages"
import type { ChangeRecord, SourceLocation } from "./model"

/**
 * Just the constructors these fixtures touch, from either a real `window` or a standalone
 * happy-dom `Window` instance: `lib.dom`'s own `Window` interface does not list
 * `Event`/`PointerEvent`/`MouseEvent`/`KeyboardEvent` as members (they are separate ambient
 * globals), even though a real `window` answers to all of them, and happy-dom's own
 * `Window` type does not structurally match `lib.dom`'s.
 */
export interface TestWindow {
  readonly Event: typeof Event
  readonly PointerEvent: typeof PointerEvent
  readonly MouseEvent: typeof MouseEvent
  readonly KeyboardEvent: typeof KeyboardEvent
}

/** A page fixture: an open shadow host mounted into `doc.body`, for a controller's own root. */
export const openTestShadow = (doc: Document): { readonly host: Element; readonly shadow: ShadowRoot } => {
  const host = doc.createElement("div")
  doc.body.append(host)
  const shadow = host.attachShadow({ mode: "open" })
  return { host, shadow }
}

/** A fake Task 3 typed runtime contract: in-memory persistence, no chrome.* involved. */
export const fakeInspectorPort = (initial: ChangeRecord | null = null, resolvedSource: SourceLocation | null = null) => {
  let record = initial
  const calls: Array<InspectorAsk> = []
  const send = async (ask: InspectorAsk): Promise<InspectorAnswer> => {
    calls.push(ask)
    switch (ask.type) {
      case "loadInspector":
        return { type: "inspectorLoaded", record }
      case "saveInspector":
        record = ask.record
        return { type: "inspectorSaved" }
      case "clearInspector":
        record = null
        return { type: "inspectorCleared" }
      case "resolveInspectorSource":
        return { type: "inspectorSourceResolved", source: resolvedSource }
    }
  }
  return { send, calls, recordOf: () => record }
}

export const savesIn = (calls: ReadonlyArray<InspectorAsk>): number =>
  calls.filter((ask) => ask.type === "saveInspector").length

/** A microtask flush: enough for one round of promise resolution and its DOM effects. */
export const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

export const fire = (target: EventTarget, event: Event): void => {
  target.dispatchEvent(event)
}

/** One keystroke: a live preview that shows on the page and is not accepted yet. */
export const previewInto = (win: TestWindow, input: HTMLInputElement, value: string): void => {
  input.value = value
  input.dispatchEvent(new win.Event("input", { bubbles: true }))
}

/** A finished field edit: keystrokes, then the acceptance the browser fires on commit or blur. */
export const typeInto = (win: TestWindow, input: HTMLInputElement, value: string): void => {
  previewInto(win, input, value)
  input.dispatchEvent(new win.Event("change", { bubbles: true }))
}

export const pointerAt = (win: TestWindow, type: string): Event =>
  new win.PointerEvent(type, { bubbles: true, composed: true })

export const clickOn = (win: TestWindow): Event =>
  new win.MouseEvent("click", { bubbles: true, composed: true, cancelable: true })

export const key = (win: TestWindow, k: string): Event =>
  new win.KeyboardEvent("keydown", { key: k, bubbles: true, composed: true, cancelable: true })
