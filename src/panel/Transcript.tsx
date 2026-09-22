import { Alert02Icon } from "./icons"
import { AnimatePresence } from "motion/react"
import { useEffect, useState, type ReactNode } from "react"
import { questionOf, type AskUserQuestion } from "@/agent/question"
import { isToolError } from "@/agent/tool-names"
import { AgentActivity, type AgentActivityItem } from "@/components/agents/agent-activity"
import { ThinkingShimmer } from "@/components/agents/loading-states/thinking-shimmer"
import { Message, MessageContent, MessageGroup, type MessageFrom } from "@/components/agents/message"
import { MessageBubble, MessageBubbleContent, type MessageBubbleVariant } from "@/components/agents/message-bubble"
import { MessageScroller } from "@/components/agents/message-scroller"
import { AssistantMarkdown } from "@/components/agents/assistant-markdown"
import { StreamingResponse } from "@/components/agents/streaming-response"
import { IDLE_TURN, type Provider, type RunState, type Step, type TurnView } from "@/session"
import { lastLines, thoughtText } from "./activity"
import { EmptyState } from "./EmptyState"
import { Icon } from "./Icon"
import type { ThreadMascotIdentity } from "./Mascot"
import { ToolStep } from "./ToolStep"
import type { ToolCall } from "./tools-view"
import { AskUserCard } from "./AskUserCard"

export interface TranscriptProps {
  steps: ReadonlyArray<Step>
  turn?: TurnView
  state: RunState
  /** Who the run waits on when its stream goes quiet. */
  provider?: Provider
  mascot?: ThreadMascotIdentity
  onAnswerQuestion?: (callId: string, optionIds: ReadonlyArray<string>) => Promise<boolean>
}

const stepKey = (step: Step, index: number): string =>
  step.kind === "tool" ? `tool-${step.callId}` : `${step.kind}-${step.at}-${index}`

const lastAssistant = (steps: ReadonlyArray<Step>): Step | undefined =>
  steps.findLast((step) => step.kind === "assistant")

/** Each user message starts a turn. */
const turnsOf = (steps: ReadonlyArray<Step>): ReadonlyArray<ReadonlyArray<Step>> => {
  const turns: Array<ReadonlyArray<Step>> = []
  let start = 0
  for (let i = 0; i < steps.length; i++) {
    if (i > 0 && steps[i]?.kind === "user") {
      turns.push(steps.slice(start, i))
      start = i
    }
  }
  if (steps.length > 0) turns.push(steps.slice(start))
  return turns
}

const thoughtItem = (id: string, text: string): AgentActivityItem => ({
  id,
  type: "text",
  content: <span className="line-clamp-4 whitespace-pre-wrap break-words text-[13px] leading-5">{text}</span>
})

/** The live thought. A running tool is its own open step in the transcript, not a notice here. */
const liveItems = (turn: TurnView): AgentActivityItem[] => {
  const activity = lastLines(turn.activityText)
  return activity === "" ? [] : [thoughtItem("think-live", activity)]
}

const isTool = (step: Step): step is ToolCall => step.kind === "tool"

const isPlan = (step: Step): boolean => isTool(step) && step.name === "write_todos"

const askUserQuestionOf = (step: Step): AskUserQuestion | undefined => {
  if (!isTool(step) || step.name !== "ask_user") return undefined
  // A run that cannot carry a question answers with an error. Drawing that as a question
  // card would show a “Rejected” question nobody was asked; it is a failed tool call.
  if (isToolError(step.result)) return undefined
  const question = questionOf(step.input)
  return "error" in question ? undefined : question
}

const activityHeight = (items: ReadonlyArray<AgentActivityItem>): number => (items.length === 0 ? 0 : 96)

/**
 * A provider streams nothing while its model composes a tool call, and a large write_skin
 * takes minutes. After this long with no frame the label says so instead of "Writing…".
 */
const QUIET_AFTER_MS = 10_000

const PROVIDER_NAMES: Readonly<Record<Provider, string>> = { cursor: "Cursor", openrouter: "OpenRouter" }

/** The moment the live turn last changed in a way the reader can see. */
const useHeardAt = (live: TurnView | undefined): number => {
  const [heardAt, setHeardAt] = useState(() => Date.now())
  const callId = live?.activeTool?.callId
  useEffect(() => {
    setHeardAt(Date.now())
  }, [live?.phase, live?.activityText, callId])
  return heardAt
}

