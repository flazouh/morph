import { afterEach, expect, mock, setSystemTime, test } from "bun:test"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { Step } from "@/session"
import { Transcript } from "./Transcript"

const STEPS: ReadonlyArray<Step> = [
  { kind: "user", text: "What should the first release include?", at: 1 },
  { kind: "assistant", text: "Start with the smallest workflow that still feels complete.", at: 2 },
  { kind: "user", text: "Include streaming and recovery states too.", at: 3 },
  { kind: "assistant", text: "Yes. Those states make the first version feel dependable.", at: 4 },
  { kind: "user", text: "How should we present tool results?", at: 5 },
  { kind: "assistant", text: "Keep results close to the action that produced them.", at: 6 }
]

const stubOverflow = () => {
  const priorScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight")
  const priorClient = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight")
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() {
      return 900
    }
  })
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() {
      return 240
    }
  })
  return () => {
    if (priorScroll) Object.defineProperty(HTMLElement.prototype, "scrollHeight", priorScroll)
    else Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight")
    if (priorClient) Object.defineProperty(HTMLElement.prototype, "clientHeight", priorClient)
    else Reflect.deleteProperty(HTMLElement.prototype, "clientHeight")
  }
}

afterEach(cleanup)

test("the empty invite has no message rail", () => {
  render(<Transcript steps={[]} state="idle" />)
  expect(screen.getByRole("heading", { name: "What should we restyle?" })).toBeTruthy()
  expect(screen.queryByRole("navigation", { name: "Message navigation" })).toBeNull()
})

test("a short run keeps the navigation ticks hidden", async () => {
  render(<Transcript steps={STEPS.slice(0, 1)} state="idle" />)
  expect(await screen.findByRole("navigation", { name: "Message navigation" })).toBeTruthy()
  expect(screen.queryByRole("button", { name: /Go to (user|assistant) message/ })).toBeNull()
})

