import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { InspectorSend } from "@/inspector/controller"
import { applyOverlay, chatOf, installInspectorHotkey, unmountChat } from "./host"
import { attestPanelSessions, withOpenShadow, type FakeAttestation } from "./test-fixtures"
import {
  isCrewAsk,
  isHostToPanelInspectorMessage,
  isOverlayAsk,
  isOverlaySignal,
  isPanelAction,
  isPanelToHostInspectorAck,
  isPanelToHostInspectorMessage
} from "./messages"

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

describe("overlay messages", () => {
  test("only card commands are overlay asks", () => {
    expect(isOverlayAsk({ type: "toggleChat" })).toBe(true)
    expect(isOverlayAsk({ type: "openChat" })).toBe(true)
    expect(isOverlayAsk({ type: "closeChat" })).toBe(true)
    expect(isOverlayAsk({ type: "hideChat" })).toBe(true)
    expect(isOverlayAsk({ type: "showChat" })).toBe(true)
    expect(isOverlayAsk({ type: "toggleInspector" })).toBe(true)
    expect(isOverlayAsk({ type: "readPage" })).toBe(false)
    expect(isOverlayAsk(null)).toBe(false)
  })

  test("only document lifecycle events are overlay signals", () => {
    expect(isOverlaySignal({ type: "chatReady" })).toBe(true)
    expect(isOverlaySignal({ type: "chatClosed" })).toBe(true)
    expect(isOverlaySignal({ type: "openChat" })).toBe(false)
    expect(isOverlaySignal(null)).toBe(false)
  })

  test("crew bot commands validate their payload", () => {
    expect(isCrewAsk({ type: "setCrewBots", bots: [] })).toBe(true)
    expect(isCrewAsk({ type: "hideCrewBots" })).toBe(true)
    expect(isCrewAsk({ type: "showCrewBots" })).toBe(true)
    expect(isCrewAsk({ type: "clearCrewBots" })).toBe(true)
    expect(isCrewAsk({ type: "setCrewBots" })).toBe(false)
    expect(isCrewAsk({ type: "setCrewBots", bots: "many" })).toBe(false)
  })

  test("panel-to-host inspector messages validate separately from host-to-panel delivery", () => {
    expect(isPanelToHostInspectorMessage({ type: "toggleInspector" })).toBe(true)
    expect(isPanelToHostInspectorMessage({ type: "inspectorHandoff", prompt: "nope" })).toBe(false)

    expect(
      isHostToPanelInspectorMessage({
        type: "inspectorHandoff",
        requestId: "r1",
        nonce: "n1",
        prompt: "Apply these changes."
      })
    ).toBe(true)
    expect(isHostToPanelInspectorMessage({ type: "inspectorHandoff", prompt: 1 })).toBe(false)
    expect(isHostToPanelInspectorMessage({ type: "toggleInspector" })).toBe(false)

    expect(isPanelToHostInspectorAck({ type: "inspectorHandoffAck", requestId: "r1" })).toBe(true)
    expect(isPanelToHostInspectorAck({ type: "inspectorHandoffAck" })).toBe(false)
  })

  test("only chat window controls are panel actions", () => {
    expect(isPanelAction({ type: "closeChat" })).toBe(true)
    expect(isPanelAction({ type: "minimizeChat" })).toBe(true)
    expect(isPanelAction({ type: "toggleExpandedChat" })).toBe(true)
    expect(isPanelAction({ type: "setChatWide", wide: true })).toBe(true)
    expect(isPanelAction({ type: "setChatWide", wide: false })).toBe(true)
    expect(isPanelAction({ type: "setChatHeaderHovered", hovered: true })).toBe(true)
    expect(isPanelAction({ type: "setChatHeaderHovered", hovered: false })).toBe(true)
    expect(isPanelAction({ type: "setChatWide" })).toBe(false)
    expect(isPanelAction({ type: "setChatWide", wide: "yes" })).toBe(false)
    expect(isPanelAction({ type: "setChatHeaderHovered" })).toBe(false)
    expect(isPanelAction({ type: "showChat" })).toBe(false)
    expect(isPanelAction(null)).toBe(false)
  })

  test("toggle opens; hide takes the card off the picture; show brings it back", () => {
    applyOverlay({ type: "toggleChat" }, document, SRC, undefined, attestation.options)
    expect(chatOf(document).open).toBe(true)
    applyOverlay({ type: "hideChat" }, document, SRC, undefined, attestation.options)
    expect(chatOf(document)).toMatchObject({ open: true, hidden: true })
    applyOverlay({ type: "showChat" }, document, SRC, undefined, attestation.options)
    expect(chatOf(document)).toMatchObject({ open: true, hidden: false })
  })

  test("open and close set the card state without toggling it by accident", () => {
    applyOverlay({ type: "openChat" }, document, SRC, undefined, attestation.options)
    applyOverlay({ type: "openChat" }, document, SRC, undefined, attestation.options)
    expect(chatOf(document).open).toBe(true)

    applyOverlay({ type: "closeChat" }, document, SRC, undefined, attestation.options)
    applyOverlay({ type: "closeChat" }, document, SRC, undefined, attestation.options)
    expect(chatOf(document).open).toBe(false)
  })

  test("toggleInspector uses the document inspector port", async () => {
    await withOpenShadow(async () => {
      const calls: string[] = []
      const send: InspectorSend = async (ask) => {
        calls.push(ask.type)
        if (ask.type === "loadInspector") {
          return { type: "inspectorLoaded", record: null }
        }
        if (ask.type === "resolveInspectorSource") {
          return { type: "inspectorSourceResolved", source: null }
        }
        return ask.type === "saveInspector"
          ? { type: "inspectorSaved" }
          : { type: "inspectorCleared" }
      }
      const uninstall = installInspectorHotkey(document, SRC, send, attestation.options)
      try {
        applyOverlay({ type: "toggleInspector" }, document, SRC, undefined, attestation.options)
        await new Promise((resolve) => setTimeout(resolve, 0))

        // The port installed by installInspectorHotkey, not some other one, answered
        // the load: inspect mode actually mounted, evidenced by the controller's root.
        expect(calls).toContain("loadInspector")
        const host = Array.from(document.documentElement.children).find((el) => el.shadowRoot !== null)
        expect(host?.shadowRoot?.querySelector(".mi-root")).not.toBeNull()
      } finally {
        uninstall()
      }
    })
  })
})
