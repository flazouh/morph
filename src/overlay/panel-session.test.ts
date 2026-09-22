import { afterEach, describe, expect, test } from "bun:test"
import { frameOrigin, mintPanelNonce, panelSrcWithNonce, readPanelNonce } from "./panel-session"

const originalRandomUUID = crypto.randomUUID

afterEach(() => {
  Object.defineProperty(crypto, "randomUUID", { configurable: true, value: originalRandomUUID })
})

describe("panel session nonce", () => {
  test("mintPanelNonce returns unique 128-bit tokens", () => {
    const a = mintPanelNonce()
    const b = mintPanelNonce()
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[0-9a-f]{32}$/)
  })

  test("mintPanelNonce works when crypto.randomUUID is unavailable", () => {
    Object.defineProperty(crypto, "randomUUID", {
      configurable: true,
      value: () => {
        throw new DOMException("randomUUID is not available in this context")
      }
    })
    expect(mintPanelNonce()).toMatch(/^[0-9a-f]{32}$/)
  })

  test("panelSrcWithNonce replaces an existing hash", () => {
    expect(panelSrcWithNonce("chrome-extension://id/panel.html#old", "secret")).toBe(
      "chrome-extension://id/panel.html#morph-nonce=secret"
    )
  })

  test("readPanelNonce reads the hash the host wrote", () => {
    const nonce = "abc-123"
    expect(readPanelNonce({ hash: new URL(panelSrcWithNonce("about:blank", nonce)).hash })).toBe(nonce)
  })

  test("frameOrigin is the extension frame origin", () => {
    expect(frameOrigin("chrome-extension://abc/panel.html#morph-nonce=x")).toBe("chrome-extension://abc")
  })

  /**
   * `URL.origin` is the opaque string "null" for every non-special scheme, so reading it
   * would make two different extensions, and two different files, compare equal.
   */
  test("frameOrigin tells two extensions apart where URL.origin cannot", () => {
    expect(new URL("chrome-extension://abc/panel.html").origin).toBe(
      new URL("chrome-extension://xyz/panel.html").origin
    )
    expect(frameOrigin("chrome-extension://abc/panel.html")).not.toBe(
      frameOrigin("chrome-extension://xyz/panel.html")
    )
    expect(frameOrigin("file:///tmp/a.html")).toBe("file://")
  })

  test("frameOrigin keeps the port and drops everything after the host", () => {
    expect(frameOrigin("https://app.test:8443/a/b?q=1#h")).toBe("https://app.test:8443")
    expect(frameOrigin("https://app.test/a")).toBe("https://app.test")
  })

  test("frameOrigin has no answer for a URL that does not parse", () => {
    expect(frameOrigin("not a url")).toBe(null)
    expect(frameOrigin("")).toBe(null)
  })
})
