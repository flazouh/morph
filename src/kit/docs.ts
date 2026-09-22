/**
 * What the model reads about the page kit, and what the kit forwards: one record per
 * component with its doc line and the props it accepts. Pure data, shared by the kit
 * bundle (which mounts them) and the agent (which prompts with them), so neither side
 * pulls the other's code, and the two cannot drift apart.
 */
import { TOKEN_KEYS } from "./tokens"

export interface ComponentDoc {
  /** One line for the model: the shape of the props and what the component is for. */
  readonly doc: string
  /** The props forwarded to the component; anything else the model sends is dropped. */
  readonly props: ReadonlyArray<string>
}

export const COMPONENTS = {
  Card: {
    doc: "Card { tilt?: boolean (default true), glare?: boolean, padding: none|sm|md|lg }. Wraps by default: the element keeps its content and your CSS, and gets a card surface (bg-card, border, radius, shadow) that tilts in 3D on hover. The default for a list row, a story, a product. Card draws the surface: give the wrapped element padding and layout only, no border, background or shadow of its own.",
    props: ["tilt", "glare", "padding", "className"]
  },
  Button: {
    doc: "Button { variant: primary|secondary|ghost|outline, size: sm|md|lg|icon, href?, onClick?, ripple?, disabled? }. With href it is a link.",
    props: ["variant", "size", "href", "onClick", "ripple", "disabled", "className"]
  },
  Badge: {
    doc: "Badge { status: neutral|info|success|warning|danger|loading, size: sm|md, pulse?, showIcon? }. Small status label.",
    props: ["status", "size", "pulse", "showIcon", "className"]
  },
  NumberTicker: {
    doc: "NumberTicker { value: number, prefix?, suffix?, locale?: boolean, pad? }. A number whose digits roll on change.",
    props: ["value", "prefix", "suffix", "locale", "pad", "className"]
  },
  Text: {
    doc: "Text { text?: string, split: word|char, as: h1|h2|h3|p|span, stagger?, blur? }. Reveals the text with a spring on mount; text defaults to the replaced element's text. For the page title and section headings.",
    props: ["text", "split", "as", "stagger", "blur", "className"]
  },
  Tooltip: {
    doc: "Tooltip { content: string, side: top|right|bottom|left, delay? }. Wraps the target; the target's text stays.",
    props: ["content", "side", "delay"]
  },
  Switch: {
    doc: "Switch { checked?: boolean, label?, disabled?, onChange?: (checked: boolean) => void }. Keeps its own state.",
    props: ["checked", "label", "ariaLabel", "disabled", "onChange", "className"]
  },
  Checkbox: {
    doc: "Checkbox { checked?: boolean, label?, disabled?, onChange?: (checked: boolean) => void }. Draw-on check mark; keeps its own state.",
    props: ["checked", "label", "disabled", "onChange", "className"]
  },
  Radio: {
    doc: "Radio { options: [{ value, label }], initial?: value, orientation: vertical|horizontal, onChange?: (value) => void }. One choice among a few.",
    props: ["options", "initial", "orientation", "onChange", "className"]
  },
  Select: {
    doc: "Select { options: [{ value, label }], initial?: value, placeholder?, onChange?: (value) => void }. One choice among many; the panel unfolds from the trigger.",
    props: ["options", "initial", "placeholder", "onChange", "className"]
  },
  Input: {
    doc: "Input { placeholder?, defaultValue?, type?, name?, onChange?: (value: string) => void }. Text field.",
    props: ["placeholder", "defaultValue", "type", "name", "onChange", "className"]
  },
  Tabs: {
    doc: "Tabs { tabs: [{ value, label, content? }], initial?: value, variant: pill|underline, onChange?: (value) => void }. Content is optional text.",
    props: ["tabs", "initial", "variant", "onChange"]
  },
  Accordion: {
    doc: "Accordion { items: [{ id, title, description? }], initial?: id, onChange?: (id | null) => void }. Single-open, springy rows. For FAQs, comment threads, settings groups.",
    props: ["items", "initial", "onChange", "className"]
  },
  Loader: {
    doc: "Loader { variant: spinner|dots|bars|dot-matrix|morph|comet, size?: number, label? }. A loading mark for a region that waits.",
    props: ["variant", "size", "speed", "label", "className"]
  }
} as const satisfies Record<string, ComponentDoc>

export type ComponentName = keyof typeof COMPONENTS

export const KIT_DOC = `The page kit is loaded with load_kit and then lives at window.__beui, in the page's world. A persisted run_script that mentions __beui gets the kit loaded before it on every load of this URL.
  __beui.mount(target, name, props?, { mode?, children? }) mounts a component. target: an Element or a CSS selector. mode: "replace" (default; the component takes the element's place and its text), "wrap" (Card's default: the component takes the element's place and the element moves inside it, content and page CSS intact), "inside" (empties the element and renders in it), "append" or "before". children: text for the component; defaults to the replaced element's text. Returns the host element. Calling it again on the same host re-renders instead of duplicating. The target must be in the document: if you build an element yourself, insert it first, then mount. Mount many at once in one script: for (const row of document.querySelectorAll(".athing")) __beui.mount(row, "Card").
  __beui.unmount(target) removes a mounted component and its host.
  __beui.list() names the components.
  __beui.fetch(url, { accept?: "text"|"json" }) reads an address through the extension's own network, so another host's API is reachable from the page. GET, no cookies, text and JSON only, 100000 characters at most. Resolves { url, status, contentType, body, truncated }; rejects with a one-line reason. Check the endpoint with fetch_url first.
Components read the beUI tokens on :root. The tokens are ${TOKEN_KEYS.join(", ")}; in CSS each carries two dashes (var(--primary)), in read_design and write_design the names are bare ({ primary: "..." }). write_design sets them for the whole site, and every component and every rule that reads them follows. Reuse them in your own rules.
The kit picks the light or dark palette from the page's own background and writes it to <html data-beui-theme="light|dark">, and checks again at each mount. To force one, set that attribute in your script before mounting.
Components:
${Object.values(COMPONENTS)
  .map((c) => `- ${c.doc}`)
  .join("\n")}`
