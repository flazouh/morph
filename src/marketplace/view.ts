export interface DeclarativeView {
  readonly schema: 1
  readonly target: string
  readonly styles: Readonly<Record<string, ViewStyle>>
  readonly sources: ReadonlyArray<{
    readonly id: string
    readonly selector: string
    readonly many: true
    readonly fields: Readonly<
      Record<
        string,
        | { readonly selector: string; readonly read: "text" }
        | { readonly selector: string; readonly read: "attribute"; readonly attribute: ReadableAttribute }
      >
    >
  }>
  readonly root: ViewElement
}

export type ReadableAttribute = "href" | "title" | "alt" | "datetime" | "aria-label"
export type ViewValue = string | { readonly field: string }
export type ViewNode = ViewElement | { readonly each: string; readonly template: ViewElement }

export interface ViewElement {
  readonly tag: ViewTag
  readonly className?: string
  readonly text?: ViewValue
  readonly attributes?: Readonly<Partial<Record<WritableAttribute, ViewValue>>>
  readonly children?: ReadonlyArray<ViewNode>
}

export type ViewTag = "main" | "header" | "footer" | "nav" | "section" | "article" | "div" | "span" | "h1" | "h2" | "h3" | "p" | "ul" | "ol" | "li" | "a" | "time"
export type WritableAttribute = "href" | "title" | "aria-label" | "datetime"
export type SafeStyleProperty =
  | "alignItems"
  | "backgroundColor"
  | "border"
  | "borderColor"
  | "borderRadius"
  | "borderStyle"
  | "borderWidth"
  | "boxShadow"
  | "color"
  | "columnGap"
  | "display"
  | "fontFamily"
  | "fontSize"
  | "fontStyle"
  | "fontWeight"
  | "gap"
  | "gridTemplateColumns"
  | "justifyContent"
  | "letterSpacing"
  | "lineHeight"
  | "listStyleType"
  | "margin"
  | "marginBlock"
  | "marginInline"
  | "maxWidth"
  | "minHeight"
  | "opacity"
  | "padding"
  | "paddingBlock"
  | "paddingInline"
  | "rowGap"
  | "textAlign"
  | "textDecoration"
  | "width"
export type ViewStyle = Readonly<Partial<Record<SafeStyleProperty, string>>>

