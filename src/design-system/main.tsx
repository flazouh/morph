import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "@/styles/globals.css"
import { DesignSystem } from "./DesignSystem"

const root = document.getElementById("root")
if (root === null) throw new Error("design-system.html has no #root")

createRoot(root).render(
  <StrictMode>
    <DesignSystem />
  </StrictMode>
)
