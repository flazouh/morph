"use client";
// beui.dev/components/agents/todo-list

import { Check, ChevronDown, Circle, X } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { AgentDisclosure } from "@/components/agents/agent-disclosure";
import { EASE_OUT, SPRING_LAYOUT, SPRING_SWAP } from "@/lib/ease";
import { cn } from "@/lib/utils";

export type TodoItemStatus =
  | "pending"
  | "in-progress"
  | "completed"
  | "cancelled";

export interface TodoItem {
  id: string;
  title: ReactNode;
  status?: TodoItemStatus;
  progress?: number;
  detail?: ReactNode;
}

export interface TodoListProps {
  items: TodoItem[];
  title?: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  collapseOnComplete?: boolean;
  maxHeight?: number;
  className?: string;
}

function statusLabel(status: TodoItemStatus) {
  if (status === "in-progress") return "In progress";
  if (status === "completed") return "Completed";
  if (status === "cancelled") return "Cancelled";
  return "Pending";
}

function TodoStatusIcon({ status }: { status: TodoItemStatus }) {
  if (status === "completed") {
    return <Check className="size-4 text-emerald-500" strokeWidth={2} />;
  }
  if (status === "cancelled") {
    return <X className="size-4 text-rose-500" strokeWidth={2} />;
  }
  if (status === "in-progress") {
    return (
      <span className="relative grid size-4 place-items-center">
        <motion.span
          className="absolute inset-0 rounded-full bg-foreground/10"
          animate={{ opacity: [0.35, 0.8, 0.35] }}
          transition={{ duration: 1.5, repeat: Number.POSITIVE_INFINITY }}
        />
        <span className="size-1.5 rounded-full bg-foreground/70" />
      </span>
    );
  }
  return <Circle className="size-3.5 text-muted-foreground/70" strokeWidth={1.6} />;
}

export function TodoList({
  items,
  title = "To-dos",
  open,
  defaultOpen = true,
  onOpenChange,
  collapseOnComplete = true,
  maxHeight = 248,
  className,
}: TodoListProps) {
  const reduce = useReducedMotion() ?? false;
  const baseId = useId();
  const triggerId = `${baseId}-trigger`;
  const contentId = `${baseId}-content`;
  const previousComplete = useRef(false);
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const currentOpen = open ?? internalOpen;
  const completed = items.filter((item) => item.status === "completed").length;
  const allComplete = items.length > 0 && completed === items.length;

  const setOpen = useCallback(
    (next: boolean) => {
      if (open === undefined) setInternalOpen(next);
      onOpenChange?.(next);
    },
    [onOpenChange, open],
  );

  useEffect(() => {
    if (previousComplete.current && !allComplete) setOpen(true);
    if (!previousComplete.current && allComplete && collapseOnComplete) setOpen(false);
    previousComplete.current = allComplete;
  }, [allComplete, collapseOnComplete, setOpen]);

  return (
    <div className={cn("w-full text-sm", className)}>
      <button
        id={triggerId}
        type="button"
        aria-expanded={currentOpen}
        aria-controls={contentId}
        onClick={() => setOpen(!currentOpen)}
        className="group flex h-9 w-full items-center gap-2 rounded-xl px-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {completed} of {items.length}
        </span>
        <motion.span
          aria-hidden="true"
          animate={{ rotate: currentOpen ? 180 : 0 }}
          transition={reduce ? { duration: 0 } : SPRING_SWAP}
          className="text-muted-foreground/50 group-hover:text-muted-foreground"
        >
          <ChevronDown className="size-3.5" />
        </motion.span>
      </button>

      <AgentDisclosure id={contentId} role="region" aria-labelledby={triggerId} open={currentOpen}>
        <ul
          className="space-y-0.5 overflow-y-auto px-1 pb-1"
          style={{ maxHeight }}
        >
          <AnimatePresence initial={false} mode="popLayout">
            {items.length === 0 ? (
              <li className="px-1.5 py-1 text-muted-foreground">No tasks yet</li>
            ) : (
              items.map((item) => {
                const status = item.status ?? "pending";
                return (
                  <motion.li
                    layout="position"
                    key={item.id}
                    initial={reduce ? { opacity: 1 } : { opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={reduce ? { opacity: 0 } : { opacity: 0, y: -3 }}
                    transition={
                      reduce
                        ? { duration: 0 }
                        : {
                            opacity: { duration: 0.18, ease: EASE_OUT },
                            y: SPRING_LAYOUT,
                            layout: SPRING_LAYOUT,
                          }
                    }
                    className="flex min-h-8 items-start gap-2.5 rounded-xl px-1.5 py-1"
                  >
                    <span aria-hidden="true" className="mt-0.5 grid size-4 shrink-0 place-items-center">
                      <TodoStatusIcon status={status} />
                    </span>
                    <span className="sr-only">{statusLabel(status)}:</span>
                    <span
                      className={cn(
                        "min-w-0 flex-1 leading-5",
                        status === "pending" && "text-muted-foreground/70",
                        status === "cancelled" && "text-muted-foreground line-through",
                        status === "completed" && "text-muted-foreground",
                      )}
                    >
                      {item.title}
                    </span>
                  </motion.li>
                );
              })
            )}
          </AnimatePresence>
        </ul>
      </AgentDisclosure>
    </div>
  );
}
