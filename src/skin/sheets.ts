import preflight from "tailwindcss/preflight.css?raw"
import twTheme from "tailwindcss/theme.css?raw"
import utilities from "tailwindcss/utilities.css?raw"
import shadow from "../styles/shadow.css?raw"
import theme from "../styles/theme.css?raw"
import type { Sheets } from "./compile"

/** The stylesheets the skin compiler needs, bundled by Vite as text. The panel's binding; tests read them from disk. */
export const sheets: Sheets = {
  "tailwindcss/theme.css": twTheme,
  "tailwindcss/preflight.css": preflight,
  "tailwindcss/utilities.css": utilities,
  "theme.css": theme,
  "shadow.css": shadow
}
