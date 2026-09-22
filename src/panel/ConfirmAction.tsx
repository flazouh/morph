import { useState, type ReactElement } from "react"
import { Button } from "@/components/motion/button"
import { MorphPopover, MorphPopoverContent, MorphPopoverTrigger } from "@/components/motion/popover-morph"

export interface ConfirmActionProps {
  title: string
  detail: string
  confirmLabel: string
  onConfirm: () => void
  trigger: ReactElement
  side?: "top" | "bottom"
  align?: "start" | "end"
}

/** One control that asks before it does a destructive thing. */
export function ConfirmAction({ title, detail, confirmLabel, onConfirm, trigger, side = "bottom", align = "end" }: ConfirmActionProps) {
  const [open, setOpen] = useState(false)
  return (
    <MorphPopover open={open} onOpenChange={setOpen}>
      <MorphPopoverTrigger>{trigger}</MorphPopoverTrigger>
      <MorphPopoverContent side={side} align={align} radius={6} className="w-52 border-0 bg-card">
        <ConfirmBody
          title={title}
          detail={detail}
          confirmLabel={confirmLabel}
          onConfirm={() => {
            onConfirm()
            setOpen(false)
          }}
          onKeep={() => setOpen(false)}
        />
      </MorphPopoverContent>
    </MorphPopover>
  )
}

export function ConfirmBody({
  title,
  detail,
  confirmLabel,
  onConfirm,
  onKeep
}: {
  title: string
  detail: string
  confirmLabel: string
  onConfirm: () => void
  onKeep?: () => void
}) {
  return (
    <div className="flex flex-col gap-2 p-2">
      <div className="flex flex-col gap-0.5">
        <p className="text-xs font-medium tracking-tight text-foreground">{title}</p>
        <p className="text-[11px] leading-4 text-muted-foreground">{detail}</p>
      </div>
      <div className="flex justify-end gap-1">
        <Button type="button" variant="ghost" size="sm" onClick={onKeep}>
          Keep
        </Button>
        <Button type="button" variant="primary" size="sm" onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </div>
  )
}
