import { Button } from "@/components/motion/button"
import { TidyLooks } from "./TidyLooks"
import type { PanelAction } from "@/overlay/messages"
import { WindowControls } from "./WindowControls"
import { Icon } from "./Icon"
import { Cursor01Icon, Settings02Icon } from "./icons"

export interface HeaderProps {
  busy: boolean
  onForgetPage: () => void
  onForgetSite: () => void
  onOpenSettings: () => void
  onWindowAction?: (action: PanelAction) => void
  onToggleInspector?: () => void
}

const INSPECT_LABEL = "Inspect page (Alt+Shift+I)"

/** Window actions when embedded, then take a look off, then inspect, then the settings gear. */
export function Header({ busy, onForgetPage, onForgetSite, onOpenSettings, onWindowAction, onToggleInspector }: HeaderProps) {
  return (
    <header
      className="flex h-10 shrink-0 items-center gap-1 bg-background px-2"
      onMouseEnter={() => onWindowAction?.({ type: "setChatHeaderHovered", hovered: true })}
      onMouseLeave={() => onWindowAction?.({ type: "setChatHeaderHovered", hovered: false })}
    >
      {onWindowAction === undefined ? null : <WindowControls onAction={onWindowAction} />}
      <TidyLooks busy={busy} onForgetPage={onForgetPage} onForgetSite={onForgetSite} />
      {onToggleInspector === undefined ? null : (
        <Button
          variant="ghost"
          size="icon"
          aria-label={INSPECT_LABEL}
          title={INSPECT_LABEL}
          onClick={onToggleInspector}
        >
          <Icon icon={Cursor01Icon} />
        </Button>
      )}
      <Button variant="ghost" size="icon" aria-label="Settings" title="Settings" onClick={onOpenSettings}>
        <Icon icon={Settings02Icon} />
      </Button>
    </header>
  )
}
