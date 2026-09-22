import { LayoutGroup, motion, useReducedMotion } from "motion/react"
import type { ChatThread } from "@/session"
import { cn } from "@/lib/utils"
import { Add01Icon, Cancel01Icon } from "./icons"
import { ConfirmAction } from "./ConfirmAction"
import { Icon } from "./Icon"
import { botMascot, ThreadMascot } from "./Mascot"
import type { KeyboardEvent } from "react"

export interface ChatTabsProps {
  readonly threads: ReadonlyArray<ChatThread>
  readonly selected: string
  readonly onSelect: (id: string) => void
  readonly onNew: () => void
  readonly onClose: (id: string) => void
}

const nextIndex = (key: string, index: number, length: number): number | null => {
  if (key === "ArrowRight") return (index + 1) % length
  if (key === "ArrowLeft") return (index - 1 + length) % length
  if (key === "Home") return 0
  if (key === "End") return length - 1
  return null
}

const groupedThreads = (threads: ReadonlyArray<ChatThread>): ReadonlyArray<ChatThread> => {
  const byParent = new Map<string, ChatThread[]>()
  for (const thread of threads) {
    if (thread.parentId === undefined) continue
    const children = byParent.get(thread.parentId) ?? []
    children.push(thread)
    byParent.set(thread.parentId, children)
  }
  const ordered: ChatThread[] = []
  const add = (thread: ChatThread) => {
    ordered.push(thread)
    for (const child of byParent.get(thread.id) ?? []) add(child)
  }
  for (const thread of threads) {
    if (thread.parentId === undefined || !threads.some((candidate) => candidate.id === thread.parentId)) add(thread)
  }
  return ordered
}

/** Stable site threads. Each mascot gives a thread a fast visual identity. */
export function ChatTabs({ threads, selected, onSelect, onNew, onClose }: ChatTabsProps) {
  const reduce = useReducedMotion() ?? false
  const ordered = groupedThreads(threads)
  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = nextIndex(event.key, index, ordered.length)
    if (next === null) return
    event.preventDefault()
    const thread = ordered[next]
    const tabs = event.currentTarget.closest('[role="tablist"]')?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    tabs?.[next]?.focus()
    if (thread !== undefined) onSelect(thread.id)
  }
  return (
    <LayoutGroup>
      <nav aria-label="Chat threads" className="flex h-9 shrink-0 items-end bg-background shadow-[inset_0_-1px_0_var(--border)]">
        <div role="tablist" className="scrollbar-hide flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto px-2">
          {ordered.map((thread, index) => {
            const active = thread.id === selected
            return (
              <div
                key={thread.id}
                data-parent={thread.parentId}
                className={cn(
                  "group relative flex h-8 min-w-0 max-w-44 items-center rounded-t-[10px] pr-0.5",
                  thread.parentId !== undefined && "ml-2 border-l border-border",
                  active ? "bg-card" : "hover:bg-foreground/[0.05]"
                )}
              >
                <button
                  type="button"
                  role="tab"
                  id={active ? "active-chat-thread-tab" : undefined}
                  aria-selected={active}
                  aria-controls="chat-transcript"
                  tabIndex={active ? 0 : -1}
                  onClick={() => onSelect(thread.id)}
                  onKeyDown={(event) => move(event, index)}
                  className={cn(
                    "flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-2.5 text-xs outline-none",
                    active ? "font-medium text-foreground" : "text-muted-foreground group-hover:text-foreground",
                    "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  )}
                >
                  <motion.span animate={reduce ? undefined : { scale: active ? 1 : 0.88 }} transition={{ duration: 0.18 }}>
                    <ThreadMascot {...(thread.agentId === undefined ? { seed: thread.id, variant: index } : botMascot(thread.agentId))} />
                  </motion.span>
                  <span className="truncate">{thread.title}</span>
                </button>
                {thread.status !== undefined ? (
                  <span
                    aria-label={`${thread.title} is ${thread.status}`}
                    className={cn(
                      "mr-1 size-1.5 shrink-0 rounded-full",
                      thread.status === "working" && "animate-pulse bg-accent",
                      thread.status === "waiting" && "bg-warning",
                      thread.status === "done" && "bg-success",
                      (thread.status === "failed" || thread.status === "stopped") && "bg-destructive"
                    )}
                  />
                ) : null}
                <ConfirmAction
                  title="Clear this chat?"
                  detail="The look on the page stays."
                  confirmLabel="Clear"
                  onConfirm={() => onClose(thread.id)}
                  align="end"
                  trigger={
                    <button
                      type="button"
                      aria-label={`Clear ${thread.title}`}
                      className={cn(
                        "mr-1 grid size-5 shrink-0 place-items-center rounded-md text-muted-foreground outline-none transition-opacity hover:bg-foreground/[0.08] hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring",
                        active ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
                      )}
                    >
                      <Icon icon={Cancel01Icon} size={12} />
                    </button>
                  }
                />
                {active ? (
                  <motion.span
                    layoutId="active-chat-thread"
                    className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-foreground"
                    transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 520, damping: 38 }}
                  />
                ) : null}
              </div>
            )
          })}
        </div>
        <button
          type="button"
          aria-label="New chat"
          title="New chat"
          onClick={onNew}
          className="mr-2 mb-1 grid size-6 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-foreground/[0.07] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Icon icon={Add01Icon} size={15} />
        </button>
      </nav>
    </LayoutGroup>
  )
}
