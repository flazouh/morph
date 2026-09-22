/**
 * The inspect-mode DOM and its interaction: hover outline, click-to-pick,
 * breadcrumb and arrow-key navigation, the six-property panel, and the
 * undo/redo/discard change list. Mounted into the existing overlay host's
 * shadow root by `src/overlay/host.ts`; this module owns no host element of
 * its own.
 */

import { GATE, GATE_MS, hold, wearStyles } from "../bridge/loader"
import type { InspectorAsk, InspectorAnswer } from "./messages"
import { applyChange, discard as discardHistory, redo as redoHistory, removeChange, undo as undoHistory } from "./changes"
import { handoffPrompt } from "./handoff"
import { cssFor, INSPECTOR_SHEET_ID, isSafeCssValue } from "./css"
import type { ChangeHistory, ChangeRecord, SourceLocation, StyleProperty } from "./model"
import { STYLE_PROPERTIES } from "./model"
import { inspectorCss } from "./panel-style"
import { cornerStyle, pickCorner, type Rect } from "./placement"
import { detectTailwind, stableSelector } from "./selector"
import { scanColorTokens } from "./tokens"
import {
  colorTokenReference,
  formatLength,
  parseLength,
  pickerHexFor,
  sliderRangeFor
} from "./values"

const PANEL_INSET = 16
const PANEL_SIZE = { width: 280, height: 360 }

/**
 * `lib.dom`'s own `Window` interface does not list these DOM constructors as members
 * (they are separate ambient globals), even though a real `window` answers to all of
 * them. The controller reads every DOM constructor through its injected window instead
 * of the ambient global, so callers pass this richer type instead of a bare `Window`.
 */
export interface InspectorWindow extends Window {
  readonly Element: typeof Element
  readonly HTMLElement: typeof HTMLElement
  readonly HTMLIFrameElement: typeof HTMLIFrameElement
  readonly HTMLInputElement: typeof HTMLInputElement
  readonly HTMLTextAreaElement: typeof HTMLTextAreaElement
  readonly HTMLSelectElement: typeof HTMLSelectElement
  readonly HTMLButtonElement: typeof HTMLButtonElement
  readonly ShadowRoot: typeof ShadowRoot
  readonly MutationObserver: typeof MutationObserver
}

export type InspectorSend = (ask: InspectorAsk) => Promise<InspectorAnswer>

export type HandoffResult = { readonly ok: true } | { readonly ok: false; readonly message: string }

export type CopyPromptStart =
  | { readonly ok: true; readonly pending: Promise<void> }
  | { readonly ok: false; readonly message: string }

export interface InspectorPorts {
  readonly send: InspectorSend
  readonly onExit: () => void
  readonly onHistoryChange: (history: ChangeHistory) => void
  readonly beginCopyPrompt: (prompt: string) => CopyPromptStart
  readonly sendToMorph: (prompt: string) => Promise<HandoffResult>
}

export interface InspectorController {
  readonly root: HTMLElement
  destroy(): void
}

const PROPERTY_LABELS: Record<StyleProperty, string> = {
  padding: "Padding",
  margin: "Margin",
  color: "Text color",
  "background-color": "Background",
  "border-radius": "Corner radius",
  "font-size": "Font size"
}

const COLOR_PROPERTIES: ReadonlySet<StyleProperty> = new Set(["color", "background-color"])

const isFormLikeElement = (win: InspectorWindow, element: Element): boolean =>
  element instanceof win.HTMLInputElement ||
  element instanceof win.HTMLTextAreaElement ||
  element instanceof win.HTMLSelectElement ||
  element instanceof win.HTMLButtonElement ||
  (element instanceof win.HTMLElement && element.isContentEditable)

/** A cheap, synchronous hint. Real framework source needs the MAIN world and is resolved on pick, not on every hover. */
const quickComponentHint = (element: Element): string | null =>
  element.getAttribute("data-astro-source-file")?.split("/").pop()?.split(".")[0] ??
  element.getAttribute("data-component") ??
  null

