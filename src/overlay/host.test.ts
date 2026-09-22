import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { fakeBrowser } from "@webext-core/fake-browser"
import { isPanelSessionAsk } from "./panel-attest"
import { accepting, answer, forgetAnswers } from "../bridge/messaging"
import { readPanelNonce } from "./panel-session"
import { attestPanelSessions, flush, hostOf, shadowOf, withOpenShadow, type FakeAttestation } from "./test-fixtures"
import {
  applyPanelAction,
  chatOf,
  restoreChat,
  setChatHidden,
  toggleChat,
  unmountChat
} from "./host"

const SRC = "about:blank"

// A card only loads its panel frame once the worker holds its nonce, and no page
// document here has a real `chrome.runtime` to ask. Every entry point takes the port.
let attestation: FakeAttestation

beforeEach(() => {
  attestation = attestPanelSessions()
})

afterEach(() => {
  unmountChat(document)
  document.documentElement.replaceChildren()
})

describe("the chat card on the page", () => {
  test("a toggle opens a card that loads the panel, and a second toggle takes it off", () => {
    let closed = 0
    expect(chatOf(document)).toEqual({ open: false, hidden: false, mode: "normal", src: null })
    expect(toggleChat(document, SRC, () => {
      closed += 1
    }, attestation.options)).toBe("open")
    const open = chatOf(document)
    expect(open.open).toBe(true)
    expect(open.hidden).toBe(false)
    expect(open.mode).toBe("normal")
    expect(open.src).toContain("morph-nonce=")
    const host = document.documentElement.lastElementChild as HTMLElement
    expect(getComputedStyle(host).display).toBe("block")
    expect(getComputedStyle(host).position).toBe("fixed")
    expect(toggleChat(document, SRC, undefined, attestation.options)).toBe("closed")
    expect(chatOf(document).open).toBe(false)
    expect(closed).toBe(1)
  })

  test("green moves a larger card to the middle, then restores its corner size", () => {
    toggleChat(document, SRC, undefined, attestation.options)
    applyPanelAction(document, { type: "toggleExpandedChat" })
    expect(chatOf(document).mode).toBe("expanded")
    const host = document.documentElement.lastElementChild as HTMLElement
    expect(host.style.left).toBe("50%")
    expect(host.style.top).toBe("50%")
    expect(host.style.width).toBe("760px")
    expect(host.style.maxWidth).toContain("100vw")
    expect(host.style.height).toBe("820px")
    expect(host.style.maxHeight).toBe("84vh")

    applyPanelAction(document, { type: "toggleExpandedChat" })
    expect(chatOf(document).mode).toBe("normal")
    expect(host.style.right).toBe("24px")
    expect(host.style.bottom).toBe("24px")
    expect(host.style.width).toBe("380px")
  })

  test("settings widens the normal card in place, then returns it", () => {
    toggleChat(document, SRC, undefined, attestation.options)
    const host = document.documentElement.lastElementChild as HTMLElement
    expect(host.style.width).toBe("380px")

    applyPanelAction(document, { type: "setChatWide", wide: true })
    expect(host.style.width).toBe("600px")
    expect(host.style.transition).toBe("none")
    // The corner anchor stays; only the width grows.
    expect(host.style.right).toBe("24px")
    expect(host.style.bottom).toBe("24px")

    applyPanelAction(document, { type: "setChatWide", wide: false })
    expect(host.style.width).toBe("380px")
    expect(host.style.transition).toContain("width 260ms")
  })

  test("the grab icon uses its button cursor", async () => {
    await withOpenShadow(() => {
      toggleChat(document, SRC, undefined, attestation.options)
      const host = document.documentElement.lastElementChild as HTMLElement
      const grab = host.shadowRoot?.querySelector<HTMLButtonElement>('[aria-label="Move Morph"]')
      const icon = grab?.querySelector<SVGSVGElement>("svg")
      expect(grab?.style.cursor).toBe("grab")
      expect(icon?.style.cursor).toBe("inherit")
      expect(icon?.style.pointerEvents).toBe("none")

      grab?.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true }))
      expect(grab?.style.cursor).toBe("grabbing")

      window.dispatchEvent(new PointerEvent("pointerup"))
      expect(grab?.style.cursor).toBe("grab")
    })
  })

  test("a wide settings card keeps the expanded width when expanded", () => {
    toggleChat(document, SRC, undefined, attestation.options)
    applyPanelAction(document, { type: "setChatWide", wide: true })
    applyPanelAction(document, { type: "toggleExpandedChat" })
    const host = document.documentElement.lastElementChild as HTMLElement
    expect(host.style.width).toBe("760px")

    applyPanelAction(document, { type: "toggleExpandedChat" })
    expect(host.style.width).toBe("600px")
  })

  test("yellow minimizes to a reopen widget that restores the prior size", () => {
    toggleChat(document, SRC, undefined, attestation.options)
    applyPanelAction(document, { type: "toggleExpandedChat" })
    applyPanelAction(document, { type: "minimizeChat" })
    expect(chatOf(document).mode).toBe("minimized")
    const host = document.documentElement.lastElementChild as HTMLElement
    expect(host.style.width).toBe("112px")
    expect(host.style.height).toBe("44px")
    expect(host.style.overflow).toBe("visible")

    restoreChat(document)
    expect(chatOf(document).mode).toBe("expanded")
    expect(host.style.left).toBe("50%")
  })

  test("red closes the card", () => {
    let closed = 0
    toggleChat(document, SRC, () => {
      closed += 1
    }, attestation.options)
    applyPanelAction(document, { type: "closeChat" })
    expect(chatOf(document)).toEqual({ open: false, hidden: false, mode: "normal", src: null })
    expect(closed).toBe(1)
  })

  test("an invalidated panel can replace its extension frame without losing its layout", () => {
    toggleChat(document, SRC, undefined, attestation.options)
    applyPanelAction(document, { type: "toggleExpandedChat" })
    const oldHost = document.documentElement.lastElementChild

    applyPanelAction(document, { type: "reloadChat" })

    expect(document.documentElement.lastElementChild).not.toBe(oldHost)
    expect(chatOf(document)).toMatchObject({ open: true, hidden: false, mode: "expanded" })
  })

  test("hide keeps the card mounted and takes it off the picture; show brings it back", () => {
    toggleChat(document, SRC, undefined, attestation.options)
    setChatHidden(document, true)
    expect(chatOf(document)).toMatchObject({ open: true, hidden: true })
    setChatHidden(document, false)
    expect(chatOf(document)).toMatchObject({ open: true, hidden: false })
  })

  test("hide on a page with no card does nothing", () => {
    setChatHidden(document, true)
    expect(chatOf(document).open).toBe(false)
  })

  test("dragging the card in wide-settings mode keeps the wide width during the move, not only at stop", async () => {
    // M6 regression: before the fix, move called applyRect with the raw narrow
    // placement so the card snapped wider only when the pointer was released and
    // drawMode ran the wide-mode block.
    await withOpenShadow(() => {
      toggleChat(document, SRC, undefined, attestation.options)
      applyPanelAction(document, { type: "setChatWide", wide: true })

      const host = document.documentElement.lastElementChild as HTMLElement
      const shadow = host.shadowRoot!
      const grab = shadow.querySelector<HTMLButtonElement>('[aria-label="Move Morph"]')!
      const shield = shadow.querySelector<HTMLElement>("[data-morph-resize-shield]")!

      // Start the drag.
      grab.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true, clientX: 500, clientY: 500 }))
      expect(shield.style.display).toBe("block") // shield is live

      // Move the pointer — the card must already show the wide width.
      shield.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 400, clientY: 450 }))
      expect(host.style.width).toBe("600px") // <-- fails before fix

      // Stop the drag — must still be 600 px.
      window.dispatchEvent(new PointerEvent("pointerup"))
      expect(host.style.width).toBe("600px")
    })
  })

  test("the page can remove the host; the card comes back while it is still wanted", async () => {
    toggleChat(document, SRC, undefined, attestation.options)
    const host = document.documentElement.lastElementChild
    expect(host).not.toBeNull()
    host?.remove()
    await Promise.resolve()
    expect(chatOf(document).open).toBe(true)
    expect(chatOf(document).src).toContain("morph-nonce=")
  })

  test("toggleChat mounts when crypto.randomUUID is unavailable", async () => {
    const original = crypto.randomUUID
    Object.defineProperty(crypto, "randomUUID", {
      configurable: true,
      value: () => {
        throw new DOMException("randomUUID is not available in this context")
      }
    })
    try {
      await withOpenShadow(async () => {
        toggleChat(document, SRC, undefined, attestation.options)
        await flush()
        expect(chatOf(document).open).toBe(true)
        const iframe = hostOf().shadowRoot!.querySelector("iframe") as HTMLIFrameElement
        expect(readPanelNonce(new URL(iframe.src))).toMatch(/^[0-9a-f]{32}$/)
      })
    } finally {
      Object.defineProperty(crypto, "randomUUID", { configurable: true, value: original })
    }
  })
})