test("a completed thought stays before the answer it produced", () => {
  render(
    <Transcript
      steps={[
        { kind: "user", text: "Restyle this page.", at: 1 },
        { kind: "thinking", text: "I will inspect the page first.", at: 2 },
        { kind: "assistant", text: "I updated the page.", at: 3 }
      ]}
      state="idle"
    />
  )

  const thought = screen.getByRole("button", { name: /Thought for/ }).closest("[data-slot='message']")
  const answer = screen.getByText("I updated the page.").closest("[data-slot='message']")
  if (!(thought instanceof HTMLElement) || !(answer instanceof HTMLElement)) throw new Error("missing turn messages")

  expect(thought.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
})

test("live Cursor narration stays in activity and never becomes an answer bubble", () => {
  render(
    <Transcript
      steps={[{ kind: "user", text: "Restyle this page.", at: 1 }]}
      turn={{
        phase: "answering",
        activityText: "I will inspect the page first.",
        answerDraft: "I will inspect the page first.",
        finalAnswer: "",
        activeTool: undefined,
        startedAt: 1
      }}
      state="working"
    />
  )

  const narration = screen.getByText("I will inspect the page first.")
  expect(narration.closest("[data-state='streaming']")).toBeNull()
  expect(screen.getByText("Writing…")).toBeTruthy()
})

test("a live turn that hears nothing for ten seconds says it waits for the provider, and a new frame ends the wait", () => {
  const turn = {
    phase: "answering" as const,
    activityText: "I'll write the skin.",
    answerDraft: "I'll write the skin.",
    finalAnswer: "",
    activeTool: undefined,
    startedAt: 1
  }
  const steps: ReadonlyArray<Step> = [{ kind: "user", text: "Restyle this page.", at: 1 }]
  const start = Date.now()
  setSystemTime(start)
  const { rerender } = render(<Transcript steps={steps} turn={turn} state="working" provider="cursor" />)
  expect(screen.getByRole("status").textContent).toMatch(/Writing…/)

  setSystemTime(start + 9_000)
  rerender(<Transcript steps={steps} turn={{ ...turn }} state="working" provider="cursor" />)
  expect(screen.getByRole("status").textContent).toMatch(/Writing…/)

  setSystemTime(start + 11_000)
  rerender(<Transcript steps={steps} turn={{ ...turn }} state="working" provider="cursor" />)
  expect(screen.getByRole("status").textContent).toMatch(/Waiting for Cursor…/)
  expect(screen.getByRole("status").textContent).not.toMatch(/Writing…/)

  // A frame lands: the text grows, the wait ends.
  rerender(<Transcript steps={steps} turn={{ ...turn, activityText: "I'll write the skin. Now.", answerDraft: "I'll write the skin. Now." }} state="working" provider="cursor" />)
  expect(screen.getByRole("status").textContent).toMatch(/Writing…/)

  // A tool in hand is never a wait: the extension is doing the work.
  setSystemTime(start + 30_000)
  const call = { kind: "tool" as const, callId: "c1", name: "write_skin", input: {}, at: 2 }
  rerender(<Transcript steps={[...steps, call]} turn={{ ...turn, phase: "runningTool", activeTool: call }} state="working" provider="cursor" />)
  setSystemTime(start + 50_000)
  rerender(<Transcript steps={[...steps, call]} turn={{ ...turn, phase: "runningTool", activeTool: call }} state="working" provider="cursor" />)
  expect(screen.getByRole("status").textContent).toMatch(/Running tools…/)
  setSystemTime()
})

test("terminal turns show stopped and failed outcomes without answer text", () => {
  const steps: ReadonlyArray<Step> = [{ kind: "user", text: "Restyle this page.", at: 1 }]
  const { rerender } = render(
    <Transcript
      steps={steps}
      turn={{
        phase: "stopped",
        activityText: "",
        answerDraft: "",
        finalAnswer: "",
        activeTool: undefined,
        startedAt: 1
      }}
      state="idle"
    />
  )
  expect(screen.getByRole("button", { name: "Stopped" })).toBeTruthy()

  rerender(
    <Transcript
      steps={steps}
      turn={{
        phase: "failed",
        activityText: "",
        answerDraft: "",
        finalAnswer: "",
        activeTool: undefined,
        startedAt: 1
      }}
      state="idle"
    />
  )
  expect(screen.getByRole("button", { name: "Failed" })).toBeTruthy()
})

test("a pending ask_user call locks only after the session accepts its answer", () => {
  const answer = mock(async () => true)
  render(
    <Transcript
      steps={[
        { kind: "user", text: "Redesign this page.", at: 1 },
        {
          kind: "tool",
          callId: "question-1",
          name: "ask_user",
          input: {
            title: "Choose a layout",
            description: "Pick one structure.",
            asciiPreview: "[A] Grid\n[B] List",
            question: "Which layout should I use?",
            options: [
              { id: "grid", label: "Grid" },
              { id: "list", label: "List", description: "A compact vertical list." }
            ]
          },
          at: 2
        }
      ]}
      state="working"
      onAnswerQuestion={answer}
    />
  )

  expect(screen.getByRole("heading", { name: "Choose a layout" })).toBeTruthy()
  expect(screen.getByText("Pick one structure.")).toBeTruthy()
  expect(screen.getByText((_, element) => element?.tagName === "PRE" && element.textContent === "[A] Grid\n[B] List")).toBeTruthy()
  expect(screen.getByText("Which layout should I use?")).toBeTruthy()

  const list = screen.getByRole("radio", { name: "List" })
  expect(
    document.getElementById(list.getAttribute("aria-describedby") ?? "")?.textContent
  ).toBe("A compact vertical list.")
  fireEvent.click(list)
  fireEvent.click(screen.getByRole("button", { name: "Submit response" }))
  expect(answer).toHaveBeenCalledWith("question-1", ["list"])
  expect(screen.getByText("Response submitted")).toBeTruthy()
})

test("a publish confirmation shows the exact authorized release and permissions", () => {
  render(
    <Transcript
      steps={[
        { kind: "user", text: "Publish it.", at: 1 },
        {
          kind: "tool",
          callId: "publish-question",
          name: "ask_user",
          input: {
            question: "Publish this Morph?",
            options: [
              { id: "publish", label: "Publish" },
              { id: "cancel", label: "Cancel" }
            ],
            authorization: {
              action: "publish_morph",
              draftId: "draft-1",
              revisionId: "revision-7",
              name: "Quiet inbox",
              slug: "alex/quiet-inbox",
              summary: "A calmer inbox",
              version: "1.2.0",
              addedPermissions: ["storage", "network:https://api.example.com"]
            }
          },
          at: 2
        }
      ]}
      state="working"
      onAnswerQuestion={async () => true}
    />
  )

  expect(screen.getByText(/Quiet inbox \(alex\/quiet-inbox@1\.2\.0\)/)).toBeTruthy()
  expect(screen.getByText("A calmer inbox")).toBeTruthy()
  expect(
    screen.getByText("storage, network:https://api.example.com")
  ).toBeTruthy()
})

test("a stale ask_user answer stays interactive and explains how to retry", async () => {
  const answer = mock(async () => false)
  render(
    <Transcript
      steps={[
        { kind: "user", text: "Redesign this page.", at: 1 },
        {
          kind: "tool",
          callId: "stale-question",
          name: "ask_user",
          input: {
            question: "Which layout should I use?",
            allowMultiple: true,
            options: [
              { id: "grid", label: "Grid" },
              { id: "list", label: "List" }
            ]
          },
          at: 2
        }
      ]}
      state="working"
      onAnswerQuestion={answer}
    />
  )

  const list = screen.getByRole("checkbox", { name: "List" }) as HTMLButtonElement
  fireEvent.click(list)
  const submit = screen.getByRole("button", { name: "Submit response" }) as HTMLButtonElement
  fireEvent.click(submit)

  // The run's verdict comes back a tick later and reopens the card.
  await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/did not go through.*try again/i))
  expect(list.disabled).toBe(false)
  expect(submit.disabled).toBe(false)

  fireEvent.click(screen.getByRole("checkbox", { name: "Grid" }))
  expect(screen.queryByRole("alert")).toBeNull()
  fireEvent.click(submit)
  expect(answer).toHaveBeenCalledTimes(2)
})

