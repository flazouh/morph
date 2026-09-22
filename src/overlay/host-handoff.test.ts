import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { InspectorAsk, InspectorAnswer } from "@/inspector/messages"
import type { ChangeRecord, SourceLocation } from "@/inspector/model"
import { handoffPrompt } from "@/inspector/handoff"
import type { HostToPanelInspectorMessage } from "./messages"
import {
  attestPanelSessions,
  hostOf,
  pageWith,
  sessionOf,
  shadowOf,
  withOpenShadow,
  type FakeAttestation
} from "./test-fixtures"
import {
  applyPanelAction,
  chatOf,
  installInspectorHotkey,
  sendInspectorHandoff,
  toggleChat,
  toggleInspector,
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

/**
 * A panel URL with no origin has no frame a hand-off could be addressed to safely, so
 * the card opens and stays usable and the hand-off says so, rather than throwing on the
 * way in or posting to a wildcard.
 */
test("a card whose panel URL has no origin refuses a hand-off instead of guessing one", async () => {
  toggleChat(document, "not a url", undefined, attestation.options)
  await new Promise((resolve) => setTimeout(resolve, 0))

  expect(chatOf(document).open).toBe(true)
  expect(await sendInspectorHandoff(document, "Make it blue.")).toEqual({
    ok: false,
    message: "Morph panel frame is not available."
  })
})

/** A fake Task 3 typed runtime contract: in-memory persistence, no chrome.* involved. */
const fakeInspectorPort = (initial: ChangeRecord | null = null, resolvedSource: SourceLocation | null = null) => {
  let record = initial
  const calls: Array<InspectorAsk> = []
  const send = async (ask: InspectorAsk): Promise<InspectorAnswer> => {
    calls.push(ask)
    switch (ask.type) {
      case "loadInspector":
        return { type: "inspectorLoaded", record }
      case "saveInspector":
        record = ask.record
        return { type: "inspectorSaved" }
      case "clearInspector":
        record = null
        return { type: "inspectorCleared" }
      case "resolveInspectorSource":
        return { type: "inspectorSourceResolved", source: resolvedSource }
    }
  }
  return { send, calls, recordOf: () => record }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const fire = (target: EventTarget, event: Event): void => {
  target.dispatchEvent(event)
}

/** A finished field edit: keystrokes, then the acceptance the browser fires on commit or blur. */
const typeInto = (input: HTMLInputElement, value: string): void => {
  input.value = value
  input.dispatchEvent(new Event("input", { bubbles: true }))
  input.dispatchEvent(new Event("change", { bubbles: true }))
}

const clickOn = (): MouseEvent => new MouseEvent("click", { bubbles: true, composed: true, cancelable: true })

describe("hotkey and card lifecycle", () => {
  test("Alt+Shift+I enters inspect mode with no chat open, and leaves it without a trace", async () => {
    pageWith(`<button id="btn" class="primary">Click</button>`)
    await withOpenShadow(async () => {
      const { send } = fakeInspectorPort()
      const uninstall = installInspectorHotkey(document, SRC, send, attestation.options)
      try {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "I", altKey: true, shiftKey: true, bubbles: true }))
        await flush()
        expect(shadowOf().querySelector(".mi-root")).not.toBeNull()

        document.dispatchEvent(new KeyboardEvent("keydown", { key: "I", altKey: true, shiftKey: true, bubbles: true }))
        await flush()
        // The card only existed for inspecting, so leaving removes it entirely.
        expect(chatOf(document).open).toBe(false)
      } finally {
        uninstall()
      }
    })
  })

  test("entering inspect mode while chat is open minimizes it, and exiting restores its geometry", async () => {
    pageWith(`<button id="btn">Click</button>`)
    await withOpenShadow(async () => {
      toggleChat(document, SRC, undefined, attestation.options)
      await flush()
      applyPanelAction(document, { type: "toggleExpandedChat" })
      expect(chatOf(document).mode).toBe("expanded")

      const { send } = fakeInspectorPort()
      await toggleInspector(document, SRC, send, attestation.options)
      expect(shadowOf().querySelector(".mi-root")).not.toBeNull()
      expect(chatOf(document).mode).toBe("minimized")

      await toggleInspector(document, SRC, send, attestation.options)
      expect(shadowOf().querySelector(".mi-root")).toBeNull()
      expect(chatOf(document).mode).toBe("expanded")
      expect(chatOf(document).open).toBe(true)
    })
  })

  test("entering inspect mode while chat is already minimized keeps it minimized on exit", async () => {
    pageWith(`<div id="card">Card</div>`)
    await withOpenShadow(async () => {
      toggleChat(document, SRC, undefined, attestation.options)
      await flush()
      applyPanelAction(document, { type: "minimizeChat" })
      expect(chatOf(document).mode).toBe("minimized")

      const { send } = fakeInspectorPort()
      await toggleInspector(document, SRC, send, attestation.options)
      expect(shadowOf().querySelector(".mi-root")).not.toBeNull()
      expect(chatOf(document).mode).toBe("minimized")

      await toggleInspector(document, SRC, send, attestation.options)
      expect(shadowOf().querySelector(".mi-root")).toBeNull()
      // Was minimized before inspecting started; exiting must not force it open.
      expect(chatOf(document).mode).toBe("minimized")
    })
  })

  test("removing the host while inspecting destroys the old controller instead of leaking its listeners", async () => {
    pageWith(`<div id="card">Card</div>`)
    await withOpenShadow(async () => {
      const { send, calls } = fakeInspectorPort()
      await toggleInspector(document, SRC, send, attestation.options)

      const oldHost = hostOf()
      oldHost.remove()
      await Promise.resolve()
      await flush()

      expect(hostOf()).not.toBe(oldHost)
      expect(shadowOf().querySelector(".mi-root")).toBeNull()

      const callsBeforeClick = calls.length
      fire(document.getElementById("card")!, clickOn())
      await flush()

      // Inspect mode was not carried over to the resurrected card, so a leaked old
      // controller is the only thing that could still answer this click.
      expect(calls.length).toBe(callsBeforeClick)
    })
  })

  test("installing the hotkey twice on the same document does not create a duplicate keydown listener", async () => {
    pageWith(`<div id="card">Card</div>`)
    await withOpenShadow(async () => {
      const { send } = fakeInspectorPort()
      const uninstallFirst = installInspectorHotkey(document, SRC, send, attestation.options)
      const uninstallSecond = installInspectorHotkey(document, SRC, send, attestation.options)
      try {
        document.dispatchEvent(
          new KeyboardEvent("keydown", { key: "I", altKey: true, shiftKey: true, bubbles: true })
        )
        await flush()

        // A single press must enter inspect mode once, not self-cancel from two
        // listeners both reacting to the same keydown in the same tick.
        expect(shadowOf().querySelector(".mi-root")).not.toBeNull()
      } finally {
        uninstallFirst()
        uninstallSecond()
      }
    })
  })
})