/** The phases where the run waits on the provider's next frame, with no tool in hand. */
const waitsOnProvider = (live: TurnView): boolean =>
  live.activeTool === undefined && (live.phase === "starting" || live.phase === "thinking" || live.phase === "answering")

const activeLabel = (live: TurnView, provider: Provider, heardAt: number, now: number): string =>
  waitsOnProvider(live) && now - heardAt > QUIET_AFTER_MS ? `Waiting for ${PROVIDER_NAMES[provider]}…` : phaseLabel(live.phase)

const phaseLabel = (phase: TurnView["phase"]): string => {
  switch (phase) {
    case "starting":
      return "Planning next moves…"
    case "thinking":
      return "Thinking…"
    case "runningTool":
      return "Running tools…"
    case "answering":
      return "Writing…"
    default:
      return ""
  }
}

const elapsedSeconds = (startedAt: number | undefined, now: number): number =>
  startedAt === undefined ? 0 : Math.max(0, (now - startedAt) / 1000)

/** Seconds since `startedAt`, advancing while `running`. */
const useElapsed = (running: boolean, startedAt: number | undefined): number => {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running || startedAt === undefined) return
    const id = window.setInterval(() => setNow(Date.now()), 100)
    return () => window.clearInterval(id)
  }, [running, startedAt])
  return elapsedSeconds(startedAt, now)
}

/** The run as a conversation. The view follows the live edge; the reader can scroll away. */
export function Transcript({
  steps,
  turn = IDLE_TURN,
  state,
  provider = "openrouter",
  mascot = { seed: "empty", variant: 0 },
  onAnswerQuestion
}: TranscriptProps) {
  const working = state === "working"
  const turns = turnsOf(steps)
  const liveTurn = turns[turns.length - 1]
  const startedAt = liveTurn?.find((step) => step.kind === "user")?.at
  const elapsed = useElapsed(working, startedAt)
  if (steps.length === 0 && !working) return <EmptyState mascot={mascot} />

  return (
    <MessageScroller
      label="Run"
      busy={working}
      navigation="rail"
      className="h-full"
      viewportClassName="h-full px-4 py-5"
      contentClassName="min-h-full"
    >
      <MessageGroup spacing="default">
        <AnimatePresence initial={false}>
          {turns.length === 0 && working ? <TurnBlock steps={[]} live={turn} working elapsed={elapsed} provider={provider} mascot={mascot} onAnswerQuestion={onAnswerQuestion} /> : null}
          {turns.map((turnSteps, index) => {
            const latest = index === turns.length - 1
            const live = working && latest
            const endedAt = turnSteps[turnSteps.length - 1]?.at
            const frozen = elapsedSeconds(turnSteps.find((step) => step.kind === "user")?.at, endedAt ?? 0)
            return <TurnBlock key={turnSteps[0] === undefined ? "empty" : stepKey(turnSteps[0], index)} steps={turnSteps} live={latest ? turn : undefined} working={live} elapsed={live ? elapsed : frozen} provider={provider} mascot={mascot} onAnswerQuestion={onAnswerQuestion} />
          })}
        </AnimatePresence>
      </MessageGroup>
    </MessageScroller>
  )
}