const TAGS = new Set<ViewTag>(["main", "header", "footer", "nav", "section", "article", "div", "span", "h1", "h2", "h3", "p", "ul", "ol", "li", "a", "time"])
const READABLE_ATTRIBUTES = new Set<ReadableAttribute>(["href", "title", "alt", "datetime", "aria-label"])
const WRITABLE_ATTRIBUTES = new Set<WritableAttribute>(["href", "title", "aria-label", "datetime"])
const STYLE_PROPERTIES = new Set<SafeStyleProperty>([
  "alignItems", "backgroundColor", "border", "borderColor", "borderRadius", "borderStyle", "borderWidth", "boxShadow", "color",
  "columnGap", "display", "fontFamily", "fontSize", "fontStyle", "fontWeight", "gap", "gridTemplateColumns", "justifyContent",
  "letterSpacing", "lineHeight", "listStyleType", "margin", "marginBlock", "marginInline", "maxWidth", "minHeight", "opacity",
  "padding", "paddingBlock", "paddingInline", "rowGap", "textAlign", "textDecoration", "width"
])
const ID = /^[a-z][a-z0-9_-]*$/i
const UNSAFE_CSS = /url\s*\(|expression\s*\(|var\s*\(|attr\s*\(|[{};@]/i
const MAX_DEPTH = 20
const MAX_NODES = 500
interface BindingContext {
  readonly source: string
  readonly fields: ReadonlySet<string>
}

const record = (value: unknown, name: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} must be an object`)
  return value as Record<string, unknown>
}

const string = (value: unknown, name: string): string => {
  if (typeof value !== "string" || value === "") throw new Error(`${name} must be a non-empty string`)
  return value
}

const only = (value: Record<string, unknown>, allowed: ReadonlySet<string>, name: string): void => {
  const unknown = Object.keys(value).find((key) => !allowed.has(key))
  if (unknown !== undefined) throw new Error(`${name} contains unsupported property ${JSON.stringify(unknown)}`)
}

const binding = (value: unknown, context: BindingContext | undefined, name: string): void => {
  if (typeof value === "string") return
  const input = record(value, name)
  only(input, new Set(["field"]), name)
  const field = string(input.field, `${name}.field`)
  if (context === undefined) throw new Error(`field binding ${JSON.stringify(field)} must be inside a repeat`)
  if (!context.fields.has(field)) throw new Error(`source ${JSON.stringify(context.source)} has no field ${JSON.stringify(field)}`)
}

const safeHref = (value: string): boolean => {
  try {
    const url = new URL(value, "https://redesign.invalid")
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}

const validateStyles = (input: unknown): Record<string, unknown> => {
  const styles = record(input, "styles")
  if (Object.keys(styles).length === 0 || Object.keys(styles).length > 100) throw new Error("styles must contain between 1 and 100 entries")
  for (const [styleName, styleValue] of Object.entries(styles)) {
    if (!ID.test(styleName)) throw new Error(`styles contains invalid name ${JSON.stringify(styleName)}`)
    const style = record(styleValue, `styles.${styleName}`)
    if (Object.keys(style).length === 0 || Object.keys(style).length > 40) throw new Error(`styles.${styleName} must contain between 1 and 40 properties`)
    for (const [property, rawValue] of Object.entries(style)) {
      if (!STYLE_PROPERTIES.has(property as SafeStyleProperty)) throw new Error(`style property ${JSON.stringify(property)} is not allowed`)
      const value = string(rawValue, `styles.${styleName}.${property}`)
      if (value.length > 120 || UNSAFE_CSS.test(value)) throw new Error(`styles.${styleName}.${property} contains unsafe CSS`)
    }
  }
  return styles
}

const validateSources = (input: unknown): ReadonlyMap<string, ReadonlySet<string>> => {
  if (!Array.isArray(input) || input.length === 0 || input.length > 20) {
    throw new Error("sources must contain between 1 and 20 entries")
  }

  const sources = new Map<string, ReadonlySet<string>>()
  for (const [index, sourceValue] of input.entries()) {
    const name = `sources[${index}]`
    const source = record(sourceValue, name)
    only(source, new Set(["id", "selector", "many", "fields"]), name)
    const id = string(source.id, `${name}.id`)
    if (!ID.test(id) || sources.has(id)) throw new Error(`${name}.id must be unique and identifier-safe`)
    string(source.selector, `${name}.selector`)
    if (source.many !== true) throw new Error(`${name}.many must be true`)
    const fields = record(source.fields, `${name}.fields`)
    if (Object.keys(fields).length === 0 || Object.keys(fields).length > 20) throw new Error(`${name}.fields must contain between 1 and 20 entries`)
    for (const [fieldName, fieldValue] of Object.entries(fields)) {
      if (!ID.test(fieldName)) throw new Error(`${name}.fields contains invalid name ${JSON.stringify(fieldName)}`)
      const field = record(fieldValue, `${name}.fields.${fieldName}`)
      string(field.selector, `${name}.fields.${fieldName}.selector`)
      if (field.read === "text") {
        only(field, new Set(["selector", "read"]), `${name}.fields.${fieldName}`)
      } else if (field.read === "attribute") {
        only(field, new Set(["selector", "read", "attribute"]), `${name}.fields.${fieldName}`)
        const attribute = string(field.attribute, `${name}.fields.${fieldName}.attribute`)
        if (!READABLE_ATTRIBUTES.has(attribute as ReadableAttribute)) throw new Error(`attribute ${JSON.stringify(attribute)} is not readable`)
      } else {
        throw new Error(`${name}.fields.${fieldName}.read is not supported`)
      }
    }
    sources.set(id, new Set(Object.keys(fields)))
  }
  return sources
}

const validateTree = (
  root: unknown,
  styles: Readonly<Record<string, unknown>>,
  sources: ReadonlyMap<string, ReadonlySet<string>>
): void => {
  let nodes = 0
  const element = (value: unknown, context: BindingContext | undefined, depth: number, name: string): void => {
    if (depth > MAX_DEPTH) throw new Error(`view tree exceeds ${MAX_DEPTH} levels`)
    if (++nodes > MAX_NODES) throw new Error(`view tree exceeds ${MAX_NODES} nodes`)
    const node = record(value, name)
    only(node, new Set(["tag", "className", "text", "attributes", "children"]), name)
    const tag = string(node.tag, `${name}.tag`)
    if (!TAGS.has(tag as ViewTag)) throw new Error(`tag ${JSON.stringify(tag)} is not allowed`)
    if (node.className !== undefined) {
      const className = string(node.className, `${name}.className`)
      for (const token of className.split(/\s+/)) {
        if (!ID.test(token) || !(token in styles)) throw new Error(`style ${JSON.stringify(token)} is not declared`)
      }
    }
    if (node.text !== undefined) binding(node.text, context, `${name}.text`)
    if (node.attributes !== undefined) {
      const attributes = record(node.attributes, `${name}.attributes`)
      for (const [attribute, value] of Object.entries(attributes)) {
        if (!WRITABLE_ATTRIBUTES.has(attribute as WritableAttribute)) throw new Error(`attribute ${JSON.stringify(attribute)} is not writable`)
        binding(value, context, `${name}.attributes.${attribute}`)
        if (attribute === "href" && typeof value === "string" && !safeHref(value)) throw new Error(`href ${JSON.stringify(value)} is not safe`)
      }
    }
    if (node.children === undefined) return
    if (!Array.isArray(node.children)) throw new Error(`${name}.children must be an array`)
    for (const [index, childValue] of node.children.entries()) {
      const childName = `${name}.children[${index}]`
      const child = record(childValue, childName)
      if ("each" in child) {
        only(child, new Set(["each", "template"]), childName)
        const source = string(child.each, `${childName}.each`)
        const sourceFields = sources.get(source)
        if (sourceFields === undefined) throw new Error(`repeat source ${JSON.stringify(source)} does not exist`)
        element(child.template, { source, fields: sourceFields }, depth + 1, `${childName}.template`)
      } else {
        element(child, context, depth + 1, childName)
      }
    }
  }

  element(root, undefined, 1, "root")
}

export const parseDeclarativeView = (input: unknown): DeclarativeView => {
  const view = record(input, "view")
  only(view, new Set(["schema", "target", "sources", "styles", "root"]), "view")
  if (view.schema !== 1) throw new Error("schema must be 1")
  string(view.target, "target")
  const styles = validateStyles(view.styles)
  const sources = validateSources(view.sources)
  validateTree(view.root, styles, sources)
  return input as DeclarativeView
}