/**
 * A page can frame `panel.html` itself, so the nonce in the frame URL proves nothing on
 * its own. The worker holds the proof, and it must hold it before the frame can load.
 */
describe("panel session attestation", () => {
  const frameOf = (): HTMLIFrameElement => shadowOf().querySelector("iframe") as HTMLIFrameElement
  const noticeOf = (): HTMLElement => shadowOf().querySelector<HTMLElement>("[data-morph-panel-notice]")!

  test("the frame stays unloaded until the worker holds this card's nonce", async () => {
    await withOpenShadow(async () => {
      attestation.defer()
      toggleChat(document, SRC, undefined, attestation.options)
      await flush()

      // Registration is still in flight: nothing has navigated to a live panel.
      expect(frameOf().src).toBe("")
      expect(attestation.registered).toEqual([])

      attestation.settle()
      await flush()

      const loaded = frameOf().src
      expect(loaded).toContain("morph-nonce=")
      expect(attestation.registered).toEqual([readPanelNonce(new URL(loaded))!])
    })
  })

  test("a hand-off before the panel session opens fails with a recoverable message", async () => {
    const { sendInspectorHandoff } = await import("./host")
    await withOpenShadow(async () => {
      attestation.defer()
      toggleChat(document, SRC, undefined, attestation.options)
      await flush()

      const result = await sendInspectorHandoff(document, "Too early.")
      expect(result).toEqual({
        ok: false,
        message: "Morph is still opening its panel. Try again in a moment."
      })

      attestation.settle()
      await flush()
    })
  })

  test("a failed registration leaves a recoverable card and never loads the panel", async () => {
    await withOpenShadow(async () => {
      attestation.fail()
      toggleChat(document, SRC, undefined, attestation.options)
      await flush()

      expect(frameOf().src).toBe("")
      const notice = noticeOf()
      expect(notice.style.display).toBe("flex")
      expect(notice.textContent).toContain("Morph could not open a secure panel session")
      // The card itself is still there, so the reader keeps its place and can retry.
      expect(chatOf(document).open).toBe(true)

      attestation.settle()
      notice.querySelector<HTMLButtonElement>("button")!.click()
      await flush()

      expect(frameOf().src).toContain("morph-nonce=")
      expect(noticeOf().style.display).toBe("none")
    })
  })

  test("unmounting the card gives its nonce back to the worker", async () => {
    await withOpenShadow(async () => {
      toggleChat(document, SRC, undefined, attestation.options)
      await flush()
      const nonce = readPanelNonce(new URL(frameOf().src))!

      unmountChat(document)
      await flush()

      expect(attestation.revoked).toEqual([nonce])
    })
  })

  test("a card replaced in place re-registers its nonce and never revokes the live one", async () => {
    await withOpenShadow(async () => {
      toggleChat(document, SRC, undefined, attestation.options)
      await flush()
      const nonce = readPanelNonce(new URL(frameOf().src))!

      applyPanelAction(document, { type: "reloadChat" })
      await flush()

      // The replacement registers again, which replaces the tab's entry in one write.
      expect(attestation.registered).toEqual([nonce, nonce])
      // A revoke here would end the session the replacement just opened.
      expect(attestation.revoked).toEqual([])
      expect(frameOf().src).toContain(`morph-nonce=${nonce}`)
    })
  })

  test("a host the page strips is rebuilt with an attested frame", async () => {
    await withOpenShadow(async () => {
      toggleChat(document, SRC, undefined, attestation.options)
      await flush()
      const nonce = readPanelNonce(new URL(frameOf().src))!

      hostOf().remove()
      await flush()

      expect(attestation.revoked).toEqual([])
      expect(frameOf().src).toContain(`morph-nonce=${nonce}`)
    })
  })

  /**
   * The extension passes no port: a card left to itself must still ask the worker, and
   * not decide on its own that it may load a panel.
   */
  test("a caller that passes no port registers through the extension runtime", async () => {
    const asks: Array<unknown> = []
    // Another suite in this run may already own a read-only `chrome`, so put this one
    // in by descriptor and give the original back.
    const original = Object.getOwnPropertyDescriptor(globalThis, "chrome")
    fakeBrowser.reset()
    Object.defineProperty(globalThis, "chrome", { configurable: true, value: fakeBrowser })
    // The worker's side of the protocol, in this same context: the fake runtime routes to it.
    answer("panelSession", accepting(isPanelSessionAsk), (data) => {
      asks.push(data)
      return { type: "panelSessionRegistered" }
    })
    try {
      await withOpenShadow(async () => {
        toggleChat(document, SRC)
        await flush()

        const nonce = readPanelNonce(new URL(frameOf().src))!
        expect(asks).toEqual([{ type: "registerPanelSession", nonce }])

        unmountChat(document)
        await flush()
        expect(asks).toContainEqual({ type: "revokePanelSession", nonce })
      })
    } finally {
      forgetAnswers()
      if (original === undefined) delete (globalThis as { chrome?: unknown }).chrome
      else Object.defineProperty(globalThis, "chrome", original)
    }
  })
})
