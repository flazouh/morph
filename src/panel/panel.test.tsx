import { afterEach, describe, expect, test } from "bun:test"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { NO_SPEND } from "@/agent/spend"
import { IDLE_TURN, type RunState, type Session, type Step, type TurnView } from "@/session"
import { fakeSession } from "@/session/fake"
import { memorySettings } from "@/session/settings"
import { memoryThreads } from "@/session/threads"
import type { PanelAction } from "@/overlay/messages"
import { App } from "./App"
import type { ComponentProps } from "react"

const TestApp = (props: ComponentProps<typeof App>) => <App threads={memoryThreads()} {...props} />

const holdSession = (afterUser: ReadonlyArray<Step>): Session & { finish: () => void } => {
  let steps: ReadonlyArray<Step> = []
  let state: RunState = "idle"
  let turn: TurnView = IDLE_TURN
  const finalAnswer = afterUser.findLast((step) => step.kind === "assistant")
  const activeTool = afterUser.findLast(
    (step) => step.kind === "tool" && step.result === undefined
  )
  const activityText = afterUser
    .filter((step) => step.kind === "thinking")
    .map((step) => step.text)
    .join("\n")
  const listeners = new Set<() => void>()
  const notify = () => {
    for (const listener of listeners) listener()
  }
  return {
    threadId: "held-thread",
    url: "https://example.com/",
    send: async (text) => {
      steps = [
        { kind: "user", text, at: Date.now() },
        ...afterUser.filter(
          (step) =>
            step.kind !== "assistant" &&
            (step.kind !== "thinking" || activeTool !== undefined)
        )
      ]
      state = "working"
      turn = {
        phase: activeTool !== undefined ? "runningTool" : finalAnswer !== undefined ? "answering" : "thinking",
        activityText:
          activeTool !== undefined
            ? ""
            : finalAnswer?.kind === "assistant"
              ? finalAnswer.text
              : activityText,
        answerDraft: finalAnswer?.kind === "assistant" ? finalAnswer.text : "",
        finalAnswer: "",
        activeTool: activeTool?.kind === "tool" ? activeTool : undefined,
        startedAt: Date.now()
      }
      notify()
    },
    stop: async () => {
      state = "idle"
      turn = { ...turn, phase: "stopped", answerDraft: "", activeTool: undefined }
      notify()
    },
    answerQuestion: async () => false,
    steps: () => steps,
    turn: () => turn,
    state: () => state,
    spend: () => NO_SPEND,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    reset: async () => {
      steps = []
      state = "idle"
      turn = IDLE_TURN
      notify()
    },
    clear: async () => {
      steps = []
      state = "idle"
      turn = IDLE_TURN
      notify()
    },
    forgetPage: async () => {},
    forgetSite: async () => {},
    finish: () => {
      if (finalAnswer?.kind === "assistant") steps = [...steps, finalAnswer]
      state = "idle"
      turn = {
        ...turn,
        phase: "complete",
        activityText: "",
        answerDraft: "",
        finalAnswer: finalAnswer?.kind === "assistant" ? finalAnswer.text : "",
        activeTool: undefined
      }
      notify()
    }
  }
}

afterEach(cleanup)

