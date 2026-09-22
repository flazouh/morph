import { describe, expect, test } from "bun:test"
import { Effect, Queue } from "effect"
import type { Session, Step } from "../session/contract"
import { cursorHost, type CursorHost } from "./host"
import { isCursorAsk, type CursorAsk, type CursorUpdate } from "./messages"
import { BACKGROUND_SILENT, closeCursorThread, cursorProxySession, type CursorPort } from "./proxy"
import {
  forgetCursorThreadIn,
  json,
  liveStream,
  openCursorSession,
  PAGE,
  said,
  flakySteps,
  until,
  type Bridge,
  type Call,
  type Script
} from "./testing"
import { memoryCursorStorage, type CursorStepStorage, type CursorStorage } from "./state"

/**
 * The seam under test is the panel's message-based Session. A host owns the live sessions,
 * an in-memory port carries the messages both ways, and the assertions are what the panel
 * sees: steps, run state, and the Cursor requests the background did or did not make.
 */

interface Wired {
  readonly port: CursorPort
  readonly host: CursorHost
  readonly calls: Array<Call>
  readonly bridges: Array<Bridge>
  readonly storage: CursorStorage
  readonly opens: () => number
  /** How many panels are listening on the shared channel right now. */
  readonly listeners: () => number
  readonly panel: (threadId?: string) => Promise<Session>
  readonly restart: () => Promise<void>
}

const wire = (
  options: {
    readonly script?: Script
    readonly storage?: CursorStorage
    readonly stepStorage?: CursorStepStorage
  } = {}
): Wired => {
  const calls: Array<Call> = []
  const bridges: Array<Bridge> = []
  const storage = options.storage ?? memoryCursorStorage()
  const live = new Map<string, { close: () => Promise<void> }>()
  const listeners = new Set<(update: CursorUpdate) => void>()
  let opens = 0

  const makeHost = (): CursorHost =>
    cursorHost({
      open: async (input) => {
        opens += 1
        const opened = await openCursorSession({
          threadId: input.threadId,
          tabId: input.tabId,
          script: options.script,
          storage,
          calls,
          bridges,
          ...(options.stepStorage === undefined ? {} : { stepStorage: options.stepStorage })
        })
        live.set(input.threadId, { close: opened.close })
        return { session: opened.session, close: opened.close }
      },
      forget: (threadId) => forgetCursorThreadIn({ threadId, storage, calls, script: options.script }),
      publish: (update: CursorUpdate) => {
        for (const listener of [...listeners]) listener(update)
      }
    })

  let host = makeHost()
  const port: CursorPort = {
    // The wire is JSON: nothing but plain data crosses it, in either direction.
    ask: async (ask: CursorAsk) => {
      const message: unknown = JSON.parse(JSON.stringify(ask))
      if (!isCursorAsk(message)) throw new Error("the ask did not survive the wire")
      return JSON.parse(JSON.stringify(await host.handle(message))) as unknown
    },
    listen: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }

  return {
    port,
    get host() {
      return host
    },
    calls,
    bridges,
    storage,
    opens: () => opens,
    listeners: () => listeners.size,
    panel: (threadId = "thread-1") => cursorProxySession(port, { threadId, url: PAGE, tabId: 1 }),
    restart: async () => {
      await host.shutdown()
      host = makeHost()
    }
  }
}

const view = (session: Session): ReadonlyArray<Step> => session.steps()

/** A cloud agent asking for a tool, arriving on the bridge the way the relay delivers it. */
const toolCall = (
  bridge: Bridge,
  id: string,
  name: string,
  args: Record<string, unknown>
): Promise<void> =>
  Effect.runPromise(
    Effect.asVoid(
      Queue.offer(bridge.incoming, {
        type: "request",
        id,
        method: "tools/call",
        params: { name, arguments: args }
      })
    )
  )