const tagLabel = (element: Element): string => {
  const classes = Array.from(element.classList).slice(0, 3).map((name) => `.${name}`).join("")
  return `${element.tagName.toLowerCase()}${classes}`
}

interface Editability {
  readonly editable: boolean
  readonly reason: string | null
}

const editabilityOf = (win: InspectorWindow, doc: Document, element: Element): Editability => {
  if (element instanceof win.HTMLIFrameElement) {
    return { editable: false, reason: "This is an iframe. Morph cannot reach its contents." }
  }
  if (element.getRootNode() !== doc) {
    return { editable: false, reason: "This element is inside a shadow root. Page styles cannot reach it." }
  }
  return { editable: true, reason: null }
}

const ancestorsOf = (element: Element): ReadonlyArray<Element> => {
  const chain: Array<Element> = [element]
  let current: Element | null = element.parentElement
  while (current !== null) {
    chain.unshift(current)
    current = current.parentElement
  }
  return chain
}

const emptyRecord = (doc: Document): ChangeRecord => ({
  url: doc.location.href,
  tailwind: false,
  changes: [],
  sources: {}
})

/** The storage write a commit performs. `null` defers it: a live typing burst writes once, on acceptance. */
type PersistAction = "saveInspector" | "clearInspector" | null

/**
 * A typing burst in one field. `input` events rewrite the same history step from `base`,
 * so a whole field value is one undo step instead of one step per character.
 */
interface LiveEdit {
  readonly selector: string
  readonly property: StyleProperty
  /** The value the field held before the burst started, kept so every keystroke reports the same `before`. */
  readonly before: string
  readonly base: ChangeHistory
}