describe("sendInspectorHandoff", () => {
  test("posts only to the card iframe that owns this page session", async () => {
    await withOpenShadow(async () => {
      toggleChat(document, SRC, undefined, attestation.options)
      await flush()
      const posted: Array<{ message: unknown; targetOrigin: string }> = []
      const session = sessionOf(document)!
      const panelWindow = {
        postMessage: (message: unknown, targetOrigin: string) => posted.push({ message, targetOrigin })
      } as unknown as Window
      const iframe = hostOf().shadowRoot!.querySelector("iframe") as HTMLIFrameElement
      Object.defineProperty(iframe, "contentWindow", { configurable: true, value: panelWindow })

      const pending = sendInspectorHandoff(document, "Apply these visual changes in the source code.", { ackTimeoutMs: 50 })
      const message = posted[0]!.message as HostToPanelInspectorMessage
      expect(posted[0]?.targetOrigin).toBe(session.origin)
      expect(message).toMatchObject({ type: "inspectorHandoff", nonce: session.nonce, prompt: "Apply these visual changes in the source code." })

      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "inspectorHandoffAck", requestId: message.requestId },
          source: panelWindow
        })
      )
      expect(await pending).toEqual({ ok: true })
    })
  })

  test("fails when the panel frame is missing", async () => {
    await withOpenShadow(async () => {
      toggleChat(document, SRC, undefined, attestation.options)
      await flush()
      const iframe = hostOf().shadowRoot!.querySelector("iframe") as HTMLIFrameElement
      Object.defineProperty(iframe, "contentWindow", { configurable: true, value: null })

      expect(await sendInspectorHandoff(document, "No frame.")).toEqual({
        ok: false,
        message: "Morph panel frame is not available."
      })
    })
  })

  test("times out when no panel listener acknowledges", async () => {
    await withOpenShadow(async () => {
      toggleChat(document, SRC, undefined, attestation.options)
      await flush()
      const panelWindow = { postMessage: () => undefined } as unknown as Window
      const iframe = hostOf().shadowRoot!.querySelector("iframe") as HTMLIFrameElement
      Object.defineProperty(iframe, "contentWindow", { configurable: true, value: panelWindow })

      const result = await sendInspectorHandoff(document, "Waiting forever.", { ackTimeoutMs: 20 })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.message).toMatch(/may still appear in chat/i)
        expect(result.message).toMatch(/check morph/i)
      }
    })
  })

  test("reloadChat rejects a pending hand-off before replacing the iframe", async () => {
    await withOpenShadow(async () => {
      toggleChat(document, SRC, undefined, attestation.options)
      await flush()
      const panelWindow = { postMessage: () => undefined } as unknown as Window
      const iframe = hostOf().shadowRoot!.querySelector("iframe") as HTMLIFrameElement
      Object.defineProperty(iframe, "contentWindow", { configurable: true, value: panelWindow })

      const pending = sendInspectorHandoff(document, "In flight.", { ackTimeoutMs: 5_000 })
      applyPanelAction(document, { type: "reloadChat" })
      expect(await pending).toEqual({
        ok: false,
        message: "Morph panel reloaded before the hand-off was accepted."
      })
    })
  })

  test("MutationObserver reattach rejects a pending hand-off", async () => {
    await withOpenShadow(async () => {
      toggleChat(document, SRC, undefined, attestation.options)
      await flush()
      const panelWindow = { postMessage: () => undefined } as unknown as Window
      const iframe = hostOf().shadowRoot!.querySelector("iframe") as HTMLIFrameElement
      Object.defineProperty(iframe, "contentWindow", { configurable: true, value: panelWindow })

      const pending = sendInspectorHandoff(document, "In flight.", { ackTimeoutMs: 5_000 })
      hostOf().remove()
      await flush()
      expect(await pending).toEqual({
        ok: false,
        message: "Morph panel replaced before the hand-off was accepted."
      })
    })
  })
})

