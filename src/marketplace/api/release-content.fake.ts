/**
 * Real WebP bytes, made without an encoder.
 *
 * Nothing in the API decodes an image: it checks the RIFF header, hashes the bytes and
 * commits them. So a header and some padding exercise exactly the code that runs in
 * production, and a test never carries a binary fixture it cannot read.
 */
import { digestOfBytes } from "../compiler/digest"
import type { ReleasePreviews } from "./release-content"

/** Bytes over their own buffer, which is what `crypto.subtle` and the digests take. */
export type Bytes = Uint8Array<ArrayBuffer>

const ascii = (bytes: Bytes, at: number, text: string): void => {
  for (let index = 0; index < text.length; index += 1) bytes[at + index] = text.charCodeAt(index)
}

const write = (bytes: Bytes, at: number, value: number, width: number): void => {
  for (let index = 0; index < width; index += 1) bytes[at + index] = (value >>> (index * 8)) & 0xff
}

export interface WebpOptions {
  /** The variant to write: `VP8X`, `VP8 ` and `VP8L` each state their size differently. */
  readonly chunk?: string
  readonly width?: number
  readonly height?: number
  readonly bytes?: number
  /** Padding, so two images of one size are still two different images. */
  readonly fill?: number
}

export const webpOf = ({ chunk = "VP8X", width = 1280, height = 800, bytes: length = 64, fill = 0 }: WebpOptions = {}): Bytes => {
  const bytes = new Uint8Array(length).fill(fill, 30)
  ascii(bytes, 0, "RIFF")
  write(bytes, 4, length - 8, 4)
  ascii(bytes, 8, "WEBP")
  ascii(bytes, 12, chunk)
  write(bytes, 16, length - 20, 4)
  if (chunk === "VP8X") {
    write(bytes, 24, width - 1, 3)
    write(bytes, 27, height - 1, 3)
  }
  if (chunk === "VP8 ") {
    ascii(bytes, 23, "\x9d\x01\x2a")
    write(bytes, 26, width, 2)
    write(bytes, 28, height, 2)
  }
  if (chunk === "VP8L") {
    bytes[20] = 0x2f
    write(bytes, 21, (width - 1) | ((height - 1) << 14), 4)
  }
  return bytes
}

export const base64Of = (bytes: Bytes): string => {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export const imageOf = async (bytes: Bytes): Promise<ReleasePreviews["before"]> => ({
  data: base64Of(bytes),
  digest: await digestOfBytes(bytes)
})

/** One viewport, twice, as a submission carries it: same size, different bytes. */
export const previewsOf = async (before = webpOf(), after = webpOf({ fill: 7 })): Promise<ReleasePreviews> => ({
  before: await imageOf(before),
  after: await imageOf(after)
})
