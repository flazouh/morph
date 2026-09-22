import { Schema, type Effect } from "effect"

export const BUILT_IN_SKILL_IDS = [
  "art-direction",
  "layout-and-hierarchy",
  "typography",
  "color-and-tokens",
  "components-and-states",
  "responsive-accessibility",
  "motion-craft"
] as const

export const BuiltInSkillId = Schema.Literals(BUILT_IN_SKILL_IDS)
export type BuiltInSkillId = typeof BuiltInSkillId.Type

export const SkillKind = Schema.Literals(["built-in", "custom"])
export type SkillKind = typeof SkillKind.Type

export const SkillSource = Schema.Struct({
  label: Schema.String,
  url: Schema.String
})
export type SkillSource = typeof SkillSource.Type

export const Skill = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  summary: Schema.String,
  content: Schema.String,
  kind: SkillKind,
  enabled: Schema.Boolean,
  version: Schema.Int,
  updatedAt: Schema.String,
  source: Schema.optional(SkillSource)
})
export type Skill = typeof Skill.Type

export const BuiltInSkill = Schema.Struct({
  ...Skill.fields,
  id: BuiltInSkillId,
  kind: Schema.Literal("built-in"),
  source: SkillSource
})
export type BuiltInSkill = typeof BuiltInSkill.Type

export const CustomSkillInput = Schema.Struct({
  title: Schema.String,
  content: Schema.String
})
export type CustomSkillInput = typeof CustomSkillInput.Type

export const MAX_SKILL_TITLE = 64
export const MAX_SKILL_CONTENT = 12_000
export const MAX_ENABLED_SKILL_CONTENT = 48_000

export class SkillFailure extends Schema.TaggedError<SkillFailure>()("SkillFailure", {
  message: Schema.String,
  field: Schema.optional(Schema.Literals(["title", "content", "enabled"]))
}) {}

export class SkillStorageFailure extends Schema.TaggedError<SkillStorageFailure>()("SkillStorageFailure", {
  message: Schema.String
}) {}

export type SkillsError = SkillFailure | SkillStorageFailure

export interface SkillsStore {
  readonly read: Effect.Effect<ReadonlyArray<Skill>, SkillsError>
  readonly create: (input: CustomSkillInput) => Effect.Effect<Skill, SkillsError>
  readonly update: (id: string, input: CustomSkillInput) => Effect.Effect<Skill, SkillsError>
  readonly setEnabled: (id: string, enabled: boolean) => Effect.Effect<ReadonlyArray<Skill>, SkillsError>
  readonly remove: (id: string) => Effect.Effect<void, SkillsError>
  readonly subscribe: (listener: () => void) => () => void
}
