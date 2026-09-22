import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { useState } from "react"
import { NO_SPEND } from "@/agent/spend"
import { panelSrcWithNonce } from "@/overlay/panel-session"
import { IDLE_TURN, type Session } from "@/session"
import { useInspectorHandoff } from "./use-inspector-handoff"

const NONCE = "panel-secret-nonce"
const PAGE_ORIGIN = "https://example.com"
const PANEL_SRC = panelSrcWithNonce("chrome-extension://test/panel.html", NONCE)

afterEach(() => {
  cleanup()
  history.replaceState({}, "", "/")
})

beforeEach(() => {
  history.replaceState({}, "", PANEL_SRC)
})

const makeSession = (): Session & { sent: string[]; stopped: number } => {
  const sent: string[] = []
  let stopped = 0
  return {
    threadId: "thread-a",
    url: "https://example.com/",
    sent,
    get stopped() {
      return stopped
    },
    send: async (text) => {
      sent.push(text)
    },
    stop: async () => {
      stopped += 1
    },
    answerQuestion: async () => false,
    steps: () => [],
    turn: () => IDLE_TURN,
    state: () => "idle",
    spend: () => NO_SPEND,
    subscribe: () => () => {},
    reset: async () => {},
    clear: async () => {},
    forgetPage: async () => {},
    forgetSite: async () => {}
  }
}

const dispatchHandoff = (parent: Window, prompt: string, requestId = "req-1", origin = PAGE_ORIGIN): void => {
  const event = new MessageEvent("message", {
    data: { type: "inspectorHandoff", requestId, nonce: NONCE, prompt },
    origin
  })
  Object.defineProperty(event, "source", { configurable: true, value: parent })
  window.dispatchEvent(event)
}

const HandoffHarness = ({
  embedded,
  session,
  working,
  onSend,
  onSteer,
  validateSession = async () => true
}: {
  embedded: boolean
  session: Session | null
  working: boolean
  onSend: (text: string) => void
  onSteer: (text: string) => void
  validateSession?: (nonce: string) => Promise<boolean>
}) => {
  useInspectorHandoff({ embedded, session, working, onSend, onSteer, validateSession })
  return null
}

/** The panel checks its URL nonce with the worker before it listens; that check is a round trip. */
const attested = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
  })
}

