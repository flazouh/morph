import { useState } from "react"
import {
  ApprovalCard,
  type ApprovalCardAnswers,
  type ApprovalCardQuestion,
  type ApprovalCardStatus
} from "@/components/agents/approval-card"
import { isToolError } from "@/agent/tool-names"
import { PAGE_DRAFT_ID, questionOf, type AskUserQuestion } from "@/agent/question"
import type { ToolCall } from "./tools-view"

type SubmitAnswer = (callId: string, optionIds: ReadonlyArray<string>) => Promise<boolean>

export type AskUserCardProps = {
  readonly call: ToolCall
} & (
  | { readonly question: AskUserQuestion; readonly onAnswer?: SubmitAnswer }
  | {
      /** The design-system preview still parses its sample at this component boundary. */
      readonly question?: undefined
      readonly onAnswer?: (callId: string, optionIds: ReadonlyArray<string>) => void
    }
)

const selectedIds = (result: unknown): ReadonlyArray<string> => {
  const selected = (result as { selected?: unknown } | undefined)?.selected
  if (!Array.isArray(selected)) return []
  return selected.flatMap((option) =>
    typeof option === "object" &&
    option !== null &&
    typeof (option as { id?: unknown }).id === "string"
      ? [(option as { id: string }).id]
      : []
  )
}

export function AskUserCard({ call, question, onAnswer }: AskUserCardProps) {
  const parsed = question ?? questionOf(call.input)
  const answered = selectedIds(call.result)
  const [submitted, setSubmitted] = useState(call.result !== undefined)
  const [retry, setRetry] = useState(false)

  if ("error" in parsed) return null

  const id = call.callId
  const status: ApprovalCardStatus = isToolError(call.result)
    ? "rejected"
    : submitted || call.result !== undefined
      ? "answered"
      : "pending"
  const cardQuestion: ApprovalCardQuestion = {
    id,
    title: parsed.title ?? parsed.question,
    ...(parsed.description === undefined && parsed.title === undefined
      ? {}
      : {
          description: (
            <>
              {parsed.description === undefined ? null : <p>{parsed.description}</p>}
              {parsed.title === undefined ? null : (
                <p className={parsed.description === undefined ? "" : "mt-2"}>{parsed.question}</p>
              )}
            </>
          )
        }),
    ...(parsed.authorization === undefined && parsed.asciiPreview === undefined
      ? {}
      : {
          preview: (
            <div className="grid gap-2">
              {parsed.authorization === undefined ? null : (
                <dl className="grid gap-1 rounded-xl bg-background/75 p-3 text-xs leading-5">
                  <div>
                    <dt className="inline text-muted-foreground">Release: </dt>
                    <dd className="inline text-foreground">
                      {parsed.authorization.name} ({parsed.authorization.slug}@{parsed.authorization.version})
                    </dd>
                  </div>
                  <div>
                    <dt className="inline text-muted-foreground">Summary: </dt>
                    <dd className="inline text-foreground">{parsed.authorization.summary}</dd>
                  </div>
                  {parsed.authorization.draftId === PAGE_DRAFT_ID ? (
                    <div>
                      <dt className="inline text-muted-foreground">Source: </dt>
                      <dd className="inline text-foreground">this thread's redesign, as a new Morph</dd>
                    </div>
                  ) : (
                    <div>
                      <dt className="inline text-muted-foreground">Added permissions: </dt>
                      <dd className="inline text-foreground">
                        {parsed.authorization.addedPermissions.length === 0
                          ? "none"
                          : parsed.authorization.addedPermissions.join(", ")}
                      </dd>
                    </div>
                  )}
                </dl>
              )}
              {parsed.asciiPreview === undefined ? null : (
                <pre className="overflow-x-auto rounded-xl bg-background/75 p-3 font-mono text-[11px] leading-4 text-foreground">
                  {parsed.asciiPreview}
                </pre>
              )}
            </div>
          )
        }),
    options: parsed.options.map((option) => ({
      value: option.id,
      label: option.label,
      ...(option.description === undefined ? {} : { description: option.description })
    })),
    multiple: parsed.allowMultiple,
    autoAdvance: false
  }
  const defaultAnswers: ApprovalCardAnswers = {
    [id]: { selected: [...answered], custom: "" }
  }
  const result = isToolError(call.result)
    ? call.result.error
    : answered.length === 0
      ? "Response sent to the agent."
      : `Selected: ${parsed.options
          .filter((option) => answered.includes(option.id))
          .map((option) => option.label)
          .join(", ")}`

  return (
    <div>
      <ApprovalCard
        questions={[cardQuestion]}
        status={status}
        defaultAnswers={defaultAnswers}
        submitLabel={parsed.allowMultiple ? "Continue" : "Submit response"}
        result={result}
        onAnswersChange={() => setRetry(false)}
        onSubmit={(answers) => {
          if (onAnswer === undefined) return
          // Drawn as answered at once; the run's verdict reopens the card when it says no.
          setSubmitted(true)
          setRetry(false)
          void Promise.resolve(onAnswer(call.callId, answers[id]?.selected ?? [])).then((accepted) => {
            if (accepted === false) {
              setSubmitted(false)
              setRetry(true)
            }
          })
        }}
        className="border border-border bg-card"
      />
      {retry && call.result === undefined ? (
        <p role="alert" className="mt-2 text-xs leading-5 text-destructive">
          That answer did not go through. The question may have changed. Try again.
        </p>
      ) : null}
    </div>
  )
}
