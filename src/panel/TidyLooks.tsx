import { useState } from "react"
import { Button } from "@/components/motion/button"
import { MorphPopover, MorphPopoverContent, MorphPopoverTrigger } from "@/components/motion/popover-morph"
import { ConfirmBody } from "./ConfirmAction"
import { Icon } from "./Icon"
import { Delete02Icon } from "./icons"

export interface TidyLooksProps {
  busy: boolean
  onForgetPage: () => void
  onForgetSite: () => void
}

type Step = "menu" | "page" | "site"

/** One trash control: take this page's look off, or the whole site's. */
export function TidyLooks({ busy, onForgetPage, onForgetSite }: TidyLooksProps) {
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState<Step>("menu")

  const close = () => {
    setOpen(false)
    setStep("menu")
  }

  return (
    <MorphPopover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setStep("menu")
      }}
    >
      <MorphPopoverTrigger>
        <Button variant="ghost" size="icon" aria-label="Take a look off" title="Take a look off" disabled={busy}>
          <Icon icon={Delete02Icon} size={14} />
        </Button>
      </MorphPopoverTrigger>
      <MorphPopoverContent side="bottom" align="end" radius={6} className="w-52 border-0 bg-card">
        {step === "menu" ? (
          <div className="flex flex-col gap-0.5 p-1">
            <p className="px-1.5 pt-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Take off</p>
            <button
              type="button"
              aria-label="This page"
              onClick={() => setStep("page")}
              className="flex w-full flex-col items-start gap-0 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-foreground/[0.05] focus-visible:bg-foreground/[0.05] focus-visible:outline-none"
            >
              <span className="text-xs font-medium text-foreground">This page</span>
              <span className="text-[10px] leading-4 text-muted-foreground">This URL only</span>
            </button>
            <button
              type="button"
              aria-label="This site"
              onClick={() => setStep("site")}
              className="flex w-full flex-col items-start gap-0 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-foreground/[0.05] focus-visible:bg-foreground/[0.05] focus-visible:outline-none"
            >
              <span className="text-xs font-medium text-foreground">This site</span>
              <span className="text-[10px] leading-4 text-muted-foreground">Whole host</span>
            </button>
          </div>
        ) : step === "page" ? (
          <ConfirmBody
            title="Remove this page's look?"
            detail="This URL goes back. Its saved repo files are removed too."
            confirmLabel="Remove"
            onConfirm={() => {
              onForgetPage()
              close()
            }}
            onKeep={() => setStep("menu")}
          />
        ) : (
          <ConfirmBody
            title="Remove this site's look?"
            detail="Every page on this host goes back. Its saved repo files are removed too."
            confirmLabel="Remove"
            onConfirm={() => {
              onForgetSite()
              close()
            }}
            onKeep={() => setStep("menu")}
          />
        )}
      </MorphPopoverContent>
    </MorphPopover>
  )
}
