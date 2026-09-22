/**
 * Geist on the page. The kit's `--font-sans` names Geist Variable, and the panel bundles
 * it; a host page has no Geist, and the extension's CSP forbids a remote fetch. So the
 * kit adds the faces from the extension's own files, which the manifest makes reachable
 * from any page (web_accessible_resources). Added to `document.fonts`, a face serves the
 * shadow roots too: fonts are the document's, not the tree's.
 */

const LATIN = "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD"
const LATIN_EXT =
  "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF"

/** The faces, by family: the file under the extension's `fonts/`, and the range it covers. */
export const FONT_FACES: ReadonlyArray<{ readonly family: string; readonly file: string; readonly unicodeRange: string }> = [
  { family: "Geist Variable", file: "geist-latin-wght-normal.woff2", unicodeRange: LATIN },
  { family: "Geist Variable", file: "geist-latin-ext-wght-normal.woff2", unicodeRange: LATIN_EXT },
  { family: "Geist Mono Variable", file: "geist-mono-latin-wght-normal.woff2", unicodeRange: LATIN }
]

/** Adds the faces to the document, from `base` (the extension's `fonts/` URL, with its trailing slash). */
export const loadFonts = (doc: Pick<Document, "fonts">, base: string): void => {
  if (typeof FontFace === "undefined") return
  for (const face of FONT_FACES) {
    doc.fonts.add(new FontFace(face.family, `url(${base}${face.file})`, { weight: "100 900", unicodeRange: face.unicodeRange, display: "swap" }))
  }
}
