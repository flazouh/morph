import preflight from "tailwindcss/preflight.css?raw"
import theme from "tailwindcss/theme.css?raw"
import utilities from "tailwindcss/utilities.css?raw"
import type { CompilerPorts } from "./compile"
import { LENT_MODULE_IDS } from "../sandbox/lentModules"
import { icons } from "../../skin/icons"

/**
 * The browser binding for the standard package compiler.
 *
 * Vite turns the three Tailwind sheets into text. The icon set is the extension's own
 * packed asset, fetched once: the service worker compiles packages too, and Chrome
 * refuses a dynamic `import()` there. The sandbox loads its shared font separately.
 */
export const browserCompilerPorts: CompilerPorts = {
  lent: LENT_MODULE_IDS,
  sheets: {
    "tailwindcss/theme.css": theme,
    "tailwindcss/preflight.css": preflight,
    "tailwindcss/utilities.css": utilities
  },
  icons
}
