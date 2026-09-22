import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import type { InspectorAsk, InspectorAnswer } from "@/inspector/messages"
import type { ChangeRecord } from "@/inspector/model"
import type { HostToPanelInspectorMessage } from "@/overlay/messages"
import {
  installInspectorHotkey,
  sendInspectorHandoff,
  toggleChat,
  toggleInspector,
  unmountChat
} from "./overlay/host"
import { attestPanelSessions, flush, sessionOf, type FakeAttestation } from "./overlay/test-fixtures"

const SRC = "about:blank"

// A card only loads its panel frame once the worker holds its nonce, and no page
// document here has a real `chrome.runtime` to ask. Every entry point takes the port.
let attestation: FakeAttestation

beforeEach(() => {
  attestation = attestPanelSessions()
})

const restoreDocument = (): void => {
  unmountChat(document)
  document.documentElement.replaceChildren()
  document.documentElement.append(document.createElement("head"))
  document.documentElement.append(document.createElement("body"))
}

afterEach(restoreDocument)

const pageWith = (html: string): void => {
  if (document.head === null) document.documentElement.append(document.createElement("head"))
  if (document.body === null) document.documentElement.append(document.createElement("body"))
  document.body.innerHTML = html
}

const fakeInspectorPort = (initial: ChangeRecord | null = null) => {
  let record = initial
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
  return { send, recordOf: () => record }
}

const withOpenShadow = async (fn: () => Promise<void> | void): Promise<void> => {
  const original = Element.prototype.attachShadow
  Element.prototype.attachShadow = function (init) {
    return original.call(this, { ...init, mode: "open" })
  }
  try {
    await fn()
  } finally {
    Element.prototype.attachShadow = original
  }
}

describe("inspector handoff routing in the page document", () => {
  test("the host sends a handoff only to its own iframe window with the frame origin", async () => {
    pageWith(`<div id="one">One</div>`)
    await withOpenShadow(async () => {
      toggleChat(document, SRC, undefined, attestation.options)
      await flush()
      const posted: Array<{ message: unknown; targetOrigin: string }> = []
      const session = sessionOf(document)!
      const panelWindow = {
        postMessage: (message: unknown, targetOrigin: string) => posted.push({ message, targetOrigin })
      } as unknown as Window

      const host = Array.from(document.documentElement.children).find((el) => el.shadowRoot !== null)!
      const iframe = host.shadowRoot!.querySelector("iframe") as HTMLIFrameElement
      Object.defineProperty(iframe, "contentWindow", { configurable: true, value: panelWindow })

      const pending = sendInspectorHandoff(document, "Prompt for the owning frame only.", { ackTimeoutMs: 50 })
      expect(posted).toHaveLength(1)
      expect(posted[0]?.targetOrigin).toBe(session.origin)
      expect(posted[0]?.message).toMatchObject({
        type: "inspectorHandoff",
        nonce: session.nonce,
        prompt: "Prompt for the owning frame only."
      })

      const message = posted[0]!.message as HostToPanelInspectorMessage
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "inspectorHandoffAck", requestId: message.requestId },
          source: panelWindow
        })
      )
      expect(await pending).toEqual({ ok: true })
    })
  })

  test("send to Morph does not broadcast through chrome.runtime.sendMessage", async () => {
    pageWith(`<div id="card">Card</div>`)
    await withOpenShadow(async () => {
      const runtimeCalls: unknown[] = []
      const runtime = {
        sendMessage: mock((message: unknown) => {
          runtimeCalls.push(message)
          return Promise.resolve()
        })
      }
      Object.defineProperty(globalThis, "chrome", {
        configurable: true,
        value: { runtime }
      })

      toggleChat(document, SRC, undefined, attestation.options)
      await flush()
      const { send } = fakeInspectorPort()
      await toggleInspector(document, SRC, send, attestation.options)
      const card = document.getElementById("card")!
      card.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, cancelable: true }))
      await new Promise((resolve) => setTimeout(resolve, 0))

      const shadow = Array.from(document.documentElement.children).find((el) => el.shadowRoot !== null)!.shadowRoot!
      const color = shadow.querySelector<HTMLInputElement>("#mi-input-color")!
      color.value = "#00dadb"
      color.dispatchEvent(new Event("input", { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 0))

      const posted: unknown[] = []
      const panelWindow = {
        postMessage: (message: unknown) => posted.push(message)
      } as unknown as Window
      const iframe = shadow.querySelector("iframe") as HTMLIFrameElement
      Object.defineProperty(iframe, "contentWindow", { configurable: true, value: panelWindow })

      shadow.querySelector<HTMLButtonElement>('[aria-label="Send to Morph"]')!.click()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(runtimeCalls).toEqual([])
      expect(posted.length).toBe(1)

      const message = posted[0] as HostToPanelInspectorMessage
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "inspectorHandoffAck", requestId: message.requestId },
          source: panelWindow
        })
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  })

  test("a panel toggleInspector message enters inspect mode on the same document card", async () => {
    pageWith(`<div id="card">Card</div>`)
    const original = Element.prototype.attachShadow
    Element.prototype.attachShadow = function (init) {
      return original.call(this, { ...init, mode: "open" })
    }
    try {
      toggleChat(document, SRC, undefined, attestation.options)
      await flush()
      const { send } = fakeInspectorPort()
      installInspectorHotkey(document, SRC, send, attestation.options)

      const host = Array.from(document.documentElement.children).find((el) => el.shadowRoot !== null)!
      const iframe = host.shadowRoot!.querySelector("iframe") as HTMLIFrameElement
      const panelWindow = { postMessage: () => undefined } as unknown as Window
      Object.defineProperty(iframe, "contentWindow", { configurable: true, value: panelWindow })

      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "toggleInspector" },
          source: panelWindow
        })
      )
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(host.shadowRoot!.querySelector(".mi-root")).not.toBeNull()
    } finally {
      Element.prototype.attachShadow = original
    }
  })
})
