import { expect, test } from "bun:test"
import { Effect } from "effect"
import { BUILT_IN_SKILLS } from "./bundled"
import { MAX_SKILL_CONTENT, MAX_SKILL_TITLE, SkillFailure } from "./contract"
import { memorySkills } from "./store"

test("a new library contains the complete enabled starter set", async () => {
  const store = memorySkills()
  const skills = await Effect.runPromise(store.read)

  expect(skills.map((skill) => skill.id)).toEqual(BUILT_IN_SKILLS.map((skill) => skill.id))
  expect(skills.every((skill) => skill.kind === "built-in" && skill.enabled)).toBe(true)
})

test("a stored built-in choice survives later reads", async () => {
  const store = memorySkills()
  await Effect.runPromise(store.setEnabled("motion-craft", false))

  expect((await Effect.runPromise(store.read)).find((skill) => skill.id === "motion-craft")?.enabled).toBe(false)
})

test("a custom skill can be created, changed, disabled, and removed", async () => {
  const store = memorySkills({}, { id: () => "custom-1", now: () => "2026-09-09T18:00:00.000Z" })
  const created = await Effect.runPromise(
    store.create({ title: "Editorial tables", content: "Use quiet rules and aligned numbers." })
  )

  expect(created).toMatchObject({
    id: "custom-1",
    kind: "custom",
    enabled: true,
    title: "Editorial tables",
    updatedAt: "2026-09-09T18:00:00.000Z"
  })

  await Effect.runPromise(
    store.update("custom-1", { title: "Data tables", content: "Align numbers and keep rules quiet." })
  )
  await Effect.runPromise(store.setEnabled("custom-1", false))
  expect((await Effect.runPromise(store.read)).at(-1)).toMatchObject({
    id: "custom-1",
    title: "Data tables",
    content: "Align numbers and keep rules quiet.",
    enabled: false
  })

  await Effect.runPromise(store.remove("custom-1"))
  expect((await Effect.runPromise(store.read)).some((skill) => skill.id === "custom-1")).toBe(false)
})

test("built-in content is read-only and built-ins cannot be removed", async () => {
  const store = memorySkills()

  await expect(
    Effect.runPromise(store.update("art-direction", { title: "Changed", content: "Changed" }))
  ).rejects.toBeInstanceOf(SkillFailure)
  await expect(Effect.runPromise(store.remove("art-direction"))).rejects.toBeInstanceOf(SkillFailure)
})

test("custom fields reject empty and oversized values", async () => {
  const store = memorySkills()

  await expect(Effect.runPromise(store.create({ title: " ", content: "Useful" }))).rejects.toMatchObject({ field: "title" })
  await expect(Effect.runPromise(store.create({ title: "Useful", content: " " }))).rejects.toMatchObject({ field: "content" })
  await expect(Effect.runPromise(store.create({ title: "x".repeat(MAX_SKILL_TITLE + 1), content: "Useful" }))).rejects.toMatchObject({
    field: "title"
  })
  await expect(Effect.runPromise(store.create({ title: "Useful", content: "x".repeat(MAX_SKILL_CONTENT + 1) }))).rejects.toMatchObject({
    field: "content"
  })
})

test("old or malformed stored records do not replace the starter set", async () => {
  const store = memorySkills({
    builtIns: { "motion-craft": { enabled: false }, missing: { enabled: false } },
    custom: [
      { id: "kept", title: "Kept", content: "Useful guidance.", enabled: true, updatedAt: "then" },
      { id: "", title: "Broken", content: "", enabled: "yes" }
    ]
  })

  const skills = await Effect.runPromise(store.read)
  expect(skills.filter((skill) => skill.kind === "built-in")).toHaveLength(7)
  expect(skills.find((skill) => skill.id === "motion-craft")?.enabled).toBe(false)
  expect(skills.find((skill) => skill.id === "kept")).toMatchObject({ title: "Kept", kind: "custom" })
  expect(skills.some((skill) => skill.title === "Broken")).toBe(false)
})

test("subscribers receive the complete next library", async () => {
  const store = memorySkills()
  const seen: Array<ReadonlyArray<string>> = []
  const off = store.subscribe(() => {
    seen.push(["changed"])
  })

  await Effect.runPromise(store.setEnabled("typography", false))
  off()
  await Effect.runPromise(store.setEnabled("color-and-tokens", false))

  expect(seen).toHaveLength(1)
  expect(seen[0]).toEqual(["changed"])
})