export const createInspectorController = (
  doc: Document,
  win: InspectorWindow,
  initialHistory: ChangeHistory,
  ports: InspectorPorts
): InspectorController => {
  let history: ChangeHistory = initialHistory
  let hovered: Element | null = null
  let selected: Element | null = null
  /** Set by `destroy()`. Guards every async source result so a torn-down controller cannot mutate or save state. */
  let disposed = false
  /** An open typing burst, or `null` when the last edit is accepted. */
  let live: LiveEdit | null = null
  /**
   * Every source this controller knows, by selector. A restored record arrives with the
   * sources it was saved with, so a reopened session does not lose them.
   */
  const sourceCache = new Map<string, SourceLocation | null>(
    Object.entries(initialHistory.present.sources)
  )
  const colorTokens = scanColorTokens(doc)
  const rootFontPx = parseLength(win.getComputedStyle(doc.documentElement).fontSize)?.px ?? 16

  const root = doc.createElement("div")
  root.className = "mi-root"

  const style = doc.createElement("style")
  style.textContent = inspectorCss(PANEL_SIZE)
  root.append(style)

  const outline = doc.createElement("div")
  outline.className = "mi-outline"
  outline.hidden = true
  root.append(outline)

  const tag = doc.createElement("div")
  tag.className = "mi-tag"
  tag.hidden = true
  root.append(tag)

  const panel = doc.createElement("div")
  panel.className = "mi-panel"
  panel.hidden = true
  root.append(panel)

  /**
   * The component the source adapters name for the picked element. It arrives with the
   * source lookup, which is a round trip through the MAIN world, so this stays empty on
   * the pick itself and fills in when the answer lands. Hover cannot show it: the fiber
   * and the Vue component instance live on runtime keys this world cannot read.
   */
  const component = doc.createElement("div")
  component.className = "mi-component"
  component.hidden = true
  const componentKind = doc.createElement("span")
  componentKind.className = "mi-component-label"
  componentKind.textContent = "Component"
  const componentName = doc.createElement("span")
  componentName.className = "mi-component-name"
  component.append(componentKind, componentName)
  panel.append(component)

  const crumbs = doc.createElement("div")
  crumbs.className = "mi-crumbs"
  panel.append(crumbs)

  const warning = doc.createElement("div")
  warning.className = "mi-warning"
  warning.hidden = true
  panel.append(warning)

  const rows = doc.createElement("div")
  panel.append(rows)

  const inputs = new Map<StyleProperty, HTMLInputElement>()
  const sliders = new Map<StyleProperty, HTMLInputElement>()
  const pickers = new Map<StyleProperty, HTMLInputElement>()
  const tokenRows = new Map<StyleProperty, HTMLElement>()
  const tokenButtons = new Map<StyleProperty, ReadonlyArray<HTMLButtonElement>>()

  for (const property of STYLE_PROPERTIES) {
    const row = doc.createElement("div")
    row.className = "mi-row"
    row.dataset.miProperty = property

    const label = doc.createElement("label")
    label.className = "mi-label"
    label.textContent = PROPERTY_LABELS[property]
    const input = doc.createElement("input")
    input.className = "mi-value"
    input.type = "text"
    input.id = `mi-input-${property}`
    label.htmlFor = input.id
    // `input` is a live preview. `change` and blur accept it, which is when storage is written.
    input.addEventListener("input", () => previewEdit(property, input.value))
    input.addEventListener("change", () => acceptEdit())
    input.addEventListener("blur", () => acceptEdit())

    const field = doc.createElement("div")
    field.className = "mi-field"

    if (COLOR_PROPERTIES.has(property)) {
      const picker = doc.createElement("input")
      picker.className = "mi-picker"
      picker.type = "color"
      picker.id = `mi-color-${property}`
      picker.setAttribute("aria-label", `${PROPERTY_LABELS[property]} picker`)
      picker.addEventListener("input", () => {
        if (picker.hidden || picker.disabled) return
        previewEdit(property, picker.value)
      })
      picker.addEventListener("change", () => acceptEdit())
      picker.addEventListener("blur", () => acceptEdit())
      field.append(picker, input)
      pickers.set(property, picker)
    } else {
      const range = sliderRangeFor(property)
      const slider = doc.createElement("input")
      slider.className = "mi-slider"
      slider.type = "range"
      slider.id = `mi-slider-${property}`
      slider.min = String(range.min)
      slider.max = String(range.max)
      slider.step = String(range.step)
      slider.setAttribute("aria-label", `${PROPERTY_LABELS[property]} slider`)
      slider.addEventListener("input", () => {
        if (selected === null || slider.hidden || slider.disabled) return
        const selector = stableSelector(selected, doc)
        const existing = history.present.changes.find(
          (change) => change.selector === selector && change.property === property
        )
        const unit = parseLength(existing?.after ?? win.getComputedStyle(selected).getPropertyValue(property), rootFontPx)?.unit ?? "px"
        previewEdit(property, formatLength(Number(slider.value), unit, rootFontPx))
      })
      slider.addEventListener("change", () => acceptEdit())
      slider.addEventListener("blur", () => acceptEdit())
      field.append(slider, input)
      sliders.set(property, slider)
    }

    row.append(label, field)
    rows.append(row)
    inputs.set(property, input)

    if (COLOR_PROPERTIES.has(property)) {
      const tokenRow = doc.createElement("div")
      tokenRow.className = "mi-tokens"
      tokenRow.dataset.miTokensFor = property
      const buttons = colorTokens.map((token) => {
        const button = doc.createElement("button")
        button.type = "button"
        button.className = "mi-token"
        button.textContent = token.name
        button.title = `Apply ${token.name}`
        button.setAttribute("aria-pressed", "false")
        const swatch = doc.createElement("span")
        swatch.className = "mi-token-swatch"
        swatch.style.backgroundColor = token.value
        const name = doc.createElement("span")
        name.className = "mi-token-name"
        name.textContent = token.name
        button.replaceChildren(swatch, name)
        // Keep the variable reference, not its frozen resolved color: applying a token
        // should keep tracking the page's own design system, not snapshot one value from it.
        button.addEventListener("click", () => {
          previewEdit(property, `var(${token.name})`)
          acceptEdit()
        })
        return button
      })
      tokenRow.append(...buttons)
      rows.append(tokenRow)
      tokenRows.set(property, tokenRow)
      tokenButtons.set(property, buttons)
    }
  }

  const changesList = doc.createElement("div")
  changesList.className = "mi-changes"
  panel.append(changesList)

  const status = doc.createElement("div")
  status.className = "mi-status"
  status.setAttribute("role", "status")
  status.setAttribute("aria-live", "polite")
  panel.append(status)

  const handoffActions = doc.createElement("div")
  handoffActions.className = "mi-handoff"
  const copyButton = doc.createElement("button")
  copyButton.type = "button"
  copyButton.className = "mi-action"
  copyButton.textContent = "Copy prompt"
  copyButton.setAttribute("aria-label", "Copy prompt")
  copyButton.addEventListener("click", () => runHandoff("copy"))

  const sendButton = doc.createElement("button")
  sendButton.type = "button"
  sendButton.className = "mi-action"
  sendButton.textContent = "Send to Morph"
  sendButton.setAttribute("aria-label", "Send to Morph")
  sendButton.addEventListener("click", () => runHandoff("send"))

  handoffActions.append(copyButton, sendButton)
  panel.append(handoffActions)

  const actions = doc.createElement("div")
  actions.className = "mi-actions"
  const undoButton = doc.createElement("button")
  undoButton.type = "button"
  undoButton.className = "mi-action"
  undoButton.textContent = "Undo"
  undoButton.setAttribute("aria-label", "Undo change")
  undoButton.addEventListener("click", () => commit(undoHistory(history)))

  const redoButton = doc.createElement("button")
  redoButton.type = "button"
  redoButton.className = "mi-action"
  redoButton.textContent = "Redo"
  redoButton.setAttribute("aria-label", "Redo change")
  redoButton.addEventListener("click", () => commit(redoHistory(history)))

  const discardButton = doc.createElement("button")
  discardButton.type = "button"
  discardButton.className = "mi-action"
  discardButton.dataset.miDiscard = ""
  discardButton.textContent = "Discard"
  discardButton.setAttribute("aria-label", "Discard all changes")
  discardButton.addEventListener("click", () => discardAll())

  actions.append(undoButton, redoButton, discardButton)
  panel.append(actions)

  let handoffInFlight = false

  /** The one place every control's enabled state is derived from the current history. */
  const syncActions = (): void => {
    const hasChanges = history.present.changes.length > 0
    copyButton.disabled = handoffInFlight || !hasChanges
    sendButton.disabled = handoffInFlight || !hasChanges
    undoButton.disabled = history.past.length === 0
    redoButton.disabled = history.future.length === 0
    discardButton.disabled = !hasChanges && history.past.length === 0
  }

  const setHandoffBusy = (busy: boolean): void => {
    handoffInFlight = busy
    syncActions()
  }

  const showStatus = (text: string, error = false): void => {
    status.textContent = text
    status.dataset.miError = error ? "true" : "false"
  }

  const hideStatus = (): void => {
    status.textContent = ""
    delete status.dataset.miError
  }

  const runHandoff = (mode: "copy" | "send"): void => {
    if (handoffInFlight) return
    hideStatus()
    const prompt = handoffPrompt(history.present)
    setHandoffBusy(true)

    if (mode === "copy") {
      const started = ports.beginCopyPrompt(prompt)
      if (!started.ok) {
        showStatus(started.message, true)
        setHandoffBusy(false)
        return
      }
      void started.pending.then(
        () => showStatus("Prompt copied to clipboard."),
        () =>
          showStatus(
            "Clipboard blocked. Select Copy prompt again or copy the text manually from the change list.",
            true
          )
      ).finally(() => setHandoffBusy(false))
      return
    }

    void ports.sendToMorph(prompt).then((result) => {
      if (result.ok) showStatus("Sent to Morph.")
      else showStatus(result.message, true)
    }).finally(() => setHandoffBusy(false))
  }

  const hideOutline = (): void => {
    hovered = null
    outline.hidden = true
    tag.hidden = true
  }

  const showOutlineFor = (element: Element): void => {
    hovered = element
    const rect = element.getBoundingClientRect()
    outline.hidden = false
    outline.style.left = `${rect.left}px`
    outline.style.top = `${rect.top}px`
    outline.style.width = `${rect.width}px`
    outline.style.height = `${rect.height}px`

    tag.hidden = false
    tag.style.left = `${rect.left}px`
    tag.style.top = `${Math.max(0, rect.top)}px`
    tag.textContent = ""
    const label = doc.createElement("span")
    label.textContent = tagLabel(element)
    tag.append(label)
    const hint = quickComponentHint(element)
    if (hint !== null) {
      const componentLabel = doc.createElement("span")
      componentLabel.className = "mi-tag-component"
      componentLabel.textContent = ` ${hint}`
      tag.append(componentLabel)
    }
  }

  const valueFor = (property: StyleProperty, selector: string, element: Element): string => {
    const existing = history.present.changes.find((c) => c.selector === selector && c.property === property)
    return existing?.after ?? win.getComputedStyle(element).getPropertyValue(property)
  }

  /** The value a rich control should mirror: the open burst first, then the settled value. */
  const displayValueFor = (property: StyleProperty, selector: string, element: Element): string => {
    if (live !== null && live.selector === selector && live.property === property) {
      const latest = history.present.changes.find(
        (change) => change.selector === selector && change.property === property
      )
      if (latest !== undefined) return latest.after
    }
    return valueFor(property, selector, element)
  }

  /** A rich control never steals the text field's caret while the reader is typing in it. */
  const syncRichControl = (property: StyleProperty, value: string): void => {
    const slider = sliders.get(property)
    if (slider !== undefined) {
      const length = parseLength(value, rootFontPx)
      slider.hidden = length === null
      if (length !== null && doc.activeElement !== slider) slider.value = String(length.px)
      return
    }

    const picker = pickers.get(property)
    if (picker === undefined) return
    const hex = pickerHexFor(value, colorTokens)
    picker.hidden = hex === null
    if (hex !== null && doc.activeElement !== picker) picker.value = hex

    const reference = colorTokenReference(value)
    for (const button of tokenButtons.get(property) ?? []) {
      const name = button.querySelector(".mi-token-name")?.textContent?.trim() ?? ""
      button.setAttribute("aria-pressed", name === reference ? "true" : "false")
    }
  }

  const originalValueFor = (property: StyleProperty, selector: string, element: Element): string => {
    const existing = history.present.changes.find((c) => c.selector === selector && c.property === property)
    return existing?.before ?? win.getComputedStyle(element).getPropertyValue(property)
  }

  /**
   * A source can arrive at any time: the lookup is async, so an edit made right after
   * picking an element races it. The record therefore never copies a source into a
   * change; it carries one map, rebuilt here from what is known now for the selectors
   * it changes. Undo and redo then keep their sources without patching stored history.
   */
  const withSources = (next: ChangeHistory): ChangeHistory => {
    const sources: Record<string, SourceLocation> = {}
    for (const change of next.present.changes) {
      const source = sourceCache.get(change.selector)
      if (source !== undefined && source !== null) sources[change.selector] = source
    }
    return { ...next, present: { ...next.present, sources } }
  }

  const resolveSource = (element: Element, selector: string): void => {
    if (sourceCache.has(selector)) return
    void ports.send({ type: "resolveInspectorSource", selector })
      .then((answer) => {
        if (disposed) return
        if (answer.type !== "inspectorSourceResolved") return
        sourceCache.set(selector, answer.source)
        if (
          answer.source !== null &&
          history.present.changes.some((change) => change.selector === selector)
        ) {
          // A live burst persists on acceptance, so do not write storage in the middle of one.
          commit(history, live === null ? "saveInspector" : null)
        }
        if (selected === element) renderPanel()
      })
      .catch(() => {
        if (disposed) return
        sourceCache.set(selector, null)
      })
  }

  /**
   * Storage is the one part of a commit that can fail on its own: the page already shows
   * the change. A failure is reported in the panel while this controller is live, and is
   * swallowed after teardown, where there is no panel left to tell and no caller waiting.
   */
  const reportSaveFailure = (message: string): void => {
    if (disposed) return
    showStatus(message, true)
  }

  const persist = (action: "saveInspector" | "clearInspector"): void => {
    void ports.send(
      action === "saveInspector"
        ? { type: "saveInspector", record: history.present }
        : { type: "clearInspector" }
    ).then(
      (answer) => {
        if (answer.type !== "inspectorError") return
        reportSaveFailure(`Morph could not save this change: ${answer.message}`)
      },
      () =>
        reportSaveFailure(
          "Morph could not save this change. It is still on the page, but it will not survive a reload."
        )
    )
  }

  /** The one path that changes state: stylesheet, host history, storage, and panel, in that order. */
  const commit = (next: ChangeHistory, action: PersistAction = "saveInspector"): void => {
    // A commit that writes storage is a settled state, so it ends any open preview.
    if (action !== null) live = null
    history = withSources(next)
    hideStatus()
    ports.onHistoryChange(history)
    wearStyles(doc, hold, INSPECTOR_SHEET_ID, cssFor(history.present), false, GATE, GATE_MS)
    if (action !== null) persist(action)
    renderPanel()
  }

  /** One keystroke: rewrite the burst's own history step and show it, without writing storage. */
  const previewEdit = (property: StyleProperty, after: string): void => {
    if (selected === null || !selected.isConnected) return
    if (!editabilityOf(win, doc, selected).editable) return
    const selector = stableSelector(selected, doc)
    // Another field ends the open burst, so this keystroke starts a fresh one.
    if (live !== null && (live.selector !== selector || live.property !== property)) acceptEdit()
    const edit: LiveEdit = live ?? {
      selector,
      property,
      before: originalValueFor(property, selector, selected),
      base: history
    }
    live = edit

    // A value that is empty, or that could close its declaration or rule early, must never
    // reach history: that is what keeps it out of storage, the change list, and handoff
    // too. The page keeps the burst's last valid preview instead of this keystroke's value.
    if (after.trim() === "") {
      showStatus("Type a value to keep editing. The last one you typed is still on the page.", true)
      return
    }
    if (!isSafeCssValue(after)) {
      showStatus("This value can't contain \";\", \"{\", or \"}\". Remove it to keep editing.", true)
      return
    }

    // Always rebuilt from the burst's base, so deleting characters walks the preview back
    // through the same one step instead of stacking a step per keystroke.
    const next = applyChange(edit.base, { selector, property, before: edit.before, after })
    const tailwind = next.present.tailwind || detectTailwind(selected)
    commit({ ...next, present: { ...next.present, tailwind } }, null)
  }

  /**
   * A field the reader left empty goes back to showing what the page shows, which is the
   * burst's last valid value, or the element's own value when nothing valid was typed.
   * The error stays up: the field is settled, not corrected. Only leaving does this, so
   * clearing the field to type a replacement still works.
   */
  const restoreBlankField = (edit: LiveEdit): void => {
    const input = inputs.get(edit.property)
    if (input === undefined || input.value.trim() !== "") return
    if (selected === null || !selected.isConnected) return
    input.value = valueFor(edit.property, edit.selector, selected)
  }

  /** `change`, blur, a new selection, and teardown all accept the preview: one write for the burst. */
  const acceptEdit = (): void => {
    if (live === null) return
    const edit = live
    live = null
    restoreBlankField(edit)
    persist("saveInspector")
  }

  const removeRow = (selector: string, property: StyleProperty): void => {
    commit(removeChange(history, selector, property))
  }

  const discardAll = (): void => {
    commit(discardHistory(history), "clearInspector")
  }

  const clearSelection = (): void => {
    acceptEdit()
    hideStatus()
    selected = null
    renderPanel()
  }

  const positionPanel = (element: Element): void => {
    const target: Rect = element.getBoundingClientRect()
    const viewport = { width: win.innerWidth, height: win.innerHeight }
    const corner = pickCorner(target, viewport, PANEL_SIZE, PANEL_INSET)
    Object.assign(panel.style, cornerStyle(corner, PANEL_INSET))
  }

  const renderPanel = (): void => {
    syncActions()
    if (selected === null || !selected.isConnected) {
      panel.hidden = true
      return
    }
    const element = selected
    const selector = stableSelector(element, doc)
    const check = editabilityOf(win, doc, element)

    panel.hidden = false
    positionPanel(element)

    const named = sourceCache.get(selector)?.component ?? null
    component.hidden = named === null
    componentName.textContent = named ?? ""

    crumbs.replaceChildren(
      ...ancestorsOf(element).map((ancestor) => {
        const button = doc.createElement("button")
        button.type = "button"
        button.className = "mi-crumb"
        button.textContent = tagLabel(ancestor)
        if (ancestor === element) button.setAttribute("aria-current", "true")
        button.addEventListener("click", () => select(ancestor))
        return button
      })
    )

    warning.hidden = check.editable
    warning.textContent = check.reason ?? ""

    for (const property of STYLE_PROPERTIES) {
      const input = inputs.get(property)
      if (input === undefined) continue
      const value = displayValueFor(property, selector, element)
      input.disabled = !check.editable
      // A settled direct color the picker can own is shown as its normalized hex, so the
      // text field and the swatch name the same value. A token reference keeps its authored
      // `var(--name)`, and a wider color model keeps its own text. An open burst keeps the
      // reader's exact text, so a partial value is never rewritten under the caret.
      const settled = live === null || live.selector !== selector || live.property !== property
      const shown =
        settled && COLOR_PROPERTIES.has(property) && colorTokenReference(value) === null
          ? pickerHexFor(value, colorTokens) ?? value
          : value
      if (doc.activeElement !== input) input.value = shown
      const slider = sliders.get(property)
      if (slider !== undefined) slider.disabled = !check.editable
      const picker = pickers.get(property)
      if (picker !== undefined) picker.disabled = !check.editable
      const tokenRow = tokenRows.get(property)
      if (tokenRow !== undefined) tokenRow.hidden = !check.editable || colorTokens.length === 0
      for (const button of tokenButtons.get(property) ?? []) button.disabled = !check.editable
      syncRichControl(property, value)
    }

    changesList.replaceChildren(
      ...history.present.changes.map((change) => {
        const row = doc.createElement("div")
        row.className = "mi-change"
        const text = doc.createElement("span")
        text.className = "mi-change-text"
        text.textContent = `${change.selector} · ${change.property}: ${change.before} → ${change.after}`
        const remove = doc.createElement("button")
        remove.type = "button"
        remove.className = "mi-remove"
        remove.setAttribute("aria-label", "Remove change")
        remove.textContent = "×"
        remove.addEventListener("click", () => removeRow(change.selector, change.property))
        row.append(text, remove)
        return row
      })
    )
  }

  const select = (element: Element): void => {
    if (!element.isConnected) return
    acceptEdit()
    // A status belongs to whatever was selected when it was shown. Picking a genuinely
    // different element retires it; reselecting the same one (a breadcrumb's own "current"
    // entry, a repeat click) is a re-render, not a selection change, so it must survive.
    if (element !== selected) hideStatus()
    selected = element
    const selector = stableSelector(element, doc)
    resolveSource(element, selector)
    renderPanel()
  }

  /** `root`'s shadow host, resolved lazily: `root` is only mounted into the shadow after this controller returns it. */
  const shadowHost = (): Element | null => {
    const owner = root.getRootNode()
    return owner instanceof win.ShadowRoot ? owner.host : null
  }

  /**
   * True when `observed` is part of this controller's own DOM. A document-level listener's
   * `composedPath()` cannot see past a closed shadow boundary: any event from inside this
   * controller's tree is retargeted to the shadow host by the time it reaches `document`.
   * Ownership is derived from `root`'s own tree position instead of trusting the event's
   * reported target, so panel interactions are stopped before they can be read as a page pick.
   */
  const isOwnOrigin = (observed: unknown): boolean =>
    observed instanceof win.Element && (root.contains(observed) || observed === shadowHost())

  const onPointerMove = (event: PointerEvent): void => {
    const target = event.composedPath()[0]
    if (isOwnOrigin(target)) return
    if (!(target instanceof win.Element) || target === doc.documentElement || target === doc.body) {
      hideOutline()
      return
    }
    if (target !== hovered) showOutlineFor(target)
  }

  const onClick = (event: MouseEvent): void => {
    const target = event.composedPath()[0]
    if (isOwnOrigin(target)) return
    if (!(target instanceof win.Element)) return
    event.preventDefault()
    event.stopPropagation()
    select(target)
  }

  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault()
      ports.onExit()
      return
    }
    const origin = event.composedPath()[0]
    if (isOwnOrigin(origin)) return
    if (origin instanceof win.Element && isFormLikeElement(win, origin)) return
    if (selected === null) return
    const next =
      event.key === "ArrowUp" ? selected.parentElement
      : event.key === "ArrowDown" ? selected.firstElementChild
      : event.key === "ArrowLeft" ? selected.previousElementSibling
      : event.key === "ArrowRight" ? selected.nextElementSibling
      : undefined
    if (next === undefined) return
    event.preventDefault()
    if (next !== null) select(next)
  }

  /** The selected element's viewport rect can shift under the panel without the element itself changing. */
  const repositionPanel = (): void => {
    if (selected !== null && selected.isConnected && !panel.hidden) positionPanel(selected)
  }

  const repositionOverlays = (): void => {
    if (hovered !== null && hovered.isConnected && !outline.hidden) showOutlineFor(hovered)
    repositionPanel()
  }

  const removalWatch = new win.MutationObserver(() => {
    if (selected !== null && !selected.isConnected) clearSelection()
  })
  removalWatch.observe(doc.documentElement, { childList: true, subtree: true })

  doc.addEventListener("pointermove", onPointerMove, true)
  doc.addEventListener("click", onClick, true)
  doc.addEventListener("keydown", onKeydown, true)
  win.addEventListener("scroll", repositionOverlays, true)
  win.addEventListener("resize", repositionOverlays)

  return {
    root,
    destroy: () => {
      // A field the reader was still typing in must reach storage: navigation would lose it.
      acceptEdit()
      disposed = true
      removalWatch.disconnect()
      doc.removeEventListener("pointermove", onPointerMove, true)
      doc.removeEventListener("click", onClick, true)
      doc.removeEventListener("keydown", onKeydown, true)
      win.removeEventListener("scroll", repositionOverlays, true)
      win.removeEventListener("resize", repositionOverlays)
      root.remove()
    }
  }
}

export const loadInitialHistory = async (doc: Document, send: InspectorSend): Promise<ChangeHistory> => {
  try {
    const answer = await send({ type: "loadInspector" })
    const present = answer.type === "inspectorLoaded" && answer.record !== null ? answer.record : emptyRecord(doc)
    return { present, past: [], future: [] }
  } catch {
    return { present: emptyRecord(doc), past: [], future: [] }
  }
}
