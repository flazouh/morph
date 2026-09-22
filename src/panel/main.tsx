import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "@/styles/globals.css"
import { App, type AppProps } from "./App"
import { postWindowAction, watchExtensionContext } from "./window"

const embeddedPanelProps = (): Pick<AppProps, "onWindowAction"> | Record<string, never> =>
  window.parent === window ? {} : { onWindowAction: postWindowAction }

const root = document.getElementById("root")
if (root === null) throw new Error("panel.html has no #root")

// The first paint follows the OS so nothing flashes; the App then owns the palette from
// the stored theme (see appearance.ts), including the OS listener while `system` is set.
const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches
document.documentElement.setAttribute("data-beui-theme", prefersDark ? "dark" : "light")

if (window.parent !== window) watchExtensionContext()

createRoot(root).render(
  <StrictMode>
    <App {...embeddedPanelProps()} />
  </StrictMode>
)
