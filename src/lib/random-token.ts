const TOKEN_BYTES = 16

/** 128-bit cryptographically random token; works outside secure contexts. */
export const randomToken = (): string => {
  const bytes = new Uint8Array(TOKEN_BYTES)
  crypto.getRandomValues(bytes)
  let out = ""
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0")
  }
  return out
}
