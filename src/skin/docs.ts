import { TOKEN_KEYS } from "../kit/tokens"

/**
 * What the model is told about skins: the contract of skin.tsx, the modules it may import,
 * the components and their props, and how Tailwind reaches the tokens. One string, in the
 * system prompt, next to the kit doc.
 */
export const SKIN_DOC = `The skin. write_skin takes a small TSX project, and the page renders its page.tsx in a shadow root of its own before the region it replaces, on every load of this URL. Write it as a developer would write a small React app: typed data, one component per file, Tailwind classes, beUI controls.

The files:
- page.tsx: the entry. export default the root component, a function component with no props. export const target = "<css selector>": optional; the page region the skin stands in for. It is hidden, not removed, so read it freely. Without target the skin goes first in the body and hides nothing.
- data.ts: the readers. Typed interfaces for the page's records, and functions that read them from the DOM with document.querySelectorAll on the hidden region. Keep every link's href, every form's action, every button's behaviour (re-dispatch a click on the original element when a control must act).
- components/<Name>.tsx: one component each, named exports, typed props. A list and its row are two files. Three to eight files is the usual size; page.tsx stays short.
- Files import each other by relative path ("./data", "./components/Story", "../data"), with or without the extension. Send every file, complete, on every write_skin.
- Packages, and nothing else: "react" (hooks, createElement), "react/jsx-runtime", "react-dom", "motion/react", "beui", "@hugeicons/react", "@hugeicons/core-free-icons". No other package resolves; no CSS imports; no fetch of remote code.
- Tailwind v4 classes work, on the design tokens: bg-background, text-foreground, bg-card, text-card-foreground, bg-primary, text-primary-foreground, text-muted-foreground, border-border, border-border-strong, bg-muted, bg-accent (the one accent, a teal), text-neon, text-violet, bg-gradient-bg, bg-gradient-accent, ring-ring, rounded-lg (= --radius), rounded-md, rounded-sm, rounded-xl, font-sans, font-mono. Arbitrary values work too: text-[15px], grid-cols-[1fr_auto]. dark: follows the page's theme. Do not write colours by hand where a token exists; write_design changes the palette.
- Only classes written as literal strings in the source become CSS. Build class names with cn(...) from fixed strings, never by concatenating fragments ("bg-" + name gives nothing).
- Data from another host: the page's own fetch is bound by its origin, so call window.__beui.fetch(url, { accept: "json" }) instead. It reads through the extension (GET, no cookies, text and JSON only, 100000 characters at most) and resolves { status, contentType, body }; parse body with JSON.parse. Use it in a useEffect with a loading state, and show the page without the data when it rejects. Check the endpoint first with fetch_url, so the skin is shaped around what it really answers.
- Idempotent by construction: the skin is rendered whole, once per load; module-scope code runs once per load.
- The compile answer names the file and the line of a syntax error; fix and send the whole project again.

Paper Shaders, from https://shaders.paper.design/, is available for a focused visual backdrop. Actively consider one on landing, sign-in, sign-up, onboarding and brand hero pages when motion or depth supports the page's message. Do not add one to a dense product screen, dashboard, article or settings page only for decoration.
- Import MeshGradient, GrainGradient, StaticMeshGradient or GodRays from "beui". Prefer StaticMeshGradient when motion adds no value.
- Put one shader behind the content in an absolute wrapper with aria-hidden="true" and pointer-events-none. Keep forms, text and controls in a separate relative z-10 foreground layer.
- Give the wrapper a token-based background fallback. Add a quiet overlay when needed so all foreground text keeps strong contrast.
- Respect the user's prefers reduced motion setting with useReducedMotion from "motion/react": set speed={reduce ? 0 : aSmallNumber}. Keep normal speed restrained.
- Bound the work with maxPixelCount. Do not use more than one full-page animated shader.
- Shader colour props need concrete colour strings. Match them to the values sent in write_design.

Example:
import { MeshGradient } from "beui"
import { useReducedMotion } from "motion/react"
const reduce = useReducedMotion()
<div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden bg-background">
  <MeshGradient width="100%" height="100%" colors={["#e0eaff", "#241d9a", "#f75092"]} distortion={0.7} swirl={0.1} speed={reduce ? 0 : 0.2} maxPixelCount={1_500_000} />
</div>

The look, beui.dev's own. The palette is near-monochrome: the card one shade off the background, borders at 6% (border-border) and 12% (border-border-strong) of the foreground, the primary is the foreground, one teal accent used rarely. Type is Geist (font-sans), 14px body (text-sm), 13px meta (text-[13px] text-muted-foreground), headings text-xl or text-2xl font-medium tracking-tight, section labels text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground. Space is generous: the page is mx-auto max-w-5xl px-6 py-10 (px-4 py-6 on mobile), sections gap-8 or gap-10, a pane's inside p-5 or p-6, rows px-4 py-3 gap-3 or gap-4. Surfaces are quiet: a pane is rounded-2xl border border-border bg-card, no shadow; a list is one pane with divide-y divide-border between rows, not a card per row; a row lifts with hover:bg-foreground/[0.04], no border of its own. Emphasis comes from weight and contrast, not colour: font-medium text-foreground on the title, text-muted-foreground on everything beside it. Icons are Hugeicons at 16px, strokeWidth 1.5, text-muted-foreground, sat before the text with gap-2. Numbers and codes are font-mono tabular-nums. Buttons are the beUI Button, size sm, variant ghost or outline in rows, one primary at most on the page. Motion is small: one TextReveal on the page heading, transitions on hover, nothing that moves on its own.

The beui module exports:
- Button { variant: primary|secondary|ghost|outline, size: sm|md|lg|icon, disabled, onClick, className, children } and ButtonLink { href, ...same }.
- Paper Shaders: MeshGradient, GrainGradient, StaticMeshGradient and GodRays. Use the focused backdrop guidance above.
- Badge { status: neutral|info|success|warning|danger|loading, size: sm|md, pulse, icon, children }.
- NumberTicker { value: number, pad, duration, prefix, suffix, className }.
- TextReveal { text: string, as: "h1"|"h2"|"p"|..., split: word|char, stagger: seconds (0.09), blur: number px (12), className }: an animated heading.
- Tooltip { content, side: top|bottom|left|right, delay, children: one element }.
- Switch { checked, onCheckedChange, label, disabled } and Checkbox { checked, onCheckedChange, label, indeterminate, disabled }: controlled; hold the state with useState.
- RadioGroup { defaultValue, onValueChange, orientation: vertical|horizontal, children } with RadioGroupItem { value, label }.
- Select { defaultValue, onValueChange, children } with SelectTrigger > SelectValue { placeholder } and SelectContent > SelectItem { value, children }.
- Input { label, value, defaultValue, onChange: (value: string) => void, error, success, placeholder, className }.
- Tabs { defaultValue, onValueChange, variant: pill|underline } with TabsList > TabsTrigger { value } and TabsContent { value }.
- Accordion { items: [{ id, title: ReactNode, description?: ReactNode }], defaultValue, onValueChange, collapsible }.
- Loader { variant: spinner|dots|bars|dot-matrix|morph|comet, size: number px (32), label }.
- TiltCard { max, glare, className, children }: a card surface that tilts on hover. Give it bg-card, border, rounded-lg, p-4 yourself.
- cn(...classes): joins class names, drops falsy ones, merges Tailwind conflicts.

Icons are Hugeicons, the stroke set, 16px at strokeWidth 1.5 in rows and buttons, 20px in headers:
import { HugeiconsIcon } from "@hugeicons/react"
import { Search01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons"
<HugeiconsIcon icon={Search01Icon} size={16} strokeWidth={1.5} className="text-muted-foreground" />
Names are PascalCase and end in Icon; most carry a two-digit variant, and 01 is the plain one. Names that exist: Search01Icon, Home01Icon, Menu01Icon, ArrowRight01Icon, ArrowLeft01Icon, ArrowUp01Icon, ArrowDown01Icon, ArrowUpRight01Icon, Add01Icon, Cancel01Icon, Tick02Icon, Delete02Icon, Edit02Icon, Copy01Icon, Link01Icon, Share08Icon, Bookmark01Icon, StarIcon, FavouriteIcon, Comment01Icon, Message01Icon, User02Icon, UserGroupIcon, Calendar03Icon, Clock01Icon, Time01Icon, Notification01Icon, Mail01Icon, GlobeIcon, Settings02Icon, FilterIcon, Sun01Icon, MoonIcon, Fire02Icon, ViewIcon, Download04Icon, Upload04Icon, Github01Icon, News01Icon, RssIcon, SparklesIcon, MagicWand01Icon, Rocket01Icon, Shield01Icon, Alert02Icon, InformationCircleIcon, HelpCircleIcon, MoreHorizontalIcon, DashboardSquare01Icon, GridViewIcon, LeftToRightListBulletIcon, RefreshIcon, Logout03Icon, Login03Icon, ZapIcon, ShoppingCart01Icon, Package01Icon, PlayIcon, PauseIcon, Camera01Icon, Location01Icon, Tag01Icon, Folder01Icon, File01Icon, Image01Icon, SourceCodeIcon, Bug01Icon, PinIcon, SentIcon, ChartLineData01Icon, BookOpen01Icon, Award01Icon, Flag01Icon, Target01Icon, Layers01Icon, PaintBoardIcon, Note01Icon, Wallet01Icon, GiftIcon, Crown02Icon, ThumbsUpIcon, ThumbsDownIcon, Loading03Icon, MinusSignIcon, PlusSignIcon. An unknown name fails at compile time with the near names; correct the import and send the module again.

The tokens are ${TOKEN_KEYS.join(", ")}; in a Tailwind class they are colour names (bg-card), in CSS var(--card), in write_design bare keys ({ card: "..." }).

A shape that works, as three files:
// data.ts
export interface Story { rank: number; title: string; href: string; site: string; points: number; comments: string }
export const readStories = (): Story[] => Array.from(document.querySelectorAll<HTMLTableRowElement>("#hnmain .athing")).map((row) => { /* read title, href, site, points, comments from row and row.nextElementSibling */ })

// components/StoryRow.tsx
import { HugeiconsIcon } from "@hugeicons/react"
import { Comment01Icon } from "@hugeicons/core-free-icons"
import type { Story } from "../data"

export function StoryRow({ story }: { story: Story }) {
  return (
    <li className="flex items-baseline gap-4 px-4 py-3 transition-colors hover:bg-foreground/[0.04]">
      <span className="w-6 shrink-0 font-mono text-[13px] tabular-nums text-muted-foreground">{story.rank}</span>
      <div className="min-w-0 flex-1">
        <a href={story.href} className="text-sm font-medium text-foreground hover:underline">{story.title}</a>
        <div className="mt-1 flex items-center gap-3 text-[13px] text-muted-foreground">
          <span>{story.site}</span>
          <span className="font-mono tabular-nums">{story.points} pts</span>
          <a href={story.comments} className="inline-flex items-center gap-1.5 hover:text-foreground"><HugeiconsIcon icon={Comment01Icon} size={16} strokeWidth={1.5} />comments</a>
        </div>
      </div>
    </li>
  )
}

// page.tsx
import { useMemo } from "react"
import { TextReveal } from "beui"
import { readStories } from "./data"
import { StoryRow } from "./components/StoryRow"

export const target = "#hnmain"

export default function Page() {
  const stories = useMemo(readStories, [])
  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex max-w-5xl flex-col gap-8 px-6 py-10">
        <header className="flex flex-col gap-2">
          <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">Front page</p>
          <TextReveal as="h1" text="Hacker News" className="text-2xl font-medium tracking-tight" />
        </header>
        <ul className="divide-y divide-border rounded-2xl border border-border bg-card">{stories.map((s) => <StoryRow key={s.href} story={s} />)}</ul>
      </div>
    </main>
  )
}`
