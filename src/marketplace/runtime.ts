import { parseDeclarativeView, type DeclarativeView, type ViewElement, type ViewNode, type ViewStyle, type ViewValue } from "./view"

type Row = Readonly<Record<string, string>>
type Styles = Readonly<Record<string, ViewStyle>>

const SHADOW_RESET = ":host{all:initial!important;display:block!important;contain:layout style}*,*::before,*::after{box-sizing:border-box}"

const query = (root: ParentNode, selector: string): Element | null => {
  try {
    return root.querySelector(selector)
  } catch {
    return null
  }
}

const readSources = (view: DeclarativeView, doc: Document): ReadonlyMap<string, ReadonlyArray<Row>> => {
  const result = new Map<string, ReadonlyArray<Row>>()
  for (const source of view.sources) {
    let elements: ReadonlyArray<Element>
    try {
      elements = [...doc.querySelectorAll(source.selector)]
    } catch {
      elements = []
    }
    result.set(
      source.id,
      elements.map((element) =>
        Object.fromEntries(
          Object.entries(source.fields).map(([name, field]) => {
            const found = query(element, field.selector)
            if (found === null) return [name, ""]
            return [name, field.read === "text" ? (found.textContent ?? "").trim() : (found.getAttribute(field.attribute) ?? "")]
          })
        )
      )
    )
  }
  return result
}

const valueOf = (value: ViewValue, row: Row | undefined): string => (typeof value === "string" ? value : (row?.[value.field] ?? ""))

const safeLink = (value: string, doc: Document): boolean => {
  try {
    const base = /^https?:/.test(doc.baseURI) ? doc.baseURI : "https://redesign.invalid"
    const url = new URL(value, base)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}

const drawElement = (
  node: ViewElement,
  row: Row | undefined,
  sources: ReadonlyMap<string, ReadonlyArray<Row>>,
  styles: Styles,
  doc: Document
): HTMLElement => {
  const element = doc.createElement(node.tag)
  if (node.className !== undefined) {
    element.className = node.className
    for (const token of node.className.split(/\s+/)) Object.assign(element.style, styles[token])
  }
  if (node.text !== undefined) element.textContent = valueOf(node.text, row)
  for (const [name, value] of Object.entries(node.attributes ?? {})) {
    if (value === undefined) continue
    const resolved = valueOf(value, row)
    if (name === "href" && !safeLink(resolved, doc)) continue
    element.setAttribute(name, resolved)
  }
  for (const child of node.children ?? []) drawNode(child, row, sources, styles, doc).forEach((drawn) => element.append(drawn))
  return element
}

const drawNode = (
  node: ViewNode,
  row: Row | undefined,
  sources: ReadonlyMap<string, ReadonlyArray<Row>>,
  styles: Styles,
  doc: Document
): ReadonlyArray<HTMLElement> => {
  if ("each" in node) return (sources.get(node.each) ?? []).map((item) => drawElement(node.template, item, sources, styles, doc))
  return [drawElement(node, row, sources, styles, doc)]
}

export const renderDeclarativeView = (input: unknown, doc: Document): HTMLElement => {
  const view = parseDeclarativeView(input)
  return drawElement(view.root, undefined, readSources(view, doc), view.styles, doc)
}

export const applyDeclarativeView = (input: unknown, doc: Document): (() => void) => {
  const view = parseDeclarativeView(input)
  const target = query(doc, view.target)
  if (!(target instanceof HTMLElement)) throw new Error(`target ${JSON.stringify(view.target)} was not found`)
  const hidden = target.hidden
  const root = drawElement(view.root, undefined, readSources(view, doc), view.styles, doc)
  const host = doc.createElement("redesign-view")
  const shadow = host.attachShadow({ mode: "open" })
  const reset = doc.createElement("style")
  reset.textContent = SHADOW_RESET
  shadow.append(reset, root)
  root.dataset.redesignDeclarative = "true"
  target.before(host)
  target.hidden = true
  return () => {
    host.remove()
    target.hidden = hidden
  }
}