describe("useInspectorHandoff", () => {
  test("accepts a matching nonce and sends exactly one user message", async () => {
    const session = makeSession()
    const onSend = mock((text: string) => {
      void session.send(text)
    })
    const acks: unknown[] = []
    const parent = { postMessage: (message: unknown) => acks.push(message) } as unknown as Window
    Object.defineProperty(window, "parent", { configurable: true, value: parent })

    render(<HandoffHarness embedded session={session} working={false} onSend={onSend} onSteer={mock(() => undefined)} />)
    await attested()

    act(() => {
      dispatchHandoff(parent, "Apply these visual changes in the source code.")
    })

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))
    expect(onSend.mock.calls[0]?.[0]).toBe("Apply these visual changes in the source code.")
    expect(session.sent).toEqual(["Apply these visual changes in the source code."])
    expect(acks).toEqual([{ type: "inspectorHandoffAck", requestId: "req-1" }])
  })

  test("the acknowledgement payload never exposes the panel nonce to the page parent", async () => {
    const session = makeSession()
    const onSend = mock((text: string) => {
      void session.send(text)
    })
    const acks: unknown[] = []
    const parent = { postMessage: (message: unknown) => acks.push(message) } as unknown as Window
    Object.defineProperty(window, "parent", { configurable: true, value: parent })

    render(<HandoffHarness embedded session={session} working={false} onSend={onSend} onSteer={mock(() => undefined)} />)
    await attested()

    act(() => {
      dispatchHandoff(parent, "Keep the nonce private.")
    })

    await waitFor(() => expect(acks).toHaveLength(1))
    expect(acks[0]).toEqual({ type: "inspectorHandoffAck", requestId: "req-1" })
    expect(Object.prototype.hasOwnProperty.call(acks[0], "nonce")).toBe(false)
  })

  test("rejects a forged handoff when the nonce does not match", async () => {
    const session = makeSession()
    const onSend = mock(() => undefined)
    const parent = window.parent

    render(<HandoffHarness embedded session={session} working={false} onSend={onSend} onSteer={mock(() => undefined)} />)
    await attested()

    act(() => {
      const event = new MessageEvent("message", {
        data: { type: "inspectorHandoff", requestId: "forged", nonce: "wrong", prompt: "Forged." },
        origin: PAGE_ORIGIN
      })
      Object.defineProperty(event, "source", { configurable: true, value: parent })
      window.dispatchEvent(event)
    })

    expect(onSend).not.toHaveBeenCalled()
    expect(session.sent).toEqual([])
  })

  test("steers when a turn is already working", async () => {
    const session = makeSession()
    const onSteer = mock(async (text: string) => {
      await session.stop()
      await session.send(text)
    })
    const parent = window.parent

    render(<HandoffHarness embedded session={session} working={true} onSend={mock(() => undefined)} onSteer={onSteer} />)
    await attested()

    act(() => {
      dispatchHandoff(parent, "Hand off while working.")
    })

    await waitFor(() => expect(onSteer).toHaveBeenCalledTimes(1))
    expect(session.stopped).toBe(1)
    expect(session.sent).toEqual(["Hand off while working."])
  })

  test("rejects messages from any other source", async () => {
    const session = makeSession()
    const onSend = mock(() => undefined)
    const stranger = { postMessage: () => undefined } as unknown as Window

    render(<HandoffHarness embedded session={session} working={false} onSend={onSend} onSteer={mock(() => undefined)} />)
    await attested()

    act(() => {
      dispatchHandoff(stranger, "Wrong source.")
    })

    expect(onSend).not.toHaveBeenCalled()
  })

  test("does not listen in standalone panel mode", async () => {
    const session = makeSession()
    const onSend = mock(() => undefined)
    const parent = window.parent

    render(<HandoffHarness embedded={false} session={session} working={false} onSend={onSend} onSteer={mock(() => undefined)} />)
    await attested()

    act(() => {
      dispatchHandoff(parent, "Standalone should ignore this.")
    })

    expect(onSend).not.toHaveBeenCalled()
  })

  test("the newest session receives the prompt through its own callback", async () => {
    const first = makeSession()
    const second = makeSession()
    const firstSend = mock((text: string) => {
      void first.send(text)
    })
    const secondSend = mock((text: string) => {
      void second.send(text)
    })
    const parent = window.parent

    const SwitchingHarness = () => {
      const [session, setSession] = useState<Session | null>(first)
      useInspectorHandoff({
        embedded: true,
        session,
        working: false,
        onSend: session === first ? firstSend : secondSend,
        onSteer: mock(() => undefined),
        validateSession: async () => true
      })
      return (
        <button type="button" onClick={() => setSession(second)}>
          Switch session
        </button>
      )
    }

    render(<SwitchingHarness />)
    await attested()
    fireEvent.click(screen.getByRole("button", { name: "Switch session" }))

    act(() => {
      dispatchHandoff(parent, "Prompt for the current session.", "req-2")
    })

    await waitFor(() => expect(secondSend).toHaveBeenCalledTimes(1))
    expect(firstSend).not.toHaveBeenCalled()
    expect(first.sent).toEqual([])
    expect(second.sent).toEqual(["Prompt for the current session."])
  })

  test("posts the acknowledgement with a wildcard target when the parent origin is opaque", async () => {
    const session = makeSession()
    const onSend = mock((text: string) => {
      void session.send(text)
    })
    const posted: Array<{ message: unknown; targetOrigin: string }> = []
    const parent = {
      postMessage: (message: unknown, targetOrigin: string) => posted.push({ message, targetOrigin })
    } as unknown as Window
    Object.defineProperty(window, "parent", { configurable: true, value: parent })

    render(<HandoffHarness embedded session={session} working={false} onSend={onSend} onSteer={mock(() => undefined)} />)
    await attested()

    act(() => {
      dispatchHandoff(parent, "Opaque parent.", "req-null", "null")
    })

    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]?.targetOrigin).toBe("*")
    expect(posted[0]?.message).toEqual({ type: "inspectorHandoffAck", requestId: "req-null" })
  })

  /**
   * `panel.html` is web accessible, so a hostile page can frame it with a nonce it wrote
   * itself and then post a matching hand-off. Matching its own hash proves nothing: only
   * the worker knows which nonce Morph's content host registered for this tab.
   */
  test("a panel the page framed with a nonce of its own never sends or steers", async () => {
    const session = makeSession()
    const onSend = mock(() => undefined)
    const onSteer = mock(() => undefined)
    const acks: unknown[] = []
    const parent = { postMessage: (message: unknown) => acks.push(message) } as unknown as Window
    Object.defineProperty(window, "parent", { configurable: true, value: parent })

    render(
      <HandoffHarness
        embedded
        session={session}
        working={false}
        onSend={onSend}
        onSteer={onSteer}
        validateSession={async () => false}
      />
    )
    await attested()

    act(() => {
      dispatchHandoff(parent, "Hostile self-framed panel.")
    })

    expect(onSend).not.toHaveBeenCalled()
    expect(onSteer).not.toHaveBeenCalled()
    expect(session.sent).toEqual([])
    // Not even an acknowledgement: the page learns nothing about the panel's state.
    expect(acks).toEqual([])
  })

  test("the worker is asked about the nonce this panel reads from its own URL", async () => {
    const session = makeSession()
    const asked: string[] = []
    const parent = { postMessage: () => undefined } as unknown as Window
    Object.defineProperty(window, "parent", { configurable: true, value: parent })

    render(
      <HandoffHarness
        embedded
        session={session}
        working={false}
        onSend={mock(() => undefined)}
        onSteer={mock(() => undefined)}
        validateSession={async (nonce) => {
          asked.push(nonce)
          return true
        }}
      />
    )
    await attested()

    expect(asked).toEqual([NONCE])
  })

  test("no hand-off is accepted while the attestation check is still in flight", async () => {
    const session = makeSession()
    const onSend = mock((text: string) => {
      void session.send(text)
    })
    const parent = { postMessage: () => undefined } as unknown as Window
    Object.defineProperty(window, "parent", { configurable: true, value: parent })
    let answer: ((valid: boolean) => void) | undefined

    render(
      <HandoffHarness
        embedded
        session={session}
        working={false}
        onSend={onSend}
        onSteer={mock(() => undefined)}
        validateSession={() => new Promise<boolean>((resolve) => { answer = resolve })}
      />
    )
    await attested()

    act(() => {
      dispatchHandoff(parent, "Too early.", "req-early")
    })
    expect(onSend).not.toHaveBeenCalled()

    await act(async () => {
      answer?.(true)
      await Promise.resolve()
    })

    act(() => {
      dispatchHandoff(parent, "After the check.", "req-late")
    })
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))
    expect(session.sent).toEqual(["After the check."])
  })

  test("an attestation check that fails outright leaves the panel silent", async () => {
    const session = makeSession()
    const onSend = mock(() => undefined)
    const parent = { postMessage: () => undefined } as unknown as Window
    Object.defineProperty(window, "parent", { configurable: true, value: parent })

    render(
      <HandoffHarness
        embedded
        session={session}
        working={false}
        onSend={onSend}
        onSteer={mock(() => undefined)}
        validateSession={async () => {
          throw new Error("the worker is gone")
        }}
      />
    )
    await attested()

    act(() => {
      dispatchHandoff(parent, "No worker, no turn.")
    })

    expect(onSend).not.toHaveBeenCalled()
    expect(session.sent).toEqual([])
  })

  test("duplicate request IDs acknowledge again without a second user turn", async () => {
    const session = makeSession()
    const onSend = mock((text: string) => {
      void session.send(text)
    })
    const acks: unknown[] = []
    const parent = {
      postMessage: (message: unknown) => acks.push(message)
    } as unknown as Window
    Object.defineProperty(window, "parent", { configurable: true, value: parent })

    render(<HandoffHarness embedded session={session} working={false} onSend={onSend} onSteer={mock(() => undefined)} />)
    await attested()

    act(() => {
      dispatchHandoff(parent, "First delivery.", "req-dup")
    })
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))

    act(() => {
      dispatchHandoff(parent, "Duplicate delivery.", "req-dup")
    })

    expect(onSend).toHaveBeenCalledTimes(1)
    expect(acks).toHaveLength(2)
    expect(acks[1]).toEqual({ type: "inspectorHandoffAck", requestId: "req-dup" })
    expect(session.sent).toEqual(["First delivery."])
  })
})
