import { describe, expect, test } from "bun:test"
import { digestOf, digestOfBytes } from "../compiler/digest"
import { base64Of, imageOf, previewsOf, webpOf } from "./release-content.fake"
import {
  byteLengthOf,
  canonicalJson,
  checkedPreviews,
  digestOfFile,
  PREVIEW_FILES,
  PREVIEW_LIMIT_BYTES,
  previewFilesOf,
  ReleaseContentError,
  type ReleasePreviews
} from "./release-content"

/** The code a rejection carries, or the value it returned when it did not reject. */
const codeOf = async (previews: ReleasePreviews): Promise<string> => {
  try {
    await checkedPreviews(previews)
    return "accepted"
  } catch (cause) {
    if (cause instanceof ReleaseContentError) return cause.code
    throw cause
  }
}

describe("preview images", () => {
  test("both images are decoded, digested and kept as one payload the commit can carry", async () => {
    const bytes = webpOf()
    const previews = await previewsOf(bytes)
    const checked = await checkedPreviews(previews)

    expect(checked.before.digest).toBe(await digestOfBytes(bytes))
    expect(checked.before.data).toBe(base64Of(bytes))
    expect(checked.after).toEqual(previews.after)
    expect(checked.after.digest).not.toBe(checked.before.digest)

    // A data URL and its bare payload are the same image, so both normalise to one form.
    const asUrl = await checkedPreviews({
      before: { ...previews.before, data: `data:image/webp;base64,${previews.before.data}` },
      after: previews.after
    })
    expect(asUrl).toEqual(checked)
  })

  test("the two committed files are the ones a reader's raw URL asks for", async () => {
    const checked = await checkedPreviews(await previewsOf(webpOf()))
    const files = previewFilesOf(checked)

    expect(Object.keys(files).sort()).toEqual(["preview-after.webp", "preview-before.webp"])
    expect(files[PREVIEW_FILES.before]).toEqual({ base64: checked.before.data })
    expect(await digestOfFile(files[PREVIEW_FILES.after]!)).toBe(checked.after.digest)
    expect(byteLengthOf(files[PREVIEW_FILES.before]!)).toBe(64)
  })

  test("a file digest and a file size read the bytes, not the text that carries them", async () => {
    const bytes = webpOf({ bytes: 100 })
    const file = { base64: base64Of(bytes) }

    expect(file.base64.length).toBeGreaterThan(100)
    expect(byteLengthOf(file)).toBe(100)
    expect(await digestOfFile(file)).toBe(await digestOfBytes(bytes))
    expect(byteLengthOf("héllo")).toBe(6)
    expect(await digestOfFile("héllo")).toBe(await digestOf("héllo"))
  })

  test("malformed base64 and malformed data URLs are refused", async () => {
    const good = webpOf()
    const cases = [
      ["!!!!", "preview_encoding_invalid"],
      ["AB==CD==", "preview_encoding_invalid"],
      ["QUJD=X", "preview_encoding_invalid"],
      ["", "preview_encoding_invalid"],
      [`data:image/webp,${base64Of(good)}`, "preview_encoding_invalid"],
      [`data:;base64,${base64Of(good)}`, "preview_encoding_invalid"],
      [`data:image/png;base64,${base64Of(good)}`, "preview_not_webp"]
    ] as const

    for (const [data, code] of cases) {
      const previews = await previewsOf(good)
      expect(await codeOf({ ...previews, before: { ...previews.before, data } })).toBe(code)
    }
  })

  test("bytes that are not a WebP image are refused whatever they claim to be", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Uint8Array(56)])
    expect(await codeOf(await previewsOf(png))).toBe("preview_not_webp")

    const truncated = webpOf().subarray(0, 10)
    expect(await codeOf(await previewsOf(truncated))).toBe("preview_not_webp")

    // A RIFF container that is not WebP at all, which is the closest a lie can get.
    const riffOnly = webpOf()
    riffOnly.set([0x41, 0x56, 0x49, 0x20], 8)
    expect(await codeOf(await previewsOf(riffOnly))).toBe("preview_not_webp")
  })

  test("an image that does not hash to the digest it claims is refused", async () => {
    const previews = await previewsOf(webpOf())
    const lying = { ...previews, after: { ...previews.after, digest: await digestOf("some other image") } }

    expect(await codeOf(lying)).toBe("preview_digest_mismatch")
  })

  test("an image over the size limit is refused before it is hashed", async () => {
    const huge = webpOf({ bytes: PREVIEW_LIMIT_BYTES + 4 })
    const previews = { before: await imageOf(webpOf()), after: await imageOf(huge) }

    expect(await codeOf(previews)).toBe("preview_too_large")
    expect(await codeOf({ before: previews.before, after: await imageOf(webpOf({ bytes: PREVIEW_LIMIT_BYTES })) })).toBe(
      "accepted"
    )
  })

  test("before and after must show the same viewport, in every variant that states one", async () => {
    const sizes = await previewsOf(webpOf({ width: 1280, height: 800 }), webpOf({ width: 1280, height: 900 }))
    expect(await codeOf(sizes)).toBe("preview_dimension_mismatch")

    for (const chunk of ["VP8X", "VP8 ", "VP8L"]) {
      const matched = await previewsOf(webpOf({ chunk }), webpOf({ chunk, width: 640 }))
      expect(await codeOf(matched)).toBe("preview_dimension_mismatch")
      expect(await codeOf(await previewsOf(webpOf({ chunk }), webpOf({ chunk })))).toBe("accepted")
    }

    // A variant this parser cannot read has no dimensions to disagree about, and a
    // release is not held up over a size no code here can know.
    const unknown = await previewsOf(webpOf({ chunk: "ANIM" }), webpOf({ width: 320, height: 200 }))
    expect(await codeOf(unknown)).toBe("accepted")
  })

  test("a refusal names the field and the reason, and never carries the image", async () => {
    const bytes = webpOf()
    const payload = base64Of(bytes)
    const previews = await previewsOf(bytes)

    const failures = [
      { ...previews, before: { ...previews.before, digest: await digestOf("elsewhere") } },
      { ...previews, before: { ...previews.before, data: `data:image/png;base64,${payload}` } },
      { ...previews, before: { ...previews.before, data: `${payload}!!` } }
    ]

    for (const broken of failures) {
      const error = await checkedPreviews(broken).catch((cause: unknown) => cause)
      expect(error).toBeInstanceOf(ReleaseContentError)
      if (!(error instanceof ReleaseContentError)) return
      expect(error.message).toContain("previews.before")
      expect(error.message).not.toContain(payload.slice(0, 24))
      expect(error.message).not.toContain("base64,")
      expect(error.message.length).toBeLessThan(160)
    }
  })
})

describe("canonical JSON", () => {
  test("orders object keys and keeps array order, so one content hashes one way", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}')
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }))
    expect(canonicalJson([3, 1, 2])).not.toBe(canonicalJson([1, 2, 3]))
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}')
  })
})