describe("cursor background host and panel proxy", () => {
  test("a reopened panel shows the thread's persisted steps without starting a run", async () => {
    const wired = wire()
    const first = await wired.panel()
    await first.send("one")

    const second = await wired.panel()

    expect(said(view(second))).toEqual(["user:one", "assistant:Done."])
    expect(second.state()).toBe("idle")
    await wired.host.shutdown()
  })

  test("a reopened panel shows the thread's persisted Cursor spend", async () => {
    const wired = wire({
      script: {
        usage: () =>
          json(200, {
            totalUsage: {
              inputTokens: 120,
              outputTokens: 30,
              cacheReadTokens: 400,
              cacheWriteTokens: 50,
              totalTokens: 600
            },
            runs: []
          })
      }
    })
    const first = await wired.panel()
    await first.send("one")

    const second = await wired.panel()

    expect(second.spend()).toEqual({
      provider: "cursor",
      usd: 0,
      promptTokens: 120,
      completionTokens: 30,
      cacheReadTokens: 400,
      cacheWriteTokens: 50,
      totalTokens: 600,
      priced: 0
    })
    await wired.host.shutdown()
  })

  test("a send through the proxy streams the background run into the panel view", async () => {
    const live = liveStream()
    const wired = wire({ script: { stream: (signal) => live.respond(signal) } })
    const panel = await wired.panel()
    let changes = 0
    panel.subscribe(() => {
      changes += 1
    })
    const sending = panel.send("Restyle it")

    await until(() => panel.state() === "working", "the working state")
    live.push(`event: assistant\ndata: {"text":"Half"}\n\n`)
    await until(
      () => panel.turn().answerDraft === "Half",
      "the streamed text"
    )
    expect(said(view(panel))).toEqual(["user:Restyle it"])

    live.push(`event: assistant\ndata: {"text":" done."}\n\n`)
    live.push(`event: result\ndata: {"runId":"run-1","status":"FINISHED","text":"Half done."}\n\n`)
    live.push(`event: done\ndata: {}\n\n`)
    live.close()
    await sending

    expect(said(view(panel))).toEqual(["user:Restyle it", "assistant:Half done."])
    expect(panel.state()).toBe("idle")
    expect(changes).toBeGreaterThan(1)
    await wired.host.shutdown()
  })

  test("replacing the panel while a run is live keeps the run and the new panel joins it", async () => {
    const live = liveStream()
    const wired = wire({ script: { stream: (signal) => live.respond(signal) } })
    const first = await wired.panel()
    const sending = first.send("Restyle it")
    await until(() => first.state() === "working", "the working state")
    live.push(`event: assistant\ndata: {"text":"Half"}\n\n`)
    await until(() => first.turn().answerDraft === "Half", "the streamed text")

    const second = await wired.panel()

    expect(second.state()).toBe("working")
    expect(said(view(second))).toEqual(["user:Restyle it"])
    expect(second.turn().activityText).toBe("Half")

    live.push(`event: assistant\ndata: {"text":" done."}\n\n`)
    live.push(`event: result\ndata: {"runId":"run-1","status":"FINISHED","text":"Half done."}\n\n`)
    live.push(`event: done\ndata: {}\n\n`)
    live.close()
    await sending
    await until(() => second.state() === "idle", "the finished run in the second panel")

    expect(said(view(second))).toEqual(["user:Restyle it", "assistant:Half done."])
    expect(wired.opens()).toBe(1)
    expect(wired.calls.filter((call) => call.url === "https://api.cursor.com/v1/agents")).toHaveLength(1)
    await wired.host.shutdown()
  })

  test("stop through the proxy cancels the background run and keeps the settled steps", async () => {
    const live = liveStream()
    const wired = wire({ script: { stream: (signal) => live.respond(signal) } })
    const panel = await wired.panel()
    const sending = panel.send("Restyle it")
    await until(() => panel.state() === "working", "the working state")
    live.push(`event: assistant\ndata: {"text":"Half done."}\n\n`)
    await until(() => panel.turn().answerDraft === "Half done.", "the streamed text")

    await panel.stop()
    await sending

    expect(wired.calls.some((call) => call.url.endsWith("/runs/run-1/cancel"))).toBe(true)
    expect(said(view(panel))).toEqual(["user:Restyle it", "thinking:Half done."])
    expect(panel.state()).toBe("idle")
    await wired.host.shutdown()
  })

  test("an ask_user call from the cloud agent is answered by the panel and reaches the agent", async () => {
    const live = liveStream()
    const wired = wire({ script: { stream: (signal) => live.respond(signal) } })
    const panel = await wired.panel()
    const sending = panel.send("Restyle it")
    await until(() => panel.state() === "working", "the working state")
    await until(() => wired.bridges.length > 0, "the relay bridge")

    // The cloud agent asks. The call parks on the question; the panel sees a pending tool step.
    const asking = toolCall(wired.bridges[0]!, "call-1", "ask_user", {
      question: "Which layout?",
      options: [
        { id: "grid", label: "Grid" },
        { id: "list", label: "List" }
      ]
    })
    await until(
      () => view(panel).some((step) => step.kind === "tool" && step.name === "ask_user" && step.result === undefined),
      "the pending question step"
    )
    const callId = (view(panel).find((step) => step.kind === "tool" && step.name === "ask_user") as { callId: string }).callId

    // The reader answers. The parked call resolves, and the answer is the tool result.
    await expect(panel.answerQuestion(callId, ["list"])).resolves.toBe(true)
    await asking
    await until(
      () =>
        view(panel).some(
          (step) =>
            step.kind === "tool" &&
            step.name === "ask_user" &&
            JSON.stringify(step.result).includes("list")
        ),
      "the answered question step"
    )

    live.push(`event: result\ndata: {"runId":"run-1","status":"FINISHED","text":"Using the list."}\n\n`)
    live.push(`event: done\ndata: {}\n\n`)
    live.close()
    await sending
    expect(said(view(panel))).toEqual(["user:Restyle it", "tool:ask_user", "assistant:Using the list."])
    await wired.host.shutdown()
  })

  test("narration before a question and the answer after it both survive a status frame that ends the run first", async () => {
    // The frame order Cursor's stream showed live on 2026-09-12.
    const live = liveStream()
    const wired = wire({ script: { stream: (signal) => live.respond(signal) } })
    const panel = await wired.panel()
    const sending = panel.send("Restyle it")
    await until(() => panel.state() === "working", "the working state")
    await until(() => wired.bridges.length > 0, "the relay bridge")
    live.push(`event: status\ndata: {"runId":"run-1","status":"RUNNING"}\n\n`)
    live.push(`id: 1\nevent: thinking\ndata: {"text":"I will ask first."}\n\n`)
    live.push(`id: 2\nevent: assistant\ndata: {"text":"I'll ask you a quick header choice."}\n\n`)
    await until(() => panel.turn().answerDraft === "I'll ask you a quick header choice.", "the narration")

    const asking = toolCall(wired.bridges[0]!, "call-1", "ask_user", {
      question: "Dark or light?",
      options: [
        { id: "dark", label: "dark" },
        { id: "light", label: "light" }
      ]
    })
    await until(
      () => view(panel).some((step) => step.kind === "tool" && step.name === "ask_user" && step.result === undefined),
      "the pending question step"
    )
    const callId = (view(panel).find((step) => step.kind === "tool" && step.name === "ask_user") as { callId: string }).callId
    await expect(panel.answerQuestion(callId, ["light"])).resolves.toBe(true)
    await asking
    live.push(`id: 3\nevent: assistant\ndata: {"text":"You chose a light header."}\n\n`)
    await until(() => panel.turn().answerDraft === "You chose a light header.", "the answer segment")
    live.push(`event: status\ndata: {"runId":"run-1","status":"FINISHED"}\n\n`)
    live.push(`id: 4\nevent: result\ndata: {"runId":"run-1","status":"FINISHED","text":"You chose a light header."}\n\n`)
    live.push(`id: 5\nevent: done\ndata: {}\n\n`)
    live.close()
    await sending

    expect(said(view(panel))).toEqual([
      "user:Restyle it",
      "thinking:I will ask first.I'll ask you a quick header choice.",
      "tool:ask_user",
      "assistant:You chose a light header."
    ])
    await wired.host.shutdown()
  })

  test("a stale ask_user answer is false and the pending question stays parked", async () => {
    const live = liveStream()
    const wired = wire({ script: { stream: (signal) => live.respond(signal) } })
    const panel = await wired.panel()
    const sending = panel.send("Restyle it")
    await until(() => wired.bridges.length > 0, "the relay bridge")
    const asking = toolCall(wired.bridges[0]!, "call-1", "ask_user", {
      question: "Which?",
      options: [
        { id: "a", label: "A" },
        { id: "b", label: "B" }
      ]
    })
    await until(
      () => view(panel).some((step) => step.kind === "tool" && step.name === "ask_user"),
      "the pending question step"
    )

    // The worker holds the question, and its answer is the one the card acts on.
    await expect(panel.answerQuestion("no-such-call", ["a"])).resolves.toBe(false)
    // The question is still parked. Stopping the run cancels it.
    await panel.stop()
    await asking
    await sending
    await wired.host.shutdown()
  })

  test("a service worker that restarted re-attaches the thread instead of losing the send", async () => {
    const wired = wire()
    const panel = await wired.panel()
    await panel.send("one")
    await wired.restart()

    await panel.send("two")

    expect(said(view(panel))).toEqual(["user:one", "assistant:Done.", "user:two", "assistant:Done."])
    expect(wired.opens()).toBe(2)
    await wired.host.shutdown()
  })

  test("closing a thread archives its Cursor agent and drops its Cursor state", async () => {
    const wired = wire()
    const panel = await wired.panel()
    await panel.send("one")

    await closeCursorThread(wired.port, "thread-1")

    expect(wired.calls.some((call) => call.url.endsWith("/v1/agents/bc-1/archive"))).toBe(true)
    const reopened = await wired.panel()
    expect(view(reopened)).toEqual([])
    await reopened.send("two")
    expect(wired.calls.filter((call) => call.url === "https://api.cursor.com/v1/agents")).toHaveLength(2)
    await wired.host.shutdown()
  })

  test("closing a thread the background never opened still drops its Cursor state", async () => {
    const wired = wire()
    const panel = await wired.panel("thread-2")
    await panel.send("one")
    await wired.restart()

    await closeCursorThread(wired.port, "thread-2")

    const reopened = await wired.panel("thread-2")
    expect(view(reopened)).toEqual([])
    await wired.host.shutdown()
  })

  test("an archive Cursor refuses never reaches the panel as an error", async () => {
    const wired = wire({
      script: { archive: () => json(500, { error: { code: "internal_error", message: "boom" } }) }
    })
    const panel = await wired.panel()
    await panel.send("one")

    await closeCursorThread(wired.port, "thread-1")

    const reopened = await wired.panel()
    expect(view(reopened)).toEqual([])
    await wired.host.shutdown()
  })

  test("a background that does not answer is one error step, not a silent send", async () => {
    const wired = wire()
    const panel = await wired.panel()
    const port = wired.port
    const broken: CursorPort = {
      ask: async () => {
        throw new Error("Could not establish connection. Receiving end does not exist.")
      },
      listen: port.listen
    }
    const stranded = await cursorProxySession(port, { threadId: "thread-1", url: PAGE, tabId: 1 }).then(
      async () => cursorProxySession(broken, { threadId: "thread-3", url: PAGE, tabId: 1 }).catch(() => undefined)
    )

    expect(stranded).toBeUndefined()

    await panel.send("one")
    const half = await cursorProxySession(
      {
        ask: async (message) => (message.type === "cursor/attach" ? port.ask(message) : broken.ask(message)),
        listen: port.listen
      },
      { threadId: "thread-1", url: PAGE, tabId: 1 }
    )
    await half.send("two")

    expect(said(view(half)).at(-1)).toBe(`error:${BACKGROUND_SILENT}`)
    await wired.host.shutdown()
  })

  test("two panels attaching at once join one background session", async () => {
    const wired = wire()
    const [first, second] = await Promise.all([wired.panel(), wired.panel()])

    await first.send("one")

    expect(wired.opens()).toBe(1)
    await until(() => said(view(second)).length === 2, "the second panel's view")
    expect(said(view(second))).toEqual(["user:one", "assistant:Done."])
    await wired.host.shutdown()
  })

  test("a thread the background refuses to open reaches the panel as its own message", async () => {
    const listeners = new Set<(update: CursorUpdate) => void>()
    const host = cursorHost({
      open: () => Promise.reject(new Error("This thread is already active in a tab")),
      forget: async () => {},
      publish: (update) => {
        for (const listener of listeners) listener(update)
      }
    })
    const port: CursorPort = {
      ask: (message) => host.handle(message),
      listen: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    }

    const opening = cursorProxySession(port, { threadId: "thread-1", url: PAGE, tabId: 1 })

    expect(opening).rejects.toThrow("This thread is already active in a tab")
    await host.shutdown()
  })

  test("a disposed panel stops listening on the shared channel and redraws nothing", async () => {
    const wired = wire()
    const first = await wired.panel()
    let firstDraws = 0
    first.subscribe(() => {
      firstDraws += 1
    })
    const before = wired.listeners()

    await first.dispose?.()
    const second = await wired.panel()
    let secondDraws = 0
    second.subscribe(() => {
      secondDraws += 1
    })
    const drawsAfterDispose = firstDraws
    await second.send("one")

    // One panel listening, one panel drawing. A leaked listener shows as either count.
    expect(wired.listeners()).toBe(before)
    expect(secondDraws).toBeGreaterThan(0)
    expect(firstDraws).toBe(drawsAfterDispose)
    await wired.host.shutdown()
  })

  test("opening the same thread again and again leaves one listener behind", async () => {
    const wired = wire()
    const panels: Array<Session> = []
    for (let index = 0; index < 4; index += 1) {
      const panel = await wired.panel()
      panels.push(panel)
      if (index > 0) await panels[index - 1]!.dispose?.()
    }

    expect(wired.listeners()).toBe(1)
    await wired.host.shutdown()
  })

  test("a disposed panel releases the live background session and keeps the thread's history", async () => {
    const live = liveStream()
    const wired = wire({ script: { stream: (signal) => live.respond(signal) } })
    const panel = await wired.panel()
    const sending = panel.send("Restyle it")
    await until(() => panel.state() === "working", "the working state")
    live.push(`event: assistant\ndata: {"text":"Half done."}\n\n`)
    await until(() => panel.turn().answerDraft === "Half done.", "the streamed text")

    // The reader switched to OpenRouter. The Cursor side goes, its history stays.
    await panel.dispose?.()
    await sending

    // Nothing of the run is left: no socket, no tool gate, no reader.
    expect(wired.bridges.every((bridge) => bridge.closed)).toBe(true)
    // The agent is not archived, and the thread reads back whole on the way in again.
    expect(wired.calls.some((call) => call.url.endsWith("/archive"))).toBe(false)
    const back = await wired.panel()
    expect(said(view(back))).toEqual(["user:Restyle it", "thinking:Half done."])
    expect(wired.opens()).toBe(2)
    await wired.host.shutdown()
  })

  /**
   * A session that could not read a thread's history must not write one, so the history
   * survives the blind run. The reader's way back is a provider switch: to OpenRouter,
   * which releases the held session, and back to Cursor, which reads the thread again.
   */
  test("a blind run leaves the saved history whole, and a provider switch reads it again", async () => {
    const stepStorage = flakySteps()
    // One stream per run: the first applies the files, the second runs blind.
    const [first, second] = [liveStream(), liveStream()]
    const runs = [first, second]
    let taken = 0
    const wired = wire({
      stepStorage,
      script: { stream: (signal) => runs[taken++]!.respond(signal) }
    })
    const panel = await wired.panel()
    const sending = panel.send("Restyle it")
    await until(() => wired.bridges.length > 0, "the relay bridge")
    await toolCall(wired.bridges[0]!, "call-1", "apply_styles", { css: "body{color:red}" })
    await until(() => view(panel).filter((step) => step.kind === "tool").length === 1, "the styles step")
    await toolCall(wired.bridges[0]!, "call-2", "write_skin", {
      files: [{ path: "page.tsx", content: "export default () => null" }]
    })
    await until(() => view(panel).filter((step) => step.kind === "tool").length === 2, "the skin step")
    first.push(`event: result\ndata: {"runId":"run-1","status":"FINISHED","text":"Applied."}\n\n`)
    first.push(`event: done\ndata: {}\n\n`)
    first.close()
    await sending

    // The service worker stopped and woke, and the step store cannot answer for the thread.
    stepStorage.failLoads(1)
    await wired.restart()
    const blind = await wired.panel()
    const asking = blind.send("Restyle it again")
    await until(() => wired.bridges.length > 1, "the relay bridge after the failed read")
    await toolCall(wired.bridges[1]!, "call-3", "apply_styles", { css: "body{color:blue}" })
    await until(() => view(blind).filter((step) => step.kind === "tool").length === 1, "the blind styles step")
    second.push(`event: result\ndata: {"runId":"run-2","status":"FINISHED","text":"Applied again."}\n\n`)
    second.push(`event: done\ndata: {}\n\n`)
    second.close()
    await asking

    // The reader switches to OpenRouter, which releases the held session, and back to
    // Cursor, which opens a new one and reads the history again.
    await blind.dispose?.()
    const back = await wired.panel()

    // The thread is whole. The blind run's own steps are not in it, because a session
    // that could not read a thread's history is not allowed to write one.
    expect(said(view(back))).toEqual([
      "user:Restyle it",
      "tool:apply_styles",
      "tool:write_skin",
      "assistant:Applied."
    ])
    expect(wired.calls.some((request) => request.url.endsWith("/archive"))).toBe(false)
    await wired.host.shutdown()
  })

  test("only a Cursor ask is read off the extension message channel", () => {
    expect(isCursorAsk({ type: "installPackage", detail: {} })).toBe(false)
    expect(isCursorAsk({ type: "cursor/send" })).toBe(false)
    expect(isCursorAsk(undefined)).toBe(false)
    expect(isCursorAsk({ type: "cursor/send", threadId: "thread-1", text: "hi" })).toBe(true)
    expect(isCursorAsk({ type: "cursor/attach", threadId: "thread-1", url: PAGE, tabId: 1 })).toBe(true)
  })
})