function TurnBlock({
  steps,
  live,
  working,
  elapsed,
  provider,
  mascot,
  onAnswerQuestion
}: {
  steps: ReadonlyArray<Step>
  live?: TurnView
  working: boolean
  elapsed: number
  provider: Provider
  mascot: ThreadMascotIdentity
  onAnswerQuestion?: (callId: string, optionIds: ReadonlyArray<string>) => Promise<boolean>
}) {
  const questions = new Map<string, AskUserQuestion>()
  for (const step of steps) {
    const question = askUserQuestionOf(step)
    if (question !== undefined && step.kind === "tool") questions.set(step.callId, question)
  }
  const paused = working && live?.activeTool?.name === "ask_user"
  const heardAt = useHeardAt(working ? live : undefined)
  const completedThought = lastLines(thoughtText(steps))
  const items = paused
    ? []
    : working && live !== undefined
      ? liveItems(live)
      : completedThought === ""
        ? []
        : [thoughtItem("think-done", completedThought)]
  const terminalSummary =
    !working &&
    !steps.some((step) => step.kind === "error") &&
    (live?.phase === "failed" || live?.phase === "stopped")
      ? live.phase === "failed"
        ? "Failed"
        : "Stopped"
      : undefined
  const showActivity = items.length > 0 || (working && !paused) || terminalSummary !== undefined
  const last = lastAssistant(steps)
  const answerKey = `answer-${steps.find((step) => step.kind === "user")?.at ?? last?.at ?? "live"}`
  const activity = showActivity ? (
    <Message key={working ? "activity-live" : `activity-${steps[0]?.at ?? "done"}`} from="assistant">
      <MessageContent>
        <AgentActivity
          items={items}
          contentType="text"
          status={working ? "working" : "complete"}
          duration={elapsed}
          activeLabel={live === undefined ? "" : activeLabel(live, provider, heardAt, Date.now())}
          summary={terminalSummary}
          maxHeight={activityHeight(items)}
          renderWorkingStatus={({ label, duration }) => (
            <>
              <ThinkingShimmer>{label}</ThinkingShimmer>
              <span className="ml-2 tabular-nums text-muted-foreground">{`${Math.floor(Math.max(0, duration))}s`}</span>
            </>
          )}
        />
      </MessageContent>
    </Message>
  ) : null

  return (
    <>
      {steps.map((step, i) => {
        if (step.kind === "tool") {
          const question = questions.get(step.callId)
          if (question !== undefined) {
            return (
              <Message key={stepKey(step, i)} from="assistant" animateIn>
                <MessageContent>
                  <AskUserCard call={step} question={question} onAnswer={onAnswerQuestion} />
                </MessageContent>
              </Message>
            )
          }
          return isPlan(step) ? null : <ToolStep key={stepKey(step, i)} call={step} running={working} mascot={mascot} />
        }
        if (step.kind === "thinking") return null
        const bubble = (
          <Bubble
            key={step.kind === "assistant" && step === last ? answerKey : stepKey(step, i)}
            kind={step.kind}
            text={step.text}
          />
        )
        return !working && step === last && activity !== null ? [activity, bubble] : bubble
      })}
      {working && completedThought !== "" ? (
        <Message from="assistant">
          <MessageContent>
            <AgentActivity
              items={[thoughtItem("think-prior", completedThought)]}
              contentType="text"
              status="complete"
              summary="Thought"
              defaultOpen={false}
            />
          </MessageContent>
        </Message>
      ) : null}
      {working || last === undefined ? activity : null}
    </>
  )
}

type Spoken = Exclude<Step["kind"], "tool" | "thinking">

interface Tone {
  readonly from: MessageFrom
  readonly variant: MessageBubbleVariant
  readonly className: string
  readonly icon?: ReactNode
  readonly role?: "alert"
}

/** How each spoken step looks: who says it, which bubble, and the one icon an error carries. */
const TONES: Readonly<Record<Exclude<Spoken, "assistant">, Tone>> = {
  user: { from: "user", variant: "solid", className: "max-w-[88%] rounded-2xl rounded-br-md px-3 py-2 text-[13px] leading-5" },
  error: {
    from: "assistant",
    variant: "danger",
    className: "max-w-full rounded-xl px-3 py-2 text-xs leading-5",
    icon: <Icon icon={Alert02Icon} size={14} className="mt-0.5 shrink-0" />,
    role: "alert"
  }
}

function Bubble({ kind, text, streaming = false }: { kind: Spoken; text: string; streaming?: boolean }) {
  if (kind === "assistant") {
    return (
      <Message from="assistant" animateIn>
        <MessageContent>
          <StreamingResponse
            status={streaming ? "streaming" : "complete"}
            copyText={text}
            announce={false}
            showActions={!streaming}
            contentClassName="break-words text-[13px] leading-5 [&_pre]:border-0 [&_pre]:bg-muted/55"
          >
            <AssistantMarkdown text={text} streaming={streaming} />
          </StreamingResponse>
        </MessageContent>
      </Message>
    )
  }

  const tone = TONES[kind]
  return (
    <Message from={tone.from} animateIn aria-label={kind === "error" ? "error" : undefined}>
      <MessageContent>
        <MessageBubble variant={tone.variant} role={tone.role} className={tone.className}>
          <MessageBubbleContent className="flex items-start gap-2 whitespace-pre-wrap break-words">
            {tone.icon}
            <span>{text}</span>
          </MessageBubbleContent>
        </MessageBubble>
      </MessageContent>
    </Message>
  )
}
