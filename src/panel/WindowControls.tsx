import type { IconSvgElement } from "@hugeicons/react"
import type { PanelAction } from "@/overlay/messages"
import { cn } from "@/lib/utils"
import { Add01Icon, Cancel01Icon, MinusSignIcon } from "./icons"
import { Icon } from "./Icon"

type WindowControl = {
  readonly label: string
  readonly color: string
  readonly icon: IconSvgElement
  readonly iconClass: string
  readonly action: PanelAction
}

const CONTROLS: ReadonlyArray<WindowControl> = [
  {
    label: "Close chat",
    color: "bg-[#ff5f57]",
    icon: Cancel01Icon,
    iconClass: "-rotate-45",
    action: { type: "closeChat" }
  },
  {
    label: "Minimize chat",
    color: "bg-[#febc2e]",
    icon: MinusSignIcon,
    iconClass: "scale-x-50",
    action: { type: "minimizeChat" }
  },
  {
    label: "Expand chat",
    color: "bg-[#28c840]",
    icon: Add01Icon,
    iconClass: "rotate-45",
    action: { type: "toggleExpandedChat" }
  }
]

export function WindowControls({ onAction }: { readonly onAction: (action: PanelAction) => void }) {
  return (
    <div
      className="group/window-controls mt-2 mr-auto flex self-start items-center gap-1"
      role="group"
      aria-label="Chat window controls"
    >
      {CONTROLS.map((control) => (
        <WindowControlButton key={control.label} control={control} onAction={onAction} />
      ))}
    </div>
  )
}

function WindowControlButton({
  control,
  onAction
}: {
  readonly control: WindowControl
  readonly onAction: (action: PanelAction) => void
}) {
  return (
    <button
      type="button"
      aria-label={control.label}
      title={control.label}
      onClick={() => onAction(control.action)}
      className="group/window-dot grid size-4 shrink-0 place-items-center rounded-full text-black/65 outline-none focus-visible:ring-2 focus-visible:ring-foreground/50 focus-visible:ring-inset"
    >
      <span
        className={cn(
          "grid size-3 place-items-center rounded-full transition-transform duration-150 ease-out group-hover/window-dot:scale-110 group-active/window-dot:scale-95 motion-reduce:transform-none motion-reduce:transition-none",
          control.color
        )}
      >
        <Icon
          icon={control.icon}
          size={7}
          className={cn(
            "scale-50 opacity-0 transition-[opacity,scale,rotate] duration-150 ease-out group-hover/window-controls:rotate-0 group-hover/window-controls:scale-100 group-hover/window-controls:opacity-100 group-focus-visible/window-dot:rotate-0 group-focus-visible/window-dot:scale-100 group-focus-visible/window-dot:opacity-100 motion-reduce:transform-none motion-reduce:transition-none",
            control.iconClass
          )}
        />
      </span>
    </button>
  )
}
