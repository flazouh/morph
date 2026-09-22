import { canonicalJson, type ReleaseReceipt } from "./publishing"

const encoder = new TextEncoder()
const base64Url = (bytes: Uint8Array): string => {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}

export const releaseReceiptSigner = (
  secret: string
): ((receipt: ReleaseReceipt) => Promise<string>) => {
  if (new TextEncoder().encode(secret).byteLength < 32) {
    throw new Error("RELEASE_RECEIPT_SECRET must contain at least 32 bytes")
  }
  return async (receipt) => {
    const payload = base64Url(encoder.encode(canonicalJson(receipt)))
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    )
    const signature = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, encoder.encode(`v1.${payload}`))
    )
    return `v1.${payload}.${base64Url(signature)}`
  }
}