describe("copy prompt and send to Morph", () => {
  test("copy prompt writes handoff text from the button gesture and keeps changes applied", async () => {
    pageWith(`<div id="card" style="padding:8px;color:#111111;">Card</div>`)
    await withOpenShadow(async () => {
      const writes: string[] = []
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async (text: string) => { writes.push(text) } }
      })

      const { send, recordOf } = fakeInspectorPort()
      await toggleInspector(document, SRC, send, attestation.options)
      fire(document.getElementById("card")!, clickOn())
      await flush()

      const shadow = shadowOf()
      typeInto(shadow.querySelector<HTMLInputElement>("#mi-input-color")!, "#00dadb")
      await flush()

      shadow.querySelector<HTMLButtonElement>('[aria-label="Copy prompt"]')!.click()
      await flush()

      expect(writes).toHaveLength(1)
      expect(writes[0]).toBe(handoffPrompt(recordOf()!))
      expect(getComputedStyle(document.getElementById("card")!).color).not.toBe("rgb(17, 17, 17)")
      expect(shadow.querySelector<HTMLElement>(".mi-status")!.textContent).toMatch(/copied/i)
    })
  })

  test("copy prompt reports when clipboard is unavailable", async () => {
    pageWith(`<div id="card" style="color:#111111;">Card</div>`)
    await withOpenShadow(async () => {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: {} })

      const { send } = fakeInspectorPort()
      await toggleInspector(document, SRC, send, attestation.options)
      fire(document.getElementById("card")!, clickOn())
      await flush()

      const shadow = shadowOf()
      const color = shadow.querySelector<HTMLInputElement>("#mi-input-color")!
      color.value = "#00dadb"
      color.dispatchEvent(new Event("input", { bubbles: true }))
      await flush()

      shadow.querySelector<HTMLButtonElement>('[aria-label="Copy prompt"]')!.click()
      await flush()

      expect(shadow.querySelector<HTMLElement>(".mi-status")!.textContent).toMatch(/clipboard unavailable/i)
    })
  })

  test("copy prompt reports when clipboard rejects the write", async () => {
    pageWith(`<div id="card" style="color:#111111;">Card</div>`)
    await withOpenShadow(async () => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: () => Promise.reject(new Error("denied")) }
      })

      const { send } = fakeInspectorPort()
      await toggleInspector(document, SRC, send, attestation.options)
      fire(document.getElementById("card")!, clickOn())
      await flush()

      const shadow = shadowOf()
      shadow.querySelector<HTMLInputElement>("#mi-input-color")!.value = "#00dadb"
      shadow.querySelector<HTMLInputElement>("#mi-input-color")!.dispatchEvent(new Event("input", { bubbles: true }))
      await flush()

      shadow.querySelector<HTMLButtonElement>('[aria-label="Copy prompt"]')!.click()
      await flush()

      expect(shadow.querySelector<HTMLElement>(".mi-status")!.textContent).toMatch(/clipboard blocked/i)
    })
  })

  test("send to Morph succeeds only after the panel acknowledges", async () => {
    pageWith(`<div id="card" style="color:#111111;">Card</div>`)
    await withOpenShadow(async () => {
      const posted: unknown[] = []

      toggleChat(document, SRC, undefined, attestation.options)
      await flush()
      const panelWindow = {
        postMessage: (message: unknown) => posted.push(message)
      } as unknown as Window
      const iframe = hostOf().shadowRoot!.querySelector("iframe") as HTMLIFrameElement
      Object.defineProperty(iframe, "contentWindow", { configurable: true, value: panelWindow })

      const { send, recordOf } = fakeInspectorPort()
      await toggleInspector(document, SRC, send, attestation.options)
      fire(document.getElementById("card")!, clickOn())
      await flush()

      const shadow = shadowOf()
      typeInto(shadow.querySelector<HTMLInputElement>("#mi-input-color")!, "#00dadb")
      await flush()

      shadow.querySelector<HTMLButtonElement>('[aria-label="Send to Morph"]')!.click()
      await flush()
      expect(shadow.querySelector<HTMLElement>(".mi-status")!.textContent).toBe("")

      const message = posted[0] as HostToPanelInspectorMessage
      expect(message.prompt).toBe(handoffPrompt(recordOf()!))

      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "inspectorHandoffAck", requestId: message.requestId },
          source: panelWindow
        })
      )
      await flush()

      expect(shadow.querySelector<HTMLElement>(".mi-status")!.textContent).toMatch(/sent/i)
    })
  })

  test("two fast Send clicks start only one handoff", async () => {
    pageWith(`<div id="card" style="color:#111111;">Card</div>`)
    await withOpenShadow(async () => {
      const posted: unknown[] = []
      toggleChat(document, SRC, undefined, attestation.options)
      await flush()
      const panelWindow = { postMessage: (message: unknown) => posted.push(message) } as unknown as Window
      const iframe = hostOf().shadowRoot!.querySelector("iframe") as HTMLIFrameElement
      Object.defineProperty(iframe, "contentWindow", { configurable: true, value: panelWindow })

      const { send } = fakeInspectorPort()
      await toggleInspector(document, SRC, send, attestation.options)
      fire(document.getElementById("card")!, clickOn())
      await flush()

      const shadow = shadowOf()
      shadow.querySelector<HTMLInputElement>("#mi-input-color")!.value = "#00dadb"
      shadow.querySelector<HTMLInputElement>("#mi-input-color")!.dispatchEvent(new Event("input", { bubbles: true }))
      await flush()

      const sendButton = shadow.querySelector<HTMLButtonElement>('[aria-label="Send to Morph"]')!
      sendButton.click()
      sendButton.click()
      await flush()

      expect(posted).toHaveLength(1)
    })
  })

  test("handoff status clears when the record changes or is discarded", async () => {
    pageWith(`<div id="card" style="color:#111111;">Card</div>`)
    await withOpenShadow(async () => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async () => undefined }
      })

      const { send } = fakeInspectorPort()
      await toggleInspector(document, SRC, send, attestation.options)
      fire(document.getElementById("card")!, clickOn())
      await flush()

      const shadow = shadowOf()
      const color = shadow.querySelector<HTMLInputElement>("#mi-input-color")!
      color.value = "#00dadb"
      color.dispatchEvent(new Event("input", { bubbles: true }))
      await flush()
      shadow.querySelector<HTMLButtonElement>('[aria-label="Copy prompt"]')!.click()
      await flush()
      expect(shadow.querySelector<HTMLElement>(".mi-status")!.textContent).toMatch(/copied/i)

      color.value = "#ffffff"
      color.dispatchEvent(new Event("input", { bubbles: true }))
      await flush()
      expect(shadow.querySelector<HTMLElement>(".mi-status")!.textContent).toBe("")

      shadow.querySelector<HTMLButtonElement>('[aria-label="Copy prompt"]')!.click()
      await flush()
      expect(shadow.querySelector<HTMLElement>(".mi-status")!.textContent).toMatch(/copied/i)
      shadow.querySelector<HTMLButtonElement>('[aria-label="Discard all changes"]')!.click()
      await flush()
      expect(shadow.querySelector<HTMLElement>(".mi-status")!.textContent).toBe("")
    })
  })
})

