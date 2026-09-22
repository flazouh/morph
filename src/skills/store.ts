import { Effect, Option, Schema } from "effect"
import { BUILT_IN_SKILLS } from "./bundled"
import {
  MAX_ENABLED_SKILL_CONTENT,
  MAX_SKILL_CONTENT,
  MAX_SKILL_TITLE,
  SkillFailure,
  SkillStorageFailure,
  type CustomSkillInput,
  type Skill,
  type SkillsError,
  type SkillsStore
} from "./contract"

const KEY = "skills-library-v1"

const StoredBuiltIn = Schema.Struct({
  enabled: Schema.Boolean
})
type StoredBuiltIn = typeof StoredBuiltIn.Type

const StoredCustom = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  content: Schema.String,
  enabled: Schema.Boolean,
  updatedAt: Schema.String
})
type StoredCustom = typeof StoredCustom.Type

const StoredSkills = Schema.Struct({
  builtIns: Schema.Record(Schema.String, StoredBuiltIn),
  custom: Schema.Array(StoredCustom)
})
type StoredSkills = typeof StoredSkills.Type

interface SkillsMemory {
  readonly read: Effect.Effect<unknown, SkillStorageFailure>
  readonly write: (value: StoredSkills) => Effect.Effect<void, SkillStorageFailure>
  readonly subscribe: (listener: () => void) => () => void
}

interface StoreDependencies {
  readonly id: () => string
  readonly now: () => string
}

const EMPTY: StoredSkills = { builtIns: {}, custom: [] }

const UnknownRecord = Schema.Record(Schema.String, Schema.Unknown)
const decodeRecord = Schema.decodeUnknownOption(UnknownRecord)
const decodeBuiltIn = Schema.decodeUnknownOption(StoredBuiltIn)
const decodeCustom = Schema.decodeUnknownOption(StoredCustom)

const stored = (raw: unknown): StoredSkills => {
  const root: Readonly<Record<string, unknown>> = Option.getOrElse(decodeRecord(raw), () => ({}))
  const rawBuiltIns: Readonly<Record<string, unknown>> = Option.getOrElse(
    decodeRecord(root["builtIns"]),
    () => ({})
  )
  const builtIns = Object.fromEntries(
    Object.entries(rawBuiltIns).flatMap(([id, value]) =>
      Option.match(decodeBuiltIn(value), {
        onNone: () => [],
        onSome: (item) => [[id, item]]
      })
    )
  )
  const custom = Array.isArray(root["custom"])
    ? root["custom"].flatMap((value): ReadonlyArray<StoredCustom> =>
        Option.match(decodeCustom(value), {
          onNone: () => [],
          onSome: (item) =>
            item.id === "" ||
            item.title.trim() === "" ||
            item.title.length > MAX_SKILL_TITLE ||
            item.content.trim() === "" ||
            item.content.length > MAX_SKILL_CONTENT
              ? []
              : [item]
        })
      )
    : []
  return { builtIns, custom }
}

const skillsOf = (raw: unknown): ReadonlyArray<Skill> => {
  const library = stored(raw)
  return [
    ...BUILT_IN_SKILLS.map((skill) => ({
      ...skill,
      enabled: library.builtIns[skill.id]?.enabled ?? true
    })),
    ...library.custom.map(
      (skill): Skill => ({
        ...skill,
        kind: "custom",
        summary: "Custom design guidance",
        version: 1
      })
    )
  ]
}

const customInput = (input: CustomSkillInput): Effect.Effect<CustomSkillInput, SkillFailure> => {
  const title = input.title.trim()
  const content = input.content.trim()
  if (title === "") return Effect.fail(new SkillFailure({ message: "Add a skill title.", field: "title" }))
  if (title.length > MAX_SKILL_TITLE) {
    return Effect.fail(
      new SkillFailure({
        message: `Keep the title at ${MAX_SKILL_TITLE} characters or fewer.`,
        field: "title"
      })
    )
  }
  if (content === "") {
    return Effect.fail(new SkillFailure({ message: "Add skill instructions.", field: "content" }))
  }
  if (content.length > MAX_SKILL_CONTENT) {
    return Effect.fail(
      new SkillFailure({
        message: `Keep the instructions at ${MAX_SKILL_CONTENT.toLocaleString()} characters or fewer.`,
        field: "content"
      })
    )
  }
  return Effect.succeed({ title, content })
}

const withinEnabledBudget = (skills: ReadonlyArray<Skill>): Effect.Effect<void, SkillFailure> => {
  const characters = skills.reduce((total, skill) => total + (skill.enabled ? skill.content.length : 0), 0)
  if (characters > MAX_ENABLED_SKILL_CONTENT) {
    return Effect.fail(
      new SkillFailure({
        message: `Enabled skills can contain up to ${MAX_ENABLED_SKILL_CONTENT.toLocaleString()} characters. Disable another skill first.`,
        field: "enabled"
      })
    )
  }
  return Effect.void
}

