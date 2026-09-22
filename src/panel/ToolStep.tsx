import type { ReactNode } from "react"
import { ToolResult, ToolResultOutput } from "@/components/agents/tool-result"
import { Icon } from "./Icon"
import type { ThreadMascotIdentity } from "./Mascot"
import { ToolBots } from "./ToolBots"
import { crewActionOf, partsOf, statusOf, viewOf, type ToolCall } from "./tools-view"

export interface ToolStepProps {
  call: ToolCall
  /** True while the turn runs, so a call without a result reads as running. */
  running: boolean
  mascot: ThreadMascotIdentity
}

/**
 * One tool call as a beUI disclosure: plain title and summary on the row; code, inputs
 * and result inside. A running call is the same step with no result yet, so the reader
 * watches the call in place instead of a one-line notice.
 */
export function ToolStep({ call, running, mascot }: ToolStepProps) {
  const view = viewOf(call.name)
  const status = statusOf(call, running)
  const parts = partsOf(call)
  const crewAction = crewActionOf(call.name)

  return (
    <div data-testid="tool-step" data-status={status} className="px-1">
      <ToolResult
        title={crewAction === undefined
          ? view.title
          : (
              <span className="inline-flex items-center gap-1.5">
                <span>{crewAction}</span>
                <ToolBots call={call} current={mascot} />
              </span>
            )}
        meta={parts.summary === "" ? undefined : parts.summary}
        icon={<Icon icon={view.icon} size={14} />}
        status={status}
        // Each call starts open, so its input shows while it runs and its result lands in
        // view. The fixed height keeps a long output from taking the transcript.
        defaultOpen
        collapseOnComplete={false}
        maxHeight={260}
        copyText={parts.code?.text}
        className="text-[13px]"
        contentClassName="space-y-3 p-2.5"
      >
        <div className="font-mono text-[11px] text-muted-foreground">{call.name}</div>
        {parts.code === undefined ? null : (
          <Block label={parts.code.label}>
            <ToolResultOutput language={parts.code.language}>{parts.code.text}</ToolResultOutput>
          </Block>
        )}
        {parts.inputs === undefined ? null : (
          <Block label="input">
            <ToolResultOutput language="json">{parts.inputs}</ToolResultOutput>
          </Block>
        )}
        {parts.result === undefined ? null : (
          <Block label="result">
            <ToolResultOutput language="json">{parts.result}</ToolResultOutput>
          </Block>
        )}
      </ToolResult>
    </div>
  )
}

function Block({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground/70">{label}</div>
      <div className="text-[11px] leading-4">{children}</div>
    </div>
  )
}
