import { StrictMode, useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import "@/styles/globals.css"
import "./marketplace.css"
import { MarketplaceApp } from "./App"
import { createMarketplaceClient } from "../client"

type Theme = "light" | "dark"

const preferredTheme = (): Theme => (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
const marketplace = createMarketplaceClient()

function Root() {
  const [theme, setTheme] = useState<Theme>(preferredTheme)

  useEffect(() => {
    document.documentElement.setAttribute("data-beui-theme", theme)
    document.documentElement.style.colorScheme = theme
  }, [theme])

  return <MarketplaceApp client={marketplace} theme={theme} onThemeChange={setTheme} />
}

const root = document.getElementById("root")
if (root === null) throw new Error("marketplace.html has no #root")

createRoot(root).render(
  <StrictMode>
    <Root />
  </StrictMode>
)
