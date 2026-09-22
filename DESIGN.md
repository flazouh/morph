---
name: The Morph Workspace
description: The current Morph app style for the extension and marketplace.
colors:
  light-background: "#fcfcfc"
  light-foreground: "#0b0b0b"
  light-card: "#f5f5f5"
  light-muted-foreground: "#636363"
  light-accent: "#00bebf"
  light-destructive: "#ee343b"
  light-border: "#0b0b0b0f"
  light-border-strong: "#0b0b0b1f"
  dark-background: "#151515"
  dark-foreground: "#f2f2f2"
  dark-card: "#1c1c1c"
  dark-muted-foreground: "#868686"
  dark-accent: "#00dadb"
  dark-border: "#ffffff0d"
  dark-border-strong: "#ffffff1a"
  success: "#00bd6c"
  warning: "#f5a500"
  neon: "#45e059"
  light-violet: "#a37aff"
  dark-violet: "#ad8cff"
  mascot-pink: "#E02988"
  mascot-orange: "#FF9800"
  mascot-green: "#009957"
  mascot-purple: "#804EE0"
typography:
  display:
    fontFamily: '"Geist Variable", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif'
    fontSize: "3.75rem"
    fontWeight: 600
    lineHeight: 1.08
    letterSpacing: "-0.04em"
  headline:
    fontFamily: '"Geist Variable", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif'
    fontSize: "3rem"
    fontWeight: 600
    letterSpacing: "-0.035em"
  title:
    fontFamily: '"Geist Variable", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif'
    fontSize: "1.25rem"
    fontWeight: 600
    letterSpacing: "-0.02em"
  body:
    fontFamily: '"Geist Variable", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif'
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.45
  marketplace-body:
    fontFamily: '"Geist Variable", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif'
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: "1.75rem"
  label:
    fontFamily: '"Geist Variable", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif'
    fontSize: "0.75rem"
    fontWeight: 500
  mono:
    fontFamily: '"Geist Mono Variable", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace'
    fontSize: "0.6875rem"
    fontWeight: 400
rounded:
  sm: "calc(0.5rem - 4px)"
  md: "calc(0.5rem - 2px)"
  lg: "0.5rem"
  xl: "calc(0.5rem + 4px)"
  "2xl": "1rem"
  full: "calc(infinity * 1px)"
spacing:
  "3": "0.75rem"
  "5": "1.25rem"
  "8": "2rem"
  "12": "3rem"
  "16": "4rem"
components:
  button-primary:
    backgroundColor: "{colors.light-foreground}"
    textColor: "{colors.light-background}"
    rounded: "{rounded.full}"
    height: "2.5rem"
    padding: "0 1.25rem"
    typography: "{typography.body}"
  button-secondary:
    backgroundColor: "{colors.light-card}"
    textColor: "{colors.light-foreground}"
    rounded: "{rounded.full}"
    height: "2.5rem"
    padding: "0 1.25rem"
  input:
    backgroundColor: "transparent"
    textColor: "{colors.light-foreground}"
    rounded: "{rounded.full}"
    height: "2.75rem"
    padding: "0 0.875rem"
  marketplace-card:
    backgroundColor: "{colors.light-card}"
    textColor: "{colors.light-foreground}"
    rounded: "{rounded.2xl}"
    padding: "1.25rem"
---

# Design System: The Morph Workspace

## Overview

**Creative North Star: "Current Morph app style"**

The Morph Workspace uses the current Morph app style across the extension and marketplace. It pairs near-monochrome surfaces with teal accents, Geist type, rounded controls, and colorful Morph mascots.

The interface stays quiet and direct. Tonal surfaces organize content, while motion gives short feedback and respects reduced-motion settings.

**Key Characteristics:**
- Near-monochrome light and dark themes
- Teal selection and identity cues
- Rounded controls and quiet tonal containers
- Colorful Morph mascots for brand and thread identity

## Colors

The palette uses paired light and dark neutrals with one teal accent. Status colors and four mascot colors add limited functional color.