describe("panel", () => {
  test("the top tabs keep site sessions alive while another thread works", async () => {
    const threads = memoryThreads(() => "thread-two")
    const opened: Array<string | undefined> = []
    const homepageSession = holdSession([{ kind: "assistant", text: "Homepage work finished.", at: 1 }])
    const secondSession = holdSession([])
    const openSession = async (threadId?: string) => {
      opened.push(threadId)
      return {
        ...(threadId === "thread-two" ? secondSession : homepageSession),
        threadId: threadId ?? "https://example.com/"
      }
    }
    render(<TestApp openSession={openSession} threads={threads} settings={memorySettings({ openRouterKey: "k" })} />)

    expect(await screen.findByRole("tab", { name: "Current chat" })).toBeTruthy()
    expect(screen.getByRole("tabpanel", { name: "Current chat" })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "New chat" }))

    await waitFor(() => expect(screen.getByRole("tab", { name: "New chat" }).getAttribute("aria-selected")).toBe("true"))
    expect(opened.at(-1)).toBe("thread-two")
    fireEvent.click(screen.getByRole("tab", { name: "Current chat" }))
    await waitFor(() => expect(screen.getByRole("tab", { name: "Current chat" }).getAttribute("aria-selected")).toBe("true"))

    await act(async () => threads.select("https://example.com", "thread-two"))
    await waitFor(() => expect(screen.getByRole("tab", { name: "New chat" }).getAttribute("aria-selected")).toBe("true"))
    fireEvent.click(screen.getByRole("tab", { name: "Current chat" }))
    await waitFor(() => expect(screen.getByRole("tab", { name: "Current chat" }).getAttribute("aria-selected")).toBe("true"))

    const composer = screen.getByLabelText("Message")
    fireEvent.change(composer, { target: { value: "Make checkout calmer" } })
    fireEvent.keyDown(composer, { key: "Enter" })
    await waitFor(() => expect(screen.getByRole("tab", { name: "Make checkout calmer" })).toBeTruthy())

    fireEvent.click(screen.getByRole("tab", { name: "New chat" }))
    await waitFor(() => expect(screen.getByRole("tab", { name: "New chat" }).getAttribute("aria-selected")).toBe("true"))
    act(() => homepageSession.finish())
    fireEvent.click(screen.getByRole("tab", { name: "Make checkout calmer" }))
    await waitFor(() => expect(screen.getByRole("tab", { name: "Make checkout calmer" }).getAttribute("aria-selected")).toBe("true"))
    await waitFor(() => expect((screen.getByLabelText("Message") as HTMLTextAreaElement).disabled).toBe(false))
    expect(within(screen.getByRole("tabpanel")).getByText("Homepage work finished.")).toBeTruthy()
    expect(opened).toEqual([undefined, "thread-two"])
  })

  test("the User Scripts card asks above the chat while the switch is off, and not otherwise", async () => {
    const off = { enabled: async () => false, openSettings: async () => {}, reload: async () => {} }
    render(<TestApp openSession={async () => fakeSession(10)} settings={memorySettings({ openRouterKey: "k" })} userScripts={off} />)
    expect(await screen.findByText("Morph needs User Scripts")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Open Morph settings" })).toBeTruthy()
    // The composer stays usable: reads work while writes wait.
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).disabled).toBe(false)
    cleanup()

    render(<TestApp openSession={async () => fakeSession(10)} settings={memorySettings({ openRouterKey: "k" })} />)
    expect(await screen.findByLabelText("Message")).toBeTruthy()
    expect(screen.queryByText("Morph needs User Scripts")).toBeNull()
  })

  test("a tab can switch back while another thread is still opening", async () => {
    const threads = memoryThreads(() => "thread-two")
    const current = holdSession([])
    const openSession = async (threadId?: string): Promise<Session> => {
      if (threadId === "thread-two") return new Promise(() => {})
      return { ...current, threadId: "https://example.com/" }
    }
    render(<TestApp openSession={openSession} threads={threads} settings={memorySettings({ openRouterKey: "k" })} />)

    expect(await screen.findByRole("tab", { name: "Current chat" })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "New chat" }))
    await waitFor(() => expect(screen.getByRole("tab", { name: "New chat" }).getAttribute("aria-selected")).toBe("true"))

    fireEvent.click(screen.getByRole("tab", { name: "Current chat" }))
    await waitFor(() => expect(screen.getByRole("tab", { name: "Current chat" }).getAttribute("aria-selected")).toBe("true"))

    fireEvent.click(screen.getByRole("tab", { name: "New chat" }))
    await waitFor(() => expect(screen.getByRole("tab", { name: "New chat" }).getAttribute("aria-selected")).toBe("true"))
  })

  test("a new tab appears without waiting for a storage notification", async () => {
    const stored = memoryThreads(() => "thread-two")
    const threads = { ...stored, subscribe: () => () => undefined }
    const current = holdSession([])
    const openSession = async (threadId?: string): Promise<Session> => {
      if (threadId === "thread-two") return new Promise(() => {})
      return { ...current, threadId: "https://example.com/" }
    }
    render(<TestApp openSession={openSession} threads={threads} settings={memorySettings({ openRouterKey: "k" })} />)

    expect(await screen.findByRole("tab", { name: "Current chat" })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "New chat" }))
    await waitFor(() => expect(screen.getByRole("tab", { name: "New chat" }).getAttribute("aria-selected")).toBe("true"))

    fireEvent.click(screen.getByRole("tab", { name: "Current chat" }))
    await waitFor(() => expect(screen.getByRole("tab", { name: "Current chat" }).getAttribute("aria-selected")).toBe("true"))
    fireEvent.click(screen.getByRole("tab", { name: "New chat" }))
    await waitFor(() => expect(screen.getByRole("tab", { name: "New chat" }).getAttribute("aria-selected")).toBe("true"))
  })

  test("sending a message walks the composer from idle to working to settled", async () => {
    const session = fakeSession(10)
    render(<TestApp openSession={async () => session} settings={memorySettings({ openRouterKey: "k" })} />)

    const composer = (await screen.findByLabelText("Message")) as HTMLTextAreaElement
    await waitFor(() => expect(screen.getByRole("button", { name: "Send prompt" })).toBeTruthy())
    expect(screen.queryByRole("button", { name: /^Redesign$|^Working$|^Applied$/ })).toBeNull()

    fireEvent.change(composer, { target: { value: "make it dark" } })
    fireEvent.keyDown(composer, { key: "Enter" })

    await screen.findByRole("button", { name: "Stop generating" })
    expect(composer.value).toBe("")
    expect(screen.getByRole("status").textContent).toMatch(/Thinking…|Running tools…|Planning next moves…/)

    await waitFor(() => expect(screen.getByRole("button", { name: "Send prompt" })).toBeTruthy(), { timeout: 2000 })

    // The fake's two tool calls are on screen, both settled, each with its plain title.
    const tools = screen.getAllByTestId("tool-step")
    expect(tools.map((t) => t.dataset["status"])).toEqual(["success", "success"])
    expect(tools[0]?.textContent).toContain("Read the page")
    expect(tools[1]?.textContent).toContain("Apply styles")
    expect(tools.every((tool) => !tool.textContent?.includes("Completed"))).toBe(true)
    expect(within(screen.getByRole("tabpanel")).getByText("make it dark")).toBeTruthy()
    expect(screen.getAllByLabelText("Copy response").length).toBeGreaterThan(0)
  })

  test("a stale question answer stays available through the app session seam", async () => {
    let answerCalls = 0
    const session = {
      ...holdSession([
        {
          kind: "tool" as const,
          callId: "stale-question",
          name: "ask_user",
          input: {
            question: "Which layout should I use?",
            options: [
              { id: "grid", label: "Grid" },
              { id: "list", label: "List" }
            ]
          },
          at: 2
        }
      ]),
      answerQuestion: async () => {
        answerCalls += 1
        return false
      }
    }
    render(<TestApp openSession={async () => session} settings={memorySettings({ openRouterKey: "k" })} />)

    const composer = (await screen.findByLabelText("Message")) as HTMLTextAreaElement
    await waitFor(() => expect(composer.disabled).toBe(false))
    fireEvent.change(composer, { target: { value: "Redesign this page." } })
    fireEvent.keyDown(composer, { key: "Enter" })

    const list = (await screen.findByRole("radio", { name: "List" })) as HTMLButtonElement
    fireEvent.click(list)
    fireEvent.click(screen.getByRole("button", { name: "Submit response" }))

    expect(answerCalls).toBe(1)
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/did not go through.*try again/i))
    expect(list.disabled).toBe(false)
  })

  test("the composer keeps the PromptInput frame and spacing", async () => {
    render(<TestApp openSession={async () => fakeSession(10)} settings={memorySettings({ openRouterKey: "k" })} />)

    const composer = (await screen.findByLabelText("Message")) as HTMLTextAreaElement
    const form = composer.closest("form")
    if (!(form instanceof HTMLFormElement)) throw new Error("missing prompt form")
    const frame = form.parentElement
    if (!(frame instanceof HTMLElement)) throw new Error("missing prompt frame")

    expect(composer.getAttribute("rows")).toBe("2")
    expect(frame.className.split(" ")).toContain("p-2")
    expect(frame.className.split(" ")).not.toContain("pt-1")
    expect(form.className.split(" ")).toContain("p-2")
    expect(form.className.split(" ")).toContain("border-border/80")
    expect(form.className.split(" ")).toContain("bg-background")
    expect(form.className.split(" ")).not.toContain("border-0")
    expect(form.className.split(" ")).not.toContain("bg-card")
    const submit = screen.getByRole("button", { name: "Send prompt" })
    expect(submit.className.split(" ")).toContain("rounded-full")
    expect(submit.className.split(" ")).not.toContain("rounded-md")
  })

  test("the red built-in stop button cancels a running turn", async () => {
    const session = fakeSession(80)
    render(<TestApp openSession={async () => session} settings={memorySettings({ openRouterKey: "k" })} />)
    const composer = (await screen.findByLabelText("Message")) as HTMLTextAreaElement
    await waitFor(() => expect(screen.getByRole("button", { name: "Send prompt" })).toBeTruthy())

    fireEvent.change(composer, { target: { value: "make it dark" } })
    fireEvent.keyDown(composer, { key: "Enter" })

    const stop = await screen.findByRole("button", { name: "Stop generating" })
    expect(stop.className).toContain("bg-[#FC6B83]")
    fireEvent.click(stop)

    await waitFor(() => expect(screen.getByRole("button", { name: "Send prompt" })).toBeTruthy())
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(screen.queryByTestId("tool-step")).toBeNull()
  })

  test("a message during a turn stops it and starts the new instruction", async () => {
    const session = fakeSession(40)
    render(<TestApp openSession={async () => session} settings={memorySettings({ openRouterKey: "k" })} />)
    const composer = (await screen.findByLabelText("Message")) as HTMLTextAreaElement
    await waitFor(() => expect(composer.disabled).toBe(false))

    fireEvent.change(composer, { target: { value: "make it dark" } })
    fireEvent.keyDown(composer, { key: "Enter" })
    await screen.findByRole("button", { name: "Stop generating" })

    expect(composer.disabled).toBe(false)
    fireEvent.change(composer, { target: { value: "use tighter spacing" } })
    fireEvent.click(screen.getByRole("button", { name: "Steer turn" }))

    await waitFor(() => expect(within(screen.getByRole("tabpanel")).getByText("use tighter spacing")).toBeTruthy())
    // The steer leaves the composer the way a send does: empty.
    expect(composer.value).toBe("")
    await waitFor(() => expect(screen.getByRole("button", { name: "Send prompt" })).toBeTruthy(), { timeout: 1000 })
    expect(within(screen.getByRole("tabpanel")).getByText("make it dark")).toBeTruthy()
    expect(screen.getAllByText("Applied a dark canvas. Say what to change next.")).toHaveLength(1)
  })

  test("while a turn runs, the activity shows the model's thinking and the seconds that have passed", async () => {
    const session = fakeSession(80)
    render(<TestApp openSession={async () => session} settings={memorySettings({ openRouterKey: "k" })} />)
    const composer = (await screen.findByLabelText("Message")) as HTMLTextAreaElement
    await waitFor(() => expect(composer.disabled).toBe(false))

    fireEvent.change(composer, { target: { value: "make it dark" } })
    fireEvent.keyDown(composer, { key: "Enter" })

    await waitFor(() => expect(screen.getByText(/The page is a dense list/)).toBeTruthy())
    expect(composer.disabled).toBe(false)
    expect(screen.getByRole("button", { name: "Stop generating" })).toBeTruthy()
    expect(screen.getByRole("status").textContent).toMatch(/Thinking…/)
    expect(screen.getByRole("status").textContent).toMatch(/\d+s/)
    expect(screen.getByRole("status").textContent).not.toMatch(/\d+\.\d+s/)
    expect(screen.queryByText("Read the page")).toBeNull()
  })

  test("live answer text stays in activity until the completed reply renders markdown", async () => {
    const session = holdSession([{ kind: "assistant", text: "Use a **dark** canvas.", at: 1 }])
    render(<TestApp openSession={async () => session} settings={memorySettings({ openRouterKey: "k" })} />)
    const composer = (await screen.findByLabelText("Message")) as HTMLTextAreaElement
    await waitFor(() => expect(screen.getByRole("button", { name: "Send prompt" })).toBeTruthy())
    fireEvent.change(composer, { target: { value: "make it dark" } })
    fireEvent.keyDown(composer, { key: "Enter" })
    await waitFor(() => expect(screen.getByText("Use a **dark** canvas.")).toBeTruthy())
    expect(screen.queryByText("dark")).toBeNull()
    expect(screen.queryByLabelText("Copy response")).toBeNull()
    expect(screen.getByRole("status").textContent).toMatch(/Writing…/)
    act(() => session.finish())
    await waitFor(() => expect(screen.getByText("dark").closest("strong, [data-streamdown='strong']")).toBeTruthy())
    await waitFor(() => expect(screen.getByLabelText("Copy response")).toBeTruthy())
    expect(screen.getAllByText("dark")).toHaveLength(1)
  })

  test("a running tool collapses the prior thought and does not sit under it", async () => {
    const session = holdSession([
      { kind: "thinking", text: "I will restyle it.", at: Date.now() },
      { kind: "tool", callId: "c1", name: "read_page", input: { selector: "body" }, at: Date.now() }
    ])
    render(<TestApp openSession={async () => session} settings={memorySettings({ openRouterKey: "k" })} />)
    const composer = (await screen.findByLabelText("Message")) as HTMLTextAreaElement
    await waitFor(() => expect(composer.disabled).toBe(false))
    fireEvent.change(composer, { target: { value: "make it dark" } })
    fireEvent.keyDown(composer, { key: "Enter" })

    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/Running tools…/))
    // The running call is its own open step with its input on show.
    const step = screen.getByTestId("tool-step")
    expect(step.dataset["status"]).toBe("running")
    expect(step.textContent).toContain("body")
    expect(screen.queryAllByRole("listitem").some((row) => row.textContent?.includes("I will restyle it."))).toBe(false)
    expect(screen.getByRole("button", { name: /Thought/ })).toBeTruthy()
  })

  test("after a tool returns, the status is Planning next moves until new thinking arrives", async () => {
    const session = fakeSession(80)
    render(<TestApp openSession={async () => session} settings={memorySettings({ openRouterKey: "k" })} />)
    const composer = (await screen.findByLabelText("Message")) as HTMLTextAreaElement
    await waitFor(() => expect(composer.disabled).toBe(false))
    fireEvent.change(composer, { target: { value: "make it dark" } })
    fireEvent.keyDown(composer, { key: "Enter" })

    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/Running tools…/))
    await waitFor(() => {
      const status = screen.getByRole("status").textContent ?? ""
      expect(status).toMatch(/Planning next moves…/)
      expect(status).not.toMatch(/Running tools…/)
    })
  })

  test("the activity keeps the last four lines of thinking", async () => {
    const session = holdSession([
      { kind: "thinking", text: "one\ntwo\nthree\nfour\nfive\nsix", at: Date.now() }
    ])
    render(<TestApp openSession={async () => session} settings={memorySettings({ openRouterKey: "k" })} />)
    const composer = (await screen.findByLabelText("Message")) as HTMLTextAreaElement
    await waitFor(() => expect(composer.disabled).toBe(false))
    fireEvent.change(composer, { target: { value: "make it dark" } })
    fireEvent.keyDown(composer, { key: "Enter" })

    await waitFor(() => expect(screen.getByText(/six/)).toBeTruthy())
    expect(screen.queryByText(/one/)).toBeNull()
    expect(screen.getByText(/three/)).toBeTruthy()
  })

  test("the turn shows the model's to-do list", async () => {
    const session = fakeSession(10)
    render(<TestApp openSession={async () => session} settings={memorySettings({ openRouterKey: "k" })} />)
    const composer = (await screen.findByLabelText("Message")) as HTMLTextAreaElement
    await waitFor(() => expect(composer.disabled).toBe(false))
    fireEvent.change(composer, { target: { value: "make it dark" } })
    fireEvent.keyDown(composer, { key: "Enter" })

    await waitFor(() => expect(screen.getByText("To-dos")).toBeTruthy())
    expect(screen.getByText("Inspect the page")).toBeTruthy()
    expect(screen.getByText("Apply a dark canvas")).toBeTruthy()
    expect(screen.getByText("To-dos").closest("main")).toBeNull()
    expect(screen.getByText("To-dos").compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    await waitFor(() => expect(composer.disabled).toBe(false))
    expect(screen.getByText("To-dos").closest("footer")).toBeTruthy()
  })

  test("the composer shows nothing spent until a turn is priced, then the running total", async () => {
    const session = fakeSession(10)
    render(<TestApp openSession={async () => session} settings={memorySettings({ openRouterKey: "k" })} />)
    const composer = (await screen.findByLabelText("Message")) as HTMLTextAreaElement
    await waitFor(() => expect(composer.disabled).toBe(false))
    expect(screen.queryByTestId("spend")).toBeNull()

    fireEvent.change(composer, { target: { value: "make it dark" } })
    fireEvent.keyDown(composer, { key: "Enter" })
    await waitFor(() => expect(screen.getByTestId("spend").textContent).toBe("$0.004"), { timeout: 2000 })
    expect(screen.getByTestId("spend").textContent).toBe("$0.004")
    expect(screen.getByTestId("spend").title).toBe("3,100 in · 420 out · $0.0042 billed by OpenRouter")

    fireEvent.change(composer, { target: { value: "now cards" } })
    fireEvent.keyDown(composer, { key: "Enter" })
    await waitFor(() => expect(screen.getByTestId("spend").textContent).toBe("$0.008"), { timeout: 2000 })
    expect(screen.getByTestId("spend").textContent).toBe("$0.008")
  })

  test("a finished reply stays complete when the next turn starts", async () => {
    const session = fakeSession(10)
    render(<TestApp openSession={async () => session} settings={memorySettings({ openRouterKey: "k" })} />)
    const composer = (await screen.findByLabelText("Message")) as HTMLTextAreaElement
    await waitFor(() => expect(composer.disabled).toBe(false))

    fireEvent.change(composer, { target: { value: "make it dark" } })
    fireEvent.keyDown(composer, { key: "Enter" })
    await waitFor(() => expect(screen.getAllByLabelText("Copy response").length).toBeGreaterThan(0), { timeout: 2000 })
    const copies = screen.getAllByLabelText("Copy response").length
    expect(copies).toBeGreaterThan(0)

    fireEvent.change(composer, { target: { value: "now cards" } })
    fireEvent.keyDown(composer, { key: "Enter" })
    await screen.findByRole("button", { name: "Stop generating" })
    expect(screen.getAllByLabelText("Copy response").length).toBe(copies)
  })

  test("clearing a chat asks first and does not remove the look control", async () => {
    const session = fakeSession(10)
    render(<TestApp openSession={async () => session} settings={memorySettings({ openRouterKey: "k" })} />)
    const composer = (await screen.findByLabelText("Message")) as HTMLTextAreaElement
    await waitFor(() => expect(composer.disabled).toBe(false))
    fireEvent.change(composer, { target: { value: "make it dark" } })
    fireEvent.keyDown(composer, { key: "Enter" })
    await waitFor(() => expect(screen.getAllByLabelText("Copy response").length).toBeGreaterThan(0), { timeout: 2000 })

    fireEvent.click(screen.getByRole("button", { name: "Clear make it dark" }))
    expect(screen.getByText("The look on the page stays.")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Keep" }))
    expect(within(screen.getByRole("tabpanel")).getByText("make it dark")).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Clear make it dark" }))
    fireEvent.click(screen.getByRole("button", { name: "Clear" }))
    await waitFor(() => expect(screen.getByRole("heading", { name: "What should we restyle?" })).toBeTruthy())
    expect(screen.getByRole("button", { name: "Take a look off" })).toBeTruthy()
  })

  test("removing a page look asks twice and leaves the chat", async () => {
    const session = fakeSession(10)
    render(<TestApp openSession={async () => session} settings={memorySettings({ openRouterKey: "k" })} />)
    const composer = (await screen.findByLabelText("Message")) as HTMLTextAreaElement
    await waitFor(() => expect(composer.disabled).toBe(false))
    fireEvent.change(composer, { target: { value: "make it dark" } })
    fireEvent.keyDown(composer, { key: "Enter" })
    await waitFor(() => expect(screen.getAllByLabelText("Copy response").length).toBeGreaterThan(0), { timeout: 2000 })

    fireEvent.click(screen.getByRole("button", { name: "Take a look off" }))
    fireEvent.click(screen.getByRole("button", { name: "This page" }))
    fireEvent.click(screen.getByRole("button", { name: "Remove" }))
    expect(within(screen.getByRole("tabpanel")).getByText("make it dark")).toBeTruthy()
    await waitFor(() => expect(screen.getByText("Page look removed")).toBeTruthy())
  })

  test("removing a site look calls the site action and leaves the chat", async () => {
    let forgetSiteCalls = 0
    const session = {
      ...fakeSession(10),
      forgetSite: async () => {
        forgetSiteCalls += 1
      }
    }
    render(<TestApp openSession={async () => session} settings={memorySettings({ openRouterKey: "k" })} />)
    const composer = (await screen.findByLabelText("Message")) as HTMLTextAreaElement
    await waitFor(() => expect(composer.disabled).toBe(false))
    fireEvent.change(composer, { target: { value: "make it dark" } })
    fireEvent.keyDown(composer, { key: "Enter" })
    await waitFor(() => expect(screen.getAllByLabelText("Copy response").length).toBeGreaterThan(0), { timeout: 2000 })

    fireEvent.click(screen.getByRole("button", { name: "Take a look off" }))
    fireEvent.click(screen.getByRole("button", { name: "This site" }))
    fireEvent.click(screen.getByRole("button", { name: "Remove" }))

    await waitFor(() => expect(forgetSiteCalls).toBe(1))
    expect(within(screen.getByRole("tabpanel")).getByText("make it dark")).toBeTruthy()
    await waitFor(() => expect(screen.getByText("Site look removed")).toBeTruthy())
  })

  test("a repository failure reports that the site look was not removed", async () => {
    const session = {
      ...fakeSession(10),
      forgetSite: async () => {
        throw new Error("GitHub refused the update")
      }
    }
    render(<TestApp openSession={async () => session} settings={memorySettings({ openRouterKey: "k" })} />)
    await screen.findByRole("button", { name: "Take a look off" })

    fireEvent.click(screen.getByRole("button", { name: "Take a look off" }))
    fireEvent.click(screen.getByRole("button", { name: "This site" }))
    fireEvent.click(screen.getByRole("button", { name: "Remove" }))

    await waitFor(() => expect(screen.getByText("Site look not removed")).toBeTruthy())
    expect(screen.getByText("GitHub refused the update")).toBeTruthy()
    expect(screen.queryByText("Site look removed")).toBeNull()
  })

  test("the empty panel invites a restyle and the header has no site name", async () => {
    render(<TestApp openSession={async () => fakeSession(10)} settings={memorySettings({ openRouterKey: "k" })} />)
    await screen.findByRole("heading", { name: "What should we restyle?" })
    const mascot = screen.getByRole("img", { name: "Friendly shape" })
    expect(mascot.querySelectorAll("[data-shape]")).toHaveLength(1)
    expect(mascot.querySelector("[data-shape]")?.getAttribute("fill")).toBe("#FF9800")
    expect(screen.queryByText("github.com")).toBeNull()
    expect(screen.queryByRole("button", { name: /^Redesign$|^Working$|^Applied$/ })).toBeNull()
    expect(screen.queryByRole("button", { name: "Turn the list into cards" })).toBeNull()
  })

  test("the composer shows the model picker and a choice writes settings", async () => {
    const settings = memorySettings({ openRouterKey: "k" })
    render(<TestApp openSession={async () => fakeSession(10)} settings={settings} />)
    const trigger = await screen.findByRole("button", { name: /Kimi K3/ })
    await waitFor(() => expect((trigger as HTMLButtonElement).disabled).toBe(false))
    expect(trigger.className).toContain("border-0")
    expect(trigger.className).toContain("bg-transparent")
    fireEvent.click(trigger)
    const option = await screen.findByRole("option", { name: /GPT-5.2/ })
    fireEvent.click(option)
    await waitFor(async () => expect((await settings.read()).model).toBe("openai/gpt-5.2"))
  })

  test("provider switches load and restore each provider's stored model", async () => {
    const settings = memorySettings({
      openRouterKey: "or-key",
      cursorKey: "cursor-key",
      model: "openai/gpt-5.2",
      cursorModel: "composer-2"
    })
    const openRouterModels = [{ value: "openai/gpt-5.2", label: "GPT-5.2", in: "$1/M", out: "$2/M" }]
    const cursorModels = [
      { value: "composer-2", label: "Composer 2", in: "—", out: "—" },
      { value: "claude-4.6", label: "Claude 4.6", in: "—", out: "—" }
    ]
    render(
      <TestApp
        openSession={async () => fakeSession(10)}
        settings={settings}
        loadModels={async () => openRouterModels}
        loadCursorModels={async () => cursorModels}
      />
    )

    expect(await screen.findByRole("button", { name: "GPT-5.2" })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Settings" }))
    fireEvent.click(screen.getByRole("button", { name: "AI provider" }))
    fireEvent.click(screen.getByRole("button", { name: "Cursor" }))
    await waitFor(async () => expect((await settings.read()).provider).toBe("cursor"))
    fireEvent.click(screen.getByRole("button", { name: "Back to chat" }))

    const cursorPicker = await screen.findByRole("button", { name: "Composer 2" })
    fireEvent.click(cursorPicker)
    fireEvent.click(await screen.findByRole("option", { name: /Claude 4.6/ }))
    await waitFor(async () => expect((await settings.read()).cursorModel).toBe("claude-4.6"))

    fireEvent.click(screen.getByRole("button", { name: "Settings" }))
    fireEvent.click(screen.getByRole("button", { name: "AI provider" }))
    fireEvent.click(screen.getByRole("button", { name: "OpenRouter" }))
    await waitFor(async () => expect((await settings.read()).provider).toBe("openrouter"))
    fireEvent.click(screen.getByRole("button", { name: "Back to chat" }))
    expect(await screen.findByRole("button", { name: "GPT-5.2" })).toBeTruthy()
    expect((await settings.read()).cursorModel).toBe("claude-4.6")
  })

  test("the model picker filters compact rows with metadata on the right", async () => {
    const settings = memorySettings({ openRouterKey: "k" })
    const catalog = [
      { value: "moonshotai/kimi-k3", label: "Kimi K3", in: "$3/M", out: "$15/M", intelligence: 43.8 },
      { value: "openai/gpt-5.2", label: "GPT-5.2", in: "$1.75/M", out: "$14/M" },
      { value: "x-ai/grok-4.5", label: "Grok 4.5", in: "$2/M", out: "$6/M" }
    ]
    render(<TestApp openSession={async () => fakeSession(10)} settings={settings} loadModels={async () => catalog} />)
    const trigger = await screen.findByRole("button", { name: /Kimi K3/ })
    await waitFor(() => expect((trigger as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(trigger)
    const kimi = await screen.findByRole("option", { name: /Kimi K3.*43\.8 intel · \$3\/M in · \$15\/M out/ })
    expect(kimi.className).toContain("items-center")
    expect(kimi.children[2]?.className).toContain("flex")
    expect(kimi.querySelector('[title="Input price"]')?.textContent).toBe("$3")
    expect(kimi.querySelector('[title="Output price"]')?.textContent).toBe("$15")
    expect(screen.getByRole("option", { name: /Grok 4.5.*\$2\/M in · \$6\/M out/ })).toBeTruthy()
    fireEvent.change(screen.getByLabelText("Filter models"), { target: { value: "grok" } })
    expect(screen.queryByRole("option", { name: /GPT-5.2/ })).toBeNull()
    fireEvent.click(screen.getByRole("option", { name: /Grok 4.5/ }))
    await waitFor(async () => expect((await settings.read()).model).toBe("x-ai/grok-4.5"))
  })

  test("the file picker appends the file to the draft", async () => {
    render(<TestApp openSession={async () => fakeSession(10)} settings={memorySettings({ openRouterKey: "k" })} />)
    fireEvent.click(await screen.findByRole("button", { name: "Add to prompt" }))
    fireEvent.click(await screen.findByRole("button", { name: /Add a file/ }))
    const picker = screen.getByTestId("file-picker") as HTMLInputElement
    await act(async () => {
      fireEvent.change(picker, { target: { files: [new File(["body{}"], "theme.css", { type: "text/css" })] } })
    })
    await waitFor(() => {
      const composer = screen.getByLabelText("Message") as HTMLTextAreaElement
      expect(composer.value).toContain("theme.css")
      expect(composer.value).toContain("body{}")
    })
  })

  test("a change in the settings workspace writes the store", async () => {
    const settings = memorySettings({ openRouterKey: "k" })
    render(<TestApp openSession={async () => fakeSession(10)} settings={settings} />)
    fireEvent.click(await screen.findByRole("button", { name: "Settings" }))
    fireEvent.click(screen.getByRole("button", { name: "AI provider" }))
    const key = await screen.findByLabelText("OpenRouter key")
    fireEvent.change(key, { target: { value: "sk-or-new" } })
    await waitFor(async () => expect((await settings.read()).openRouterKey).toBe("sk-or-new"))
  })

  test("the gear opens the full settings workspace and back returns to the chat", async () => {
    render(<TestApp openSession={async () => fakeSession(10)} settings={memorySettings({ openRouterKey: "k" })} />)
    await screen.findByLabelText("Message")

    fireEvent.click(screen.getByRole("button", { name: "Settings" }))
    // The whole panel is the workspace now: the composer and the gear are gone.
    expect(screen.getByRole("group", { name: "Theme" })).toBeTruthy()
    expect(screen.queryByLabelText("Message")).toBeNull()
    expect(screen.queryByRole("button", { name: "Settings" })).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Back to chat" }))
    expect(await screen.findByLabelText("Message")).toBeTruthy()
    expect(screen.queryByRole("group", { name: "Theme" })).toBeNull()
  })

  test("opening settings widens the embedded card, and back returns it", async () => {
    const actions: PanelAction[] = []
    render(
      <TestApp
        openSession={async () => fakeSession(10)}
        settings={memorySettings({ openRouterKey: "k" })}
        onWindowAction={(action) => actions.push(action)}
      />
    )
    fireEvent.click(await screen.findByRole("button", { name: "Settings" }))
    expect(actions).toContainEqual({ type: "setChatWide", wide: true })

    fireEvent.click(screen.getByRole("button", { name: "Back to chat" }))
    expect(actions).toContainEqual({ type: "setChatWide", wide: false })
  })

  test("the stored theme and font size apply to the document root", async () => {
    render(
      <TestApp
        openSession={async () => fakeSession(10)}
        settings={memorySettings({ openRouterKey: "k", theme: "dark", fontSize: "large" })}
      />
    )
    await waitFor(() => expect(document.documentElement.getAttribute("data-beui-theme")).toBe("dark"))
    expect(document.documentElement.getAttribute("data-font-size")).toBe("large")
    document.documentElement.removeAttribute("data-beui-theme")
    document.documentElement.removeAttribute("data-font-size")
  })

  test("the panel keeps quiet surfaces and the PromptInput frame", async () => {
    render(<TestApp openSession={async () => fakeSession(10)} settings={memorySettings({ openRouterKey: "k" })} />)
    const message = await screen.findByLabelText("Message")
    expect(document.querySelector("header")?.className).not.toContain("border")
    expect(message.closest("form")?.className).toContain("border-border/80")

    fireEvent.click(screen.getByRole("button", { name: "Settings" }))
    fireEvent.click(screen.getByRole("button", { name: "AI provider" }))
    expect(screen.getByLabelText("OpenRouter key").parentElement?.className).toContain("border-0")
  })

  test("a standalone panel does not show chat window controls", async () => {
    render(<TestApp openSession={async () => fakeSession(10)} settings={memorySettings({ openRouterKey: "k" })} />)
    await screen.findByRole("button", { name: "Settings" })
    expect(screen.queryByRole("button", { name: "Close chat" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Minimize chat" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Expand chat" })).toBeNull()
  })

  test("shows the key warning only while the OpenRouter key is empty", async () => {
    const settings = memorySettings()
    render(<TestApp openSession={async () => fakeSession(10)} settings={settings} />)
    // The banner collapses in place (aria-hidden), so query by role: it drops hidden nodes.
    const banner = { name: "Add your OpenRouter key to start Settings" }
    await screen.findByRole("button", banner)
    await act(async () => {
      await settings.write({ openRouterKey: "sk-or-x" })
    })
    await waitFor(() => expect(screen.queryByRole("button", banner)).toBeNull())
  })
})

describe("panel when the tab moves to another page", () => {
  test("reopens the selected thread and keeps its history visible", async () => {
    const thread = fakeSession(10)
    let opened = 0
    let moved: (() => void) | undefined
    const follow = (onChange: () => void) => {
      moved = onChange
      return () => {
        moved = undefined
      }
    }
    render(
      <TestApp openSession={async () => {
        opened += 1
        return thread
      }}
      settings={memorySettings({ openRouterKey: "k" })}
      followPage={follow} />
    )
    const composer = (await screen.findByLabelText("Message")) as HTMLTextAreaElement
    await waitFor(() => expect(composer.disabled).toBe(false))
    fireEvent.change(composer, { target: { value: "make it dark" } })
    fireEvent.keyDown(composer, { key: "Enter" })
    await waitFor(() => expect(screen.getAllByLabelText("Copy response").length).toBeGreaterThan(0), { timeout: 2000 })
    expect(within(screen.getByRole("tabpanel")).getByText("make it dark")).toBeTruthy()

    act(() => moved?.())

    await waitFor(() => expect(opened).toBe(2))
    expect(within(screen.getByRole("tabpanel")).getByText("make it dark")).toBeTruthy()
    expect(opened).toBe(2)
    expect(thread.steps().length).toBeGreaterThan(0)
    expect(screen.queryByTestId("spend")).toBeTruthy()
  })
})

describe("panel when the session cannot open", () => {
  test("shows the reason in place of the timeline", async () => {
    render(<TestApp openSession={() => Promise.reject(new Error("no website is open in this window; open one and try again"))} settings={memorySettings()} />)
    await waitFor(() => expect(screen.getByText("no website is open in this window; open one and try again")).toBeTruthy())
  })
})
