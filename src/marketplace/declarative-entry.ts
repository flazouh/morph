import { applyDeclarativeView } from "./runtime"

declare global {
  interface Window {
    __redesignDeclarativeApply?: (view: unknown) => void
    __redesignDeclarativeUndo?: () => void
  }
}

export const startDeclarative = (): void => {
window.__redesignDeclarativeApply = (view: unknown): void => {
  window.__redesignDeclarativeUndo?.()
  window.__redesignDeclarativeUndo = applyDeclarativeView(view, document)
}
}
