import { randomToken } from "@/lib/random-token"

export const PANEL_NONCE_HASH_KEY = "morph-nonce"

/** A fresh secret the embedded panel reads from its own URL. The page host stores it out of page reach. */
export const mintPanelNonce = (): string => randomToken()

export const panelSrcWithNonce = (baseSrc: string, nonce: string): string => {
  const hash = `${PANEL_NONCE_HASH_KEY}=${encodeURIComponent(nonce)}`
  const cut = baseSrc.indexOf("#")
  const root = cut >= 0 ? baseSrc.slice(0, cut) : baseSrc
  return `${root}#${hash}`
}

export const readPanelNonce = (location: Pick<Location, "hash">): string | null => {
  if (!location.hash.startsWith("#")) return null
  const params = new URLSearchParams(location.hash.slice(1))
  const nonce = params.get(PANEL_NONCE_HASH_KEY)
  return typeof nonce === "string" && nonce.length > 0 ? nonce : null
}

/**
 * A frame's origin: the postMessage targetOrigin for host-to-panel delivery, and the
 * boundary the worker judges a message sender against. `null` when the URL does not parse.
 *
 * Built from the parsed scheme and host rather than read from `URL.origin`, which is the
 * opaque string `"null"` for every non-special scheme, `chrome-extension:` and `file:`
 * included: by `URL.origin` any two extensions, and any two files, have the same origin.
 */
export const frameOrigin = (url: string): string | null => {
  try {
    const parsed = new URL(url)
    return `${parsed.protocol}//${parsed.host}`
  } catch {
    return null
  }
}