test("an ask_user call a run refused renders as a failed tool row, not a question card", () => {
  render(
    <Transcript
      steps={[
        { kind: "user", text: "Restyle this page.", at: 1 },
        {
          kind: "tool",
          callId: "refused-question",
          name: "ask_user",
          input: {
            title: "Morph needs User Scripts",
            question: "Turn on Allow User Scripts?",
            options: [
              { id: "yes", label: "Yes" },
              { id: "no", label: "No" }
            ]
          },
          result: { error: "ask_user is unavailable in this run" },
          at: 2
        }
      ]}
      state="idle"
    />
  )

  const row = screen.getByTestId("tool-step")
  expect(row.getAttribute("data-status")).toBe("error")
  expect(row.textContent).toContain("Ask the reader")
  expect(screen.queryByRole("heading", { name: "Morph needs User Scripts" })).toBeNull()
  expect(screen.queryByRole("radio")).toBeNull()
})

test("a running tool is an open step that shows its input while the turn runs", () => {
  const running = {
    kind: "tool" as const,
    callId: "live-styles",
    name: "apply_styles",
    input: { css: "body{color:red}" },
    at: 2
  }
  render(
    <Transcript
      steps={[{ kind: "user", text: "Make it red.", at: 1 }, running]}
      state="working"
      turn={{
        phase: "runningTool",
        startedAt: 1,
        activityText: "",
        answerDraft: "",
        finalAnswer: "",
        activeTool: running
      }}
    />
  )

  const step = screen.getByTestId("tool-step")
  expect(step.getAttribute("data-status")).toBe("running")
  expect(within(step).getByRole("button", { expanded: true })).toBeTruthy()
  expect(step.textContent).toContain("body{color:red}")
})

test("a tool step stays open when its call finishes, so the result lands in view", () => {
  const call = { kind: "tool" as const, callId: "read-live", name: "read_text", input: { selector: "h1" }, at: 2 }
  const running = { phase: "runningTool" as const, startedAt: 1, activityText: "", answerDraft: "", finalAnswer: "", activeTool: call }
  const { rerender } = render(<Transcript steps={[{ kind: "user", text: "Read it.", at: 1 }, call]} state="working" turn={running} />)
  expect(within(screen.getByTestId("tool-step")).getByRole("button", { expanded: true })).toBeTruthy()

  rerender(
    <Transcript
      steps={[{ kind: "user", text: "Read it.", at: 1 }, { ...call, result: { text: "Hacker News" } }]}
      state="working"
      turn={{ ...running, phase: "starting", activeTool: undefined }}
    />
  )

  const step = screen.getByTestId("tool-step")
  expect(step.getAttribute("data-status")).toBe("success")
  expect(within(step).getByRole("button", { expanded: true })).toBeTruthy()
  expect(step.textContent).toContain("Hacker News")
})

test("a finished tool step starts open, so its result reads without a click", () => {
  render(
    <Transcript
      steps={[
        { kind: "user", text: "Read it.", at: 1 },
        { kind: "tool", callId: "read-1", name: "read_text", input: { selector: "h1" }, result: { text: "Hacker News" }, at: 2 }
      ]}
      state="idle"
    />
  )

  const step = screen.getByTestId("tool-step")
  expect(within(step).getByRole("button", { expanded: true })).toBeTruthy()
  expect(step.textContent).toContain("Hacker News")
})

