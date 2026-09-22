import { Cause, Option } from "effect"
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult"
import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/motion/button"
import { Input, type InputClassNames } from "@/components/motion/input"
import { Switch } from "@/components/motion/switch"
import {
  MAX_SKILL_CONTENT,
  MAX_SKILL_TITLE,
  SkillFailure,
  type CustomSkillInput,
  type Skill,
  type SkillsError,
  type SkillsStore
} from "@/skills/contract"
import { cn } from "@/lib/utils"
import { ConfirmAction } from "./ConfirmAction"
import { Icon } from "./Icon"
import { Add01Icon, ArrowLeft01Icon, Delete02Icon, Edit02Icon } from "./icons"
import { useSkills } from "./use-skills"

type SkillsView =
  | { readonly kind: "list" }
  | { readonly kind: "detail"; readonly id: string }
  | { readonly kind: "edit"; readonly id?: string }

const field: InputClassNames = {
  label: "px-0 text-xs text-muted-foreground",
  field: "h-9 rounded-lg border-0 bg-card focus-within:ring-2 focus-within:ring-ring/60",
  input: "px-2.5 text-[13px]"
}

export function SkillsSection({ store }: { readonly store: SkillsStore }) {
  const { skills, readError, command, run } = useSkills(store)
  const [view, setView] = useState<SkillsView>({ kind: "list" })
  const [actionError, setActionError] = useState<SkillsError | undefined>()
  const [pending, setPending] = useState<"save" | "remove" | undefined>()
  const handled = useRef(command)
  const selected = view.kind === "detail" || view.kind === "edit"
    ? skills?.find((skill) => skill.id === view.id)
    : undefined

  useEffect(() => {
    if (skills !== null && view.kind === "detail" && selected === undefined) setView({ kind: "list" })
  }, [selected, skills, view.kind])

  useEffect(() => {
    if (handled.current === command) return
    handled.current = command
    if (AsyncResult.isFailure(command) && !command.waiting) {
      setActionError(Option.getOrUndefined(Cause.findErrorOption(command.cause)))
      setPending(undefined)
      return
    }
    if (!AsyncResult.isSuccess(command) || command.waiting || pending === undefined) return
    setView(pending === "remove" ? { kind: "list" } : { kind: "detail", id: command.value.id })
    setPending(undefined)
  }, [command, pending])

  if (readError !== undefined) return <p role="alert" className="text-xs text-destructive">{readError.message}</p>
  if (skills === null) return <p className="text-xs text-muted-foreground">Loading skills…</p>
  if (view.kind === "edit") {
    return (
      <SkillEditor
        skill={selected}
        onCancel={() => setView(selected === undefined ? { kind: "list" } : { kind: "detail", id: selected.id })}
        error={actionError}
        saving={pending === "save" || command.waiting}
        onSave={(input) => {
          setActionError(undefined)
          setPending("save")
          run(
            selected === undefined
              ? { type: "create", input }
              : { type: "update", id: selected.id, input }
          )
        }}
      />
    )
  }
  if (view.kind === "detail" && selected !== undefined) {
    return (
      <SkillDetail
        skill={selected}
        onBack={() => setView({ kind: "list" })}
        onEdit={() => setView({ kind: "edit", id: selected.id })}
        onDelete={() => {
          setActionError(undefined)
          setPending("remove")
          run({ type: "remove", id: selected.id })
        }}
      />
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-sm font-medium text-foreground">Skills</h2>
          <p className="text-xs text-muted-foreground">Guidance the designer follows on every turn.</p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          aria-label="Add skill"
          onClick={() => setView({ kind: "edit" })}
          className="whitespace-nowrap"
        >
          <Icon icon={Add01Icon} size={14} />
          <span className="min-[480px]:hidden">Add</span>
          <span className="hidden min-[480px]:inline">Add skill</span>
        </Button>
      </div>

      <div className="overflow-hidden rounded-xl bg-card">
        {skills.map((skill, index) => (
          <div
            key={skill.id}
            className={cn(
              "flex min-h-14 items-center gap-3 px-3 py-2.5",
              index !== 0 && "border-t border-border"
            )}
          >
            <button
              type="button"
              aria-label={`Open ${skill.title}`}
              onClick={() => setView({ kind: "detail", id: skill.id })}
              className="min-w-0 flex-1 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            >
              <span className="block truncate text-[13px] font-medium text-foreground">{skill.title}</span>
              <span className="mt-0.5 block truncate text-xs text-muted-foreground">{skill.summary}</span>
            </button>
            <span className="shrink-0 rounded-md bg-background px-1.5 py-1 text-[10px] font-medium text-muted-foreground">
              {skill.kind === "built-in" ? "Built-in" : "Custom"}
            </span>
            <Switch
              checked={skill.enabled}
              onCheckedChange={(enabled) => {
                setActionError(undefined)
                run({ type: "set-enabled", id: skill.id, enabled })
              }}
              ariaLabel={`Enable ${skill.title}`}
              className="scale-75"
            />
          </div>
        ))}
      </div>
      {actionError === undefined ? null : <p role="alert" className="text-xs text-destructive">{actionError.message}</p>}
    </div>
  )
}

function SkillDetail({
  skill,
  onBack,
  onEdit,
  onDelete
}: {
  readonly skill: Skill
  readonly onBack: () => void
  readonly onEdit: () => void
  readonly onDelete: () => void
}) {
  return (
    <div className="flex flex-col gap-4">
      <Button variant="ghost" size="sm" onClick={onBack} className="self-start px-1.5">
        <Icon icon={ArrowLeft01Icon} size={14} />
        All skills
      </Button>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-medium text-foreground">{skill.title}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{skill.summary}</p>
        </div>
        {skill.kind === "custom" ? (
          <div className="flex shrink-0 gap-1">
            <Button variant="ghost" size="icon" aria-label={`Edit ${skill.title}`} onClick={onEdit}>
              <Icon icon={Edit02Icon} size={14} />
            </Button>
            <ConfirmAction
              title="Delete this skill?"
              detail="Its instructions will stop applying to new turns."
              confirmLabel="Delete"
              onConfirm={onDelete}
              trigger={
                <Button variant="ghost" size="icon" aria-label={`Delete ${skill.title}`}>
                  <Icon icon={Delete02Icon} size={14} />
                </Button>
              }
            />
          </div>
        ) : null}
      </div>
      {skill.source === undefined ? (
        <span className="text-xs text-muted-foreground">Created in Morph</span>
      ) : (
        <a
          href={skill.source.url}
          target="_blank"
          rel="noreferrer"
          className="self-start text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
        >
          {skill.source.label}
        </a>
      )}
      <div className="whitespace-pre-wrap rounded-xl bg-card p-3 text-xs leading-5 text-foreground">
        {skill.content}
      </div>
    </div>
  )
}

function SkillEditor({
  skill,
  onCancel,
  onSave,
  error,
  saving
}: {
  readonly skill?: Skill
  readonly onCancel: () => void
  readonly onSave: (input: CustomSkillInput) => void
  readonly error: SkillsError | undefined
  readonly saving: boolean
}) {
  const [title, setTitle] = useState(skill?.title ?? "")
  const [content, setContent] = useState(skill?.content ?? "")
  const titleError = error instanceof SkillFailure && error.field === "title" ? error.message : undefined
  const contentError = error instanceof SkillFailure && error.field === "content" ? error.message : undefined
  const formError = titleError === undefined && contentError === undefined ? error?.message : undefined

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        onSave({ title, content })
      }}
    >
      <div>
        <h2 className="text-sm font-medium text-foreground">{skill === undefined ? "Add skill" : "Edit skill"}</h2>
        <p className="mt-1 text-xs text-muted-foreground">These instructions apply to every design turn while enabled.</p>
      </div>
      <Input
        label="Title"
        value={title}
        onChange={setTitle}
        maxLength={MAX_SKILL_TITLE + 1}
        error={titleError}
        classNames={field}
      />
      <label className="flex flex-col gap-1.5">
        <span className="text-xs text-muted-foreground">Instructions</span>
        <textarea
          aria-label="Instructions"
          value={content}
          onChange={(event) => setContent(event.target.value)}
          maxLength={MAX_SKILL_CONTENT + 1}
          rows={12}
          className={cn(
            "min-h-48 resize-y rounded-xl border-0 bg-card p-3 text-[13px] leading-5 text-foreground outline-none",
            "placeholder:text-muted-foreground/60 focus-visible:ring-2 focus-visible:ring-ring/60",
            contentError !== undefined && "ring-2 ring-destructive/50"
          )}
        />
        {contentError === undefined ? null : <span role="alert" className="text-xs text-destructive">{contentError}</span>}
      </label>
      {formError === undefined ? null : <p role="alert" className="text-xs text-destructive">{formError}</p>}
      <div className="flex justify-end gap-1">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={saving}>
          {saving ? "Saving…" : "Save skill"}
        </Button>
      </div>
    </form>
  )
}