export const skillsStore = (
  memory: SkillsMemory,
  dependencies: StoreDependencies = {
    id: () => crypto.randomUUID(),
    now: () => new Date().toISOString()
  }
): SkillsStore => {
  const read: Effect.Effect<ReadonlyArray<Skill>, SkillStorageFailure> = memory.read.pipe(Effect.map(skillsOf))

  const write = Effect.fn("SkillsStore.write")((next: StoredSkills) =>
    Effect.gen(function* () {
      const skills = skillsOf(next)
      yield* withinEnabledBudget(skills)
      yield* memory.write(next)
      return skills
    })
  )

  const find = Effect.fn("SkillsStore.find")((id: string) =>
    Effect.gen(function* () {
      const raw = stored(yield* memory.read)
      const skill = skillsOf(raw).find((item) => item.id === id)
      if (skill === undefined) {
        return yield* new SkillFailure({ message: "This skill is no longer installed." })
      }
      return { raw, skill }
    })
  )

  return {
    read,
    create: Effect.fn("SkillsStore.create")((input) =>
      Effect.gen(function* () {
        const clean = yield* customInput(input)
        const raw = stored(yield* memory.read)
        const skill: StoredCustom = {
          id: dependencies.id(),
          ...clean,
          enabled: true,
          updatedAt: dependencies.now()
        }
        const next = yield* write({ ...raw, custom: [...raw.custom, skill] })
        const created = next.find((item) => item.id === skill.id)
        if (created === undefined) {
          return yield* new SkillStorageFailure({ message: "The new skill was not stored." })
        }
        return created
      })
    ),
    update: Effect.fn("SkillsStore.update")((id, input) =>
      Effect.gen(function* () {
        const clean = yield* customInput(input)
        const { raw, skill } = yield* find(id)
        if (skill.kind === "built-in") {
          return yield* new SkillFailure({ message: "Built-in skills are read-only." })
        }
        const next = yield* write({
          ...raw,
          custom: raw.custom.map((item) =>
            item.id === id ? { ...item, ...clean, updatedAt: dependencies.now() } : item
          )
        })
        const updated = next.find((item) => item.id === id)
        if (updated === undefined) {
          return yield* new SkillStorageFailure({ message: "The changed skill was not stored." })
        }
        return updated
      })
    ),
    setEnabled: Effect.fn("SkillsStore.setEnabled")((id, enabled) =>
      Effect.gen(function* () {
        const { raw, skill } = yield* find(id)
        return yield* skill.kind === "built-in"
          ? write({ ...raw, builtIns: { ...raw.builtIns, [id]: { enabled } } })
          : write({
              ...raw,
              custom: raw.custom.map((item) => (item.id === id ? { ...item, enabled } : item))
            })
      })
    ),
    remove: Effect.fn("SkillsStore.remove")((id) =>
      Effect.gen(function* () {
        const { raw, skill } = yield* find(id)
        if (skill.kind === "built-in") {
          return yield* new SkillFailure({ message: "Built-in skills cannot be removed." })
        }
        yield* write({ ...raw, custom: raw.custom.filter((item) => item.id !== id) })
      })
    ),
    subscribe: memory.subscribe
  }
}

export const chromeSkills: SkillsStore = skillsStore({
  read: Effect.tryPromise({
    try: () => chrome.storage.local.get(KEY),
    catch: () => new SkillStorageFailure({ message: "Skills could not be read." })
  }).pipe(Effect.map((values) => values[KEY])),
  write: (value) =>
    Effect.tryPromise({
      try: () => chrome.storage.local.set({ [KEY]: value }),
      catch: () => new SkillStorageFailure({ message: "Skills could not be saved." })
    }),
  subscribe: (listener) => {
    const on = (changes: Record<string, chrome.storage.StorageChange>) => {
      const change = changes[KEY]
      if (change !== undefined) listener()
    }
    chrome.storage.onChanged.addListener(on)
    return () => chrome.storage.onChanged.removeListener(on)
  }
})

export const memorySkills = (
  initial: unknown = EMPTY,
  dependencies?: StoreDependencies
): SkillsStore => {
  let current = initial
  const listeners = new Set<() => void>()
  return skillsStore(
    {
      read: Effect.sync(() => current),
      write: (value) =>
        Effect.sync(() => {
          current = value
          for (const listener of listeners) listener()
        }),
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    },
    dependencies
  )
}