### Primary
- **Ink:** The primary action and text color in the light theme.
- **Light Ink:** The primary action and text color in the dark theme.
- **Morph Teal:** Carets, selection, preview initials, and other accent cues.

### Secondary
- **Morph Violet:** The second endpoint in the accent gradient.

### Tertiary
- **Mascot Pink, Orange, Green, and Purple:** Brand shapes and chat thread identity.

### Neutral
- **Canvas:** The page and panel background in each theme.
- **Quiet Surface:** Cards, popovers, selected navigation, and muted regions.
- **Muted Text:** Supporting copy and inactive controls.
- **Soft Border:** Low-contrast boundaries and focus rings.

### Named Rules

**The Teal Cue Rule.** Use teal for selection, caret, and small identity cues.

## Typography

**Display Font:** Geist Variable with the system sans-serif stack
**Body Font:** Geist Variable with the system sans-serif stack
**Label/Mono Font:** Geist Mono Variable with the system monospace stack

**Character:** Geist keeps the product compact and plain. Tight display tracking gives marketplace headings a clear editorial scale.

### Hierarchy
- **Display:** Large marketplace hero text.
- **Headline:** Package and publishing page titles.
- **Title:** Result names and section headings.
- **Body:** The compact extension and page base text.
- **Marketplace Body:** Marketplace descriptions and form content.
- **Label:** Metadata, tabs, counts, and control labels.
- **Mono:** Versions, scopes, package initials, and technical values.

## Layout

Marketplace content uses a centered `72rem` container. Page padding changes from `1.25rem` to `2rem` at the `640px` breakpoint.

The marketplace changes from stacked content to rows at `640px`. Package details add a sticky `20rem` install panel at `1024px`.

The extension header is `2.5rem` high. The chat tab strip is `2.25rem` high and scrolls horizontally.

## Elevation & Depth

Most depth comes from tonal surfaces and low-contrast borders. Glass surfaces add blur, a soft border, an inset highlight, and one ambient shadow.

### Named Rules

**The Tonal Depth Rule.** Use background changes and borders before shadows.

## Shapes

The base radius is `0.5rem`. Controls use derived small through extra-large radii, while action buttons and inputs use pill shapes.

Marketplace cards and preview containers use `1rem` corners. Chat tabs use `10px` top corners and a pill-shaped active indicator.

## Components

### Buttons
- **Shape:** Text buttons use pill corners. Icon buttons use `0.5rem` corners.
- **Primary:** The foreground color fills the button, and the background color sets its text.
- **Secondary:** A card surface and soft border keep the action quiet.
- **Ghost / Outline:** Ghost controls add a faint foreground tint on hover. Outline controls keep a transparent background.
- **Motion:** Hover scales to `1.02`. Press scales to `0.93`. Reduced motion removes both transforms.

### Cards / Containers
- **Corner Style:** Marketplace containers use `1rem` corners.
- **Background:** Cards use the quiet surface color.
- **Shadow Strategy:** Most cards stay flat. Glass surfaces and preview labels use shadows.
- **Border:** Lists use the stronger border token as a divider.

### Inputs / Fields
- **Style:** Inputs use transparent fills, pill borders, and `2.75rem` height.
- **Focus:** Focus adds a stronger border and a two-pixel ring.
- **Error / Disabled:** Errors use the destructive border and ring. Disabled fields use reduced opacity.

### Navigation

Marketplace navigation uses compact rounded text controls. The active item uses the muted surface, while inactive items use muted text.

Chat tabs use mascot marks, truncated labels, keyboard navigation, and a moving two-pixel active indicator.

### Morph Mascots

The Morph logo and thread mascots use the four fixed brand colors. Thread mascots give each site thread a stable visual identity.

## Do's and Don'ts

### Do:
- **Do** use visible focus rings on interactive controls.
- **Do** remove nonessential motion when the user requests reduced motion.
- **Do** use tonal surfaces and subtle borders to group related content.
- **Do** show exact scope, permissions, and source before installation.

### Don't:
- **Don't** replace the marketplace result list with a generic card wall.
- **Don't** remove keyboard tab behavior from the chat thread navigation.
- **Don't** invent popularity or customer proof that the product does not have.
