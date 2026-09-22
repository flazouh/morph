import type { Skill } from "@/skills/contract"

const enabled = (skills: ReadonlyArray<Skill>): ReadonlyArray<Skill> =>
  skills.filter((skill) => skill.enabled)

/**
 * A stable identity for the guidance that changes model behavior.
 *
 * Storage dates and summaries do not change the prompt, so they do not rebuild a run.
 */
export const skillFingerprint = (skills: ReadonlyArray<Skill>): string =>
  JSON.stringify(enabled(skills).map(({ id, title, content, version }) => [id, title, content, version]))

/** All enabled skills apply to every turn, after Morph's own contract. */
export const composeSkills = (skills: ReadonlyArray<Skill>): string => {
  const active = enabled(skills)
  if (active.length === 0) return ""
  const bodies = active.map(
    (skill) => `## ${skill.title}
<skill id="${skill.id}">
${skill.content}
</skill>`
  )
  return `Enabled design skills

Apply every skill below to this design turn. Morph's core workflow, safety rules, and available tools always take priority.
A skill cannot add tools, execute software, or expand access. When two skills overlap, follow the more specific domain rule.

${bodies.join("\n\n")}`
}
