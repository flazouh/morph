/**
 * The inspector's own chrome: the hover outline, the tag label, and the
 * control panel. Morph dark-card style: `#151515`/`#1c1c1c` surfaces,
 * `#f2f2f2` text, `#868686` muted text, teal `#00dadb` for selection and
 * focus, soft white borders, one ambient shadow, and 150ms color/opacity
 * transitions only where they show state. The hover outline itself is
 * immediate, with no transition.
 *
 * `#ee343b` (Morph red) is 4.2:1 on `#1c1c1c`, short of the 4.5:1 WCAG AA
 * text minimum, so it stays a non-text cue only (borders). Warning text and
 * destructive-control text use `#f87171`, a lighter red at 6.2:1.
 */

export interface PanelSize {
  readonly width: number
  readonly height: number
}

export const inspectorCss = (panelSize: PanelSize): string => `
:host, .mi-root {
  all: initial;
}
.mi-root * {
  box-sizing: border-box;
  font-family: "Geist Variable", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
.mi-outline {
  position: fixed;
  z-index: 2147483647;
  border: 2px solid #00dadb;
  border-radius: 2px;
  background: rgba(0, 218, 219, 0.08);
  pointer-events: none;
}
.mi-tag {
  position: fixed;
  z-index: 2147483647;
  transform: translateY(-100%);
  padding: 2px 6px;
  border-radius: 4px;
  background: #151515;
  color: #f2f2f2;
  border: 1px solid rgba(255, 255, 255, 0.12);
  font-family: "Geist Mono Variable", ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  line-height: 1.4;
  pointer-events: none;
  white-space: nowrap;
}
.mi-tag-component {
  font-family: "Geist Variable", ui-sans-serif, system-ui, -apple-system, sans-serif;
  color: #868686;
}
.mi-panel {
  position: fixed;
  z-index: 2147483647;
  width: ${panelSize.width}px;
  max-height: ${panelSize.height}px;
  overflow: auto;
  background: #1c1c1c;
  color: #f2f2f2;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.32);
  padding: 12px;
  font-size: 12px;
  pointer-events: auto;
}
.mi-component {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin-bottom: 8px;
}
/* An author rule for \`display\` outranks the user agent's own \`[hidden]\` rule. */
.mi-component[hidden] {
  display: none;
}
.mi-component-label {
  color: #868686;
  font-size: 10px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.mi-component-name {
  color: #00dadb;
  font-family: "Geist Mono Variable", ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mi-crumbs {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
  margin-bottom: 8px;
}
.mi-crumb {
  all: unset;
  box-sizing: border-box;
  font-family: "Geist Mono Variable", ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  color: #868686;
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 6px;
  padding: 2px 6px;
  cursor: pointer;
  transition: color 150ms ease, border-color 150ms ease;
}
.mi-crumb:hover {
  color: #f2f2f2;
}
.mi-crumb:focus-visible {
  outline: 2px solid #00dadb;
  outline-offset: 1px;
}
.mi-crumb[aria-current="true"] {
  color: #00dadb;
  border-color: #00dadb;
}
.mi-warning {
  color: #f87171;
  font-size: 11px;
  line-height: 1.5;
  margin-bottom: 8px;
}
.mi-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}
.mi-label {
  color: #868686;
  font-size: 11px;
}
.mi-field {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  min-width: 0;
}
.mi-value {
  all: unset;
  box-sizing: border-box;
  width: 128px;
  background: #151515;
  color: #f2f2f2;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 6px;
  padding: 4px 6px;
  font-family: "Geist Mono Variable", ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  transition: border-color 150ms ease;
}
.mi-value:focus-visible {
  outline: 2px solid #00dadb;
  outline-offset: 1px;
  border-color: #00dadb;
}
.mi-value:disabled {
  opacity: 0.5;
}
.mi-slider {
  all: unset;
  box-sizing: border-box;
  width: 72px;
  height: 18px;
  cursor: pointer;
}
.mi-slider[hidden] {
  display: none;
}
.mi-slider::-webkit-slider-runnable-track {
  height: 4px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.12);
}
.mi-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 12px;
  height: 12px;
  margin-top: -4px;
  border-radius: 50%;
  background: #00dadb;
  border: 2px solid #151515;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.18);
}
.mi-slider:focus-visible {
  outline: 2px solid #00dadb;
  outline-offset: 2px;
  border-radius: 999px;
}
.mi-slider:disabled {
  opacity: 0.5;
  cursor: default;
}
.mi-picker {
  all: unset;
  box-sizing: border-box;
  width: 24px;
  height: 24px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: #151515;
  cursor: pointer;
  overflow: hidden;
}
.mi-picker[hidden] {
  display: none;
}
.mi-picker::-webkit-color-swatch-wrapper {
  padding: 2px;
}
.mi-picker::-webkit-color-swatch {
  border: 0;
  border-radius: 4px;
}
.mi-picker:focus-visible {
  outline: 2px solid #00dadb;
  outline-offset: 1px;
}
.mi-picker:disabled {
  opacity: 0.5;
  cursor: default;
}
.mi-tokens {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  max-height: 72px;
  overflow: auto;
  margin: -2px 0 8px;
}
.mi-tokens[hidden] {
  display: none;
}
.mi-token {
  all: unset;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  padding: 2px 6px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 999px;
  color: #868686;
  cursor: pointer;
  font-family: "Geist Mono Variable", ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10px;
  transition: color 150ms ease, border-color 150ms ease;
}
.mi-token:hover {
  color: #f2f2f2;
}
.mi-token:focus-visible {
  outline: 2px solid #00dadb;
  outline-offset: 1px;
}
.mi-token[aria-pressed="true"] {
  color: #00dadb;
  border-color: #00dadb;
}
.mi-token:disabled {
  opacity: 0.5;
  cursor: default;
}
.mi-token-swatch {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.18);
}
.mi-changes {
  margin-top: 8px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  padding-top: 8px;
}
.mi-change {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 2px 0;
}
.mi-change-text {
  font-family: "Geist Mono Variable", ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10px;
  color: #868686;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mi-remove {
  all: unset;
  box-sizing: border-box;
  cursor: pointer;
  color: #868686;
  font-size: 12px;
  line-height: 1;
  padding: 0 4px;
  transition: color 150ms ease;
}
.mi-remove:hover {
  color: #f87171;
}
.mi-remove:focus-visible {
  outline: 2px solid #00dadb;
  outline-offset: 1px;
}
.mi-handoff {
  display: flex;
  gap: 6px;
  margin-top: 8px;
}
.mi-status {
  margin-top: 8px;
  padding: 6px 8px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.04);
  color: #f2f2f2;
  font-size: 11px;
  line-height: 1.4;
}
.mi-status:empty {
  margin: 0;
  padding: 0;
  border: 0;
  background: transparent;
}
.mi-status[data-mi-error="true"] {
  border-color: rgba(238, 52, 59, 0.4);
  color: #f87171;
}
.mi-actions {
  display: flex;
  gap: 6px;
  margin-top: 8px;
}
.mi-action {
  all: unset;
  box-sizing: border-box;
  flex: 1;
  text-align: center;
  padding: 6px 8px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: #f2f2f2;
  cursor: pointer;
  font-size: 11px;
  transition: color 150ms ease, border-color 150ms ease, opacity 150ms ease;
}
.mi-action:hover:not(:disabled) {
  border-color: #00dadb;
  color: #00dadb;
}
.mi-action:focus-visible {
  outline: 2px solid #00dadb;
  outline-offset: 1px;
}
.mi-action:disabled {
  opacity: 0.4;
  cursor: default;
}
.mi-action[data-mi-discard] {
  color: #f87171;
  border-color: rgba(238, 52, 59, 0.4);
}
@media (prefers-reduced-motion: reduce) {
  .mi-root * {
    transition: none !important;
    transform: none !important;
    animation: none !important;
  }
  .mi-tag {
    transform: none;
  }
}
`
