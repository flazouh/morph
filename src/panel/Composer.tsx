import { Paperclip } from "lucide-react"
import { forwardRef, useImperativeHandle, useRef } from "react"
import { PromptInput } from "@/components/agents/prompt-input"
import { readTextFiles, withFiles } from "./files"
import { ModelPicker } from "./ModelPicker"
import type { CatalogModel } from "./models"
import { spendDetail, spendLabel } from "./spend"
import type { Spend } from "@/session"

export interface ComposerProps {
  value: string
  onValueChange: (value: string) => void
  /** No session: the form waits. */
  disabled: boolean
  working: boolean
  onSend: (text: string) => void
  onStop: () => void
  onSteer: (text: string) => void
  models: ReadonlyArray<CatalogModel>
  model: string
  onModelChange: (model: string) => void
  /** What this page's run has cost so far, drawn beside the model. */
  spend: Spend
}

/** The beUI prompt input, with the model picker and a file picker. The ref is the textarea. */
export const Composer = forwardRef<HTMLTextAreaElement, ComposerProps>(function Composer(
  { value, onValueChange, disabled, working, onSend, onStop, onSteer, models, model, onModelChange, spend },
  ref
) {
  const input = useRef<HTMLTextAreaElement | null>(null)
  const files = useRef<HTMLInputElement | null>(null)
  const draft = useRef(value)
  draft.current = value
  useImperativeHandle(ref, () => input.current as HTMLTextAreaElement, [])
  const price = spendLabel(spend)

  return (
    <>
      <PromptInput
        inputRef={input}
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        aria-label="Message"
        placeholder={working ? "Steer this turn…" : "Describe the change"}
        loading={working}
        onStop={onStop}
        onSteer={(text) => {
          onSteer(text)
          onValueChange("")
        }}
        stopButtonClassName="bg-[#FC6B83] text-[#1A0B0E] hover:bg-[#FC6B83]/90"
        modelSlot={
          <ModelPicker models={models} value={model} onChange={onModelChange} disabled={disabled || working} />
        }
        actions={[
          {
            value: "file",
            label: "Add a file",
            description: "Attach a text file to this message",
            icon: <Paperclip />
          }
        ]}
        onAction={(name) => {
          if (name === "file") files.current?.click()
        }}
        onSubmit={(text) => {
          onSend(text)
          onValueChange("")
        }}
        trailing={
          price === "" ? null : (
            <span
              data-testid="spend"
              title={spendDetail(spend)}
              className="shrink-0 px-1.5 font-mono text-[11px] tabular-nums text-muted-foreground"
            >
              {price}
            </span>
          )
        }
      />
      <input
        ref={files}
        type="file"
        multiple
        hidden
        data-testid="file-picker"
        aria-label="Attach files"
        accept=".txt,.md,.json,.css,.ts,.tsx,.js,.jsx,.html,.svg,.csv"
        onChange={(event) => {
          const list = event.target.files
          event.target.value = ""
          if (list === null || list.length === 0) return
          void readTextFiles(list).then((picked) => {
            if (picked.length === 0) return
            onValueChange(withFiles(draft.current, picked))
          })
        }}
      />
    </>
  )
})