test("a malformed ask_user call renders as a normal tool step", () => {
  render(
    <Transcript
      steps={[
        { kind: "user", text: "Redesign this page.", at: 1 },
        {
          kind: "tool",
          callId: "bad-question",
          name: "ask_user",
          input: { question: "Which layout?", options: [{ id: "only", label: "Only choice" }] },
          at: 2
        }
      ]}
      state="working"
    />
  )

  expect(screen.getByTestId("tool-step").textContent).toContain("ask_user")
  expect(screen.queryByLabelText("Question")).toBeNull()
})

test("only crew tool calls show bots and their action names include the destination", () => {
  render(
    <Transcript
      mascot={{ seed: "root-bot", variant: 0 }}
      steps={[
        { kind: "user", text: "Update the page.", at: 1 },
        {
          kind: "tool",
          callId: "styles-1",
          name: "apply_styles",
          input: { css: "body { color: red; }" },
          result: { ok: true },
          at: 2
        },
        {
          kind: "tool",
          callId: "message-1",
          name: "send_agent",
          input: { to: "checkout-bot", message: "The tokens are ready." },
          result: { ok: true },
          at: 3
        },
        {
          kind: "tool",
          callId: "spawn-1",
          name: "spawn_agent",
          input: { brief: "Fix the layout." },
          result: { id: "layout-bot", status: "working" },
          at: 4
        },
        {
          kind: "tool",
          callId: "await-1",
          name: "await_agents",
          input: { agentIds: ["layout-bot", "copy-bot", "layout-bot"] },
          result: { outputs: {} },
          at: 5
        },
        { kind: "assistant", text: "Done.", at: 6 }
      ]}
      state="idle"
    />
  )

  const styles = screen.getByRole("button", { name: /Apply styles/ })
  const message = screen.getByRole("button", { name: /Messaging/ })
  expect(within(styles).queryByTestId("tool-bots")).toBeNull()
  expect(within(message).getByRole("img", { name: "Destination bot checkout-bot" })).toBeTruthy()
  expect(screen.getAllByRole("img", { name: "Destination bot layout-bot" })).toHaveLength(2)
  expect(screen.getByRole("img", { name: "Destination bot copy-bot" })).toBeTruthy()
})

test("a live tool call shows its destination bot", () => {
  render(
    <Transcript
      mascot={{ seed: "root-bot" }}
      steps={[
        { kind: "user", text: "Check with the layout bot.", at: 1 },
        {
          kind: "tool",
          callId: "message-live",
          name: "send_agent",
          input: { to: "layout-bot", message: "Are you done?" },
          at: 2
        }
      ]}
      state="working"
    />
  )

  expect(screen.getByRole("img", { name: "Destination bot layout-bot" })).toBeTruthy()
})

test("an overflowing run shows a rail that jumps between messages", async () => {
  const restore = stubOverflow()
  try {
    render(
      <div style={{ height: 240 }}>
        <Transcript steps={STEPS} state="idle" />
      </div>
    )

    expect(await screen.findByRole("navigation", { name: "Message navigation" })).toBeTruthy()
    const ticks = await waitFor(() => {
      const buttons = screen.getAllByRole("button", { name: /Go to (user|assistant) message/ })
      expect(buttons).toHaveLength(6)
      return buttons
    })

    const rail = screen.getByRole("navigation", { name: "Message navigation" })
    expect(rail.className.split(" ")).toContain("right-1")
    expect(rail.className.split(" ")).not.toContain("left-0")

    expect(ticks[0]?.getAttribute("aria-label")).toBe("Go to user message 1 of 6")

    const viewport = screen.getByRole("region", { name: "Run" })
    expect(viewport.className.split(" ")).toContain("pr-10")
    expect(viewport.className.split(" ")).not.toContain("pl-6")
    expect(viewport.className.split(" ")).toContain("px-4")
    expect(viewport.className.split(" ")).toContain("py-5")
    const log = screen.getByRole("log")
    expect(log.className.split(" ")).toContain("min-h-full")
    expect(log.className.split(" ")).not.toContain("px-3")
    const firstMessage = screen.getByText("What should the first release include?").closest("[data-slot='message']")
    if (!(firstMessage instanceof HTMLElement)) throw new Error("missing first message")
    let scrollTop = 428
    const jumps: number[] = []
    Object.defineProperty(viewport, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        jumps.push(value)
        scrollTop = Math.max(0, value)
      }
    })
    viewport.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 200, width: 380, height: 240 })
    firstMessage.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: -200, width: 200, height: 40 })

    fireEvent.click(ticks[0]!)
    expect(jumps[0]).toBe(0)
    expect(viewport.scrollTop).toBe(0)
  } finally {
    restore()
  }
})
