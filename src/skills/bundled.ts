import type { BuiltInSkill } from "./contract"

export const BUILT_IN_SKILLS: ReadonlyArray<BuiltInSkill> = [
  {
    id: "art-direction",
    kind: "built-in",
    enabled: true,
    version: 1,
    updatedAt: "bundled",
    title: "Art Direction",
    summary: "Visual personality, mood, and cohesion across an interface.",
    source: { label: "Hallmark", url: "https://www.usehallmark.com/" },
    content: `Choose the interface genre before you choose its visual details. Use editorial, modern-minimal, atmospheric, or playful only when the product context supports that choice.

Read the existing design system first. Preserve its font stack, palette, spacing scale, framework, and motion stance unless the user asks for a change.

Choose a structure that fits the job. Do not reuse the same hero, three-card feature row, call to action, and footer rhythm for unrelated pages. Structural variety matters more than a new color theme.

Use one clear visual idea. Let the type pairing, layout bias, surface treatment, and image direction support the same idea. Remove decoration with no product meaning.

Do not invent metrics, testimonials, logos, product claims, or customer facts. Use confirmed content, a marked placeholder, or a structure that does not need the missing proof.

Reject common generated patterns. Do not use purple gradient heroes, gradient headings, floating color blobs, generic three-column feature cards, nested cards, or fake browser chrome.

Use one icon family. Keep its stroke weight and visual size consistent. Do not use emoji as feature icons.

Before delivery, review philosophy, hierarchy, execution, specificity, restraint, and variety. Revise any weak area before you show the result.`,
  },
  {
    id: "layout-and-hierarchy",
    kind: "built-in",
    enabled: true,
    version: 1,
    updatedAt: "bundled",
    title: "Layout and Hierarchy",
    summary: "Reading order, spatial grouping, and visual weight distribution.",
    source: { label: "Hallmark", url: "https://www.usehallmark.com/" },
    content: `Give each layout a primary axis. Choose a left bias, right bias, top weight, or bottom weight. Do not center everything by default.

Use a named 4px spacing scale. Use tokens for every repeated gap and inset. Use gap for sibling spacing and margin only for optical adjustment.

Prefer CSS Grid for page layout and Flexbox for component internals. Use minmax(0, 1fr) for tracks that can contain wide content.

Build hierarchy with scale, weight, negative space, and alignment before you add borders or shadows. Group related items by proximity.

Avoid equal three-column card grids. Vary spans, widths, heights, or alignment when the content supports it. Remove a card when plain type creates a clearer structure.

Break the grid once when it strengthens the composition. Keep the break deliberate and protect the document from horizontal scrolling.

Use one containment layer. Do not put a bordered card inside another bordered card.

Use named z-index levels. Do not add arbitrary large z-index values.

Vary section spacing by content and importance. Equal padding across every section makes the page look like a template.`,
  },
  {
    id: "typography",
    kind: "built-in",
    enabled: true,
    version: 1,
    updatedAt: "bundled",
    title: "Typography",
    summary: "Typeface selection, scale, weight contrast, and line measure.",
    source: { label: "Hallmark", url: "https://www.usehallmark.com/" },
    content: `Use a deliberate display and body pairing. A third family is permitted only for one outlier role in no more than two places. A single-family page is valid only when that choice defines the design.

Do not choose Inter, Roboto, Open Sans, or a system stack by default. Use a distinctive free face that fits the product. Use a paid face only when the user confirms its license.

Build the type scale from a ratio, not arbitrary increments. Use no more than five sizes on one page. Use weight and color for the remaining hierarchy.

Keep body text at 16px or larger. Keep all text at 10px or larger. Use 1.5 to 1.65 line-height for body text and 1.05 to 1.2 for display text.

Keep prose between 45 and 75 characters per line. Use 65ch as the default maximum.

Create clear weight contrast. Keep body text near 400 and separate heading weight by at least 300 units.

Keep display headings roman. Do not italicize one heading word for decoration. Use weight, color, or an underline for emphasis.

Use tight tracking on large display text and loose tracking on small uppercase labels. Do not add wide tracking to lowercase body text.

Use tabular numbers for data. Load each required font weight and use font-display: swap. Keep heading levels in semantic order.`,
  },
  {
    id: "color-and-tokens",
    kind: "built-in",
    enabled: true,
    version: 1,
    updatedAt: "bundled",
    title: "Color and Tokens",
    summary: "Token layers, palette constraints, depth, and dark mode mapping.",
    source: { label: "Hallmark", url: "https://www.usehallmark.com/" },
    content: `Use OKLCH for the palette. Use one anchor hue and tint the neutral scale toward it.

Define paper, ink, five to nine neutral steps, and one accent. Use two accents only when the product needs a second semantic signal.

Do not use pure black, pure white, or zero-chroma gray as base colors. Add a small anchor tint to every neutral.

Keep the accent near 3 percent of each viewport. Use it for active states, focus rings, links, and small visual anchors. Do not fill large page regions with it.

Lock colors behind named tokens before implementation. Every component and state must use those tokens. Do not add inline color values during the build.

Give each interactive state a semantic token. Define an accent-ink token for text placed on an accent surface.

For dark mode, keep the same hue. Change lightness and chroma. Higher surfaces become lighter. Reduce accent chroma and raise its lightness.

Check every foreground and background pair. Body text needs at least 4.5:1 WCAG contrast. Large text, icons, boundaries, and focus rings need at least 3:1.

Do not use purple-to-cyan, purple-to-blue, orange-to-pink, or three-stop gradients. Do not use color as the only error or status signal.`,
  },
  {
    id: "components-and-states",
    kind: "built-in",
    enabled: true,
    version: 1,
    updatedAt: "bundled",
    title: "Components and States",
    summary: "State completeness, focus, empty, error, and loading patterns.",
    source: { label: "Hallmark", url: "https://www.usehallmark.com/" },
    content: `Design every interactive component in eight states: default, hover, focus, active, disabled, loading, error, and success.

Show a visible focus ring on every control. Use focus-visible, a 2px to 3px ring, a 2px offset, and at least 3:1 contrast. Never animate the ring.

Keep border thickness, padding, and height constant across states. Change color, background, outline, opacity, or transform without moving the layout.

Use a minimum 44px touch target. Increase the invisible hit area when the visible control must stay compact.

Put visible labels above inputs. Use placeholders for format examples only. Put helper or error text below the field in one stable slot.

Validate on blur. After the field is touched, revalidate on change. Connect errors with aria-describedby and aria-invalid.

Use a skeleton for predictable content layouts. Use an inline spinner for a button action. Delay a spinner that would otherwise flash.

Use an explanatory empty state with one next action. Use a specific error message that says what failed and how to fix it.

Use optimistic changes and Undo for reversible actions. Keep confirmation for irreversible destructive actions.

Use native dialog, popover, select, checkbox, and radio behavior when possible. Do not rebuild browser accessibility without a product need.`,
  },
  {
    id: "responsive-accessibility",
    kind: "built-in",
    enabled: true,
    version: 1,
    updatedAt: "bundled",
    title: "Responsive and Accessible Design",
    summary: "Mobile-first layout, touch targets, contrast, keyboard, and ARIA.",
    source: { label: "Hallmark", url: "https://www.usehallmark.com/" },
    content: `Start with the smallest viewport. Add min-width media queries only when the content needs a new layout.

Check every interface at 320px, 375px, 414px, and 768px. Make sure no page scrolls horizontally.

Use overflow-x: clip on html and body when decorative content can leave the viewport. Do not use hidden because it can break sticky content.

Do not use width: 100vw. Use width: 100% with container padding. Use dvh, svh, or lvh when mobile browser chrome affects height.

Keep buttons, primary links, tabs, breadcrumbs, and calls to action on one line. Shorten the label or reflow its parent when space is tight.

Use minmax(0, 1fr) for image-bearing grid tracks. Give long display text min-width: 0 and overflow-wrap: anywhere.

Use rem breakpoints and clamp for fluid type and spacing. Use pointer and hover queries for interaction capability.

Keep DOM order equal to reading and focus order. Give each icon-only control an accessible name. Use semantic HTML before ARIA.

Support keyboard use, visible focus, reduced motion, dark-mode contrast, text enlargement, and coarse pointers.

Reserve 30 to 40 percent more width for translated labels. Use logical CSS properties so right-to-left layouts can work.`,
  },
  {
    id: "motion-craft",
    kind: "built-in",
    enabled: true,
    version: 1,
    updatedAt: "bundled",
    title: "Motion Craft",
    summary: "Duration, easing, composited properties, stagger, and interruption.",
    source: {
      label: "Emil Kowalski",
      url: "https://www.skills.sh/emilkowalski/skills/improve-animations"
    },
    content: `Animate only when motion explains space, state, feedback, or a change that would otherwise feel abrupt. Remove motion from controls used hundreds of times each day.

Use ease-out for entering and exiting, ease-in-out for movement on screen, ease for hover and color changes, and linear for constant motion. Do not use ease-in for interface feedback.

Define shared motion tokens. Use cubic-bezier(0.23, 1, 0.32, 1) for strong ease-out, cubic-bezier(0.77, 0, 0.175, 1) for strong ease-in-out, and cubic-bezier(0.32, 0.72, 0, 1) for drawers.

Keep interface motion under 300ms in normal cases. Use 100ms to 160ms for press feedback, 125ms to 200ms for tooltips, 150ms to 250ms for dropdowns, and 200ms to 500ms for modals or drawers.

Never animate from scale(0). Start small entrances between scale(0.9) and scale(0.97). Set a popover, dropdown, or tooltip origin at its trigger.

Use transitions for reversible motion because they retarget from the current state. Do not use restarting keyframes for toggles, stacks, drags, or rapidly reversed controls.

Animate transform and opacity. Do not animate width, height, margin, padding, top, or left. Do not use transition: all.

Use springs for gesture motion so interruption keeps velocity. Keep bounce between 0.1 and 0.3 and reserve visible bounce for physical or playful actions.

For reduced motion, remove position changes but keep short opacity or color feedback. Gate hover motion with hover and fine-pointer media queries.

Use 30ms to 80ms stagger only when it clarifies a small group. Never delay interaction. Delete motion before you add decorative movement.`,
  },
]