test("full flow: enter, pick, change, recreate host, copy, send, discard, and restore original style", async () => {
  pageWith(`<div id="card" style="padding:8px;color:#111111;">Card</div>`)
  await withOpenShadow(async () => {
    const writes: string[] = []
    const posted: unknown[] = []
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => { writes.push(text) } }
    })

    let record: ChangeRecord | null = null
    const send = async (ask: InspectorAsk): Promise<InspectorAnswer> => {
      switch (ask.type) {
        case "loadInspector":
          return { type: "inspectorLoaded", record }
        case "saveInspector":
          record = ask.record
          return { type: "inspectorSaved" }
        case "clearInspector":
          record = null
          return { type: "inspectorCleared" }
        case "resolveInspectorSource":
          return { type: "inspectorSourceResolved", source: null }
      }
    }

    toggleChat(document, SRC, undefined, attestation.options)
    await flush()
    await toggleInspector(document, SRC, send, attestation.options)
    const card = document.getElementById("card")!
    const originalColor = getComputedStyle(card).color
    fire(card, clickOn())
    await flush()

    const shadow = shadowOf()
    typeInto(shadow.querySelector<HTMLInputElement>("#mi-input-color")!, "rgb(0, 218, 219)")
    await flush()
    expect(getComputedStyle(card).color).not.toBe(originalColor)
    expect(record).not.toBeNull()

    const saved = structuredClone(record)
    await toggleInspector(document, SRC, send, attestation.options)
    expect(shadowOf().querySelector(".mi-root")).toBeNull()

    unmountChat(document)
    toggleChat(document, SRC, undefined, attestation.options)
    await flush()

    const panelWindow = { postMessage: (message: unknown) => posted.push(message) } as unknown as Window
    const iframe = hostOf().shadowRoot!.querySelector("iframe") as HTMLIFrameElement
    Object.defineProperty(iframe, "contentWindow", { configurable: true, value: panelWindow })

    await toggleInspector(document, SRC, send, attestation.options)
    await flush()
    expect(record).toEqual(saved)
    expect(getComputedStyle(card).color).not.toBe(originalColor)

    const reloaded = shadowOf()
    reloaded.querySelector<HTMLButtonElement>('[aria-label="Copy prompt"]')!.click()
    await flush()
    reloaded.querySelector<HTMLButtonElement>('[aria-label="Send to Morph"]')!.click()
    await flush()

    expect(writes).toHaveLength(1)
    expect(posted).toHaveLength(1)
    expect(writes[0]).toBe((posted[0] as HostToPanelInspectorMessage).prompt)

    const message = posted[0] as HostToPanelInspectorMessage
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "inspectorHandoffAck", requestId: message.requestId },
        source: panelWindow
      })
    )
    await flush()

    reloaded.querySelector<HTMLButtonElement>('[aria-label="Discard all changes"]')!.click()
    await flush()

    expect(getComputedStyle(card).color).toBe(originalColor)
    expect(record).toBeNull()
  })
})
