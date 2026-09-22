/**
 * Preloaded for the panel tests only (`bun run test`): gives React a DOM to render into.
 * The harness tests run without it, on Bun's own fetch and streams, which happy-dom's
 * globals would replace.
 * `matchMedia` is missing from happy-dom; motion reads it for reduced-motion.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { MotionGlobalConfig } from "motion"

const NativeRequest = globalThis.Request
const NativeResponse = globalThis.Response
const NativeHeaders = globalThis.Headers

GlobalRegistrator.register()
globalThis.Request = NativeRequest
globalThis.Response = NativeResponse
globalThis.Headers = NativeHeaders

// Tests want end states, not motion: every animation resolves at once.
MotionGlobalConfig.skipAnimations = true

if (typeof window.matchMedia !== "function") {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false
    }) as MediaQueryList
}

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The panel loads OpenRouter's catalog on mount. Tests stay on the static list.
const innerFetch = globalThis.fetch
globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  if (url.includes("openrouter.ai/api/v1/models")) return Promise.reject(new TypeError("catalog is stubbed"))
  return innerFetch(input, init)
}) as typeof fetch
