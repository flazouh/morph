import { describe, expect, test } from "bun:test"
import { briefFor, CREW_ROLE_NAMES, CREW_ROLES, roleOf } from "./roles"

describe("crew roles", () => {
  test("every role has a Cursor-safe name, a one-line description and a prompt that names Morph's tools", () => {
    for (const role of CREW_ROLES) {
      expect(role.name).toMatch(/^[a-z][a-z-]+$/)
      expect(["explore", "debug", "shell", "computerUse"]).not.toContain(role.name)
      expect(role.description).not.toContain("\n")
      expect(role.prompt).toMatch(/read_page/)
    }
    expect(new Set(CREW_ROLE_NAMES).size).toBe(CREW_ROLES.length)
  })

  test("the reading roles forbid every page write, and the region role forbids the whole-page ones", () => {
    for (const name of ["page-reader", "reviewer"]) {
      const prompt = roleOf(name)!.prompt
      for (const tool of ["apply_styles", "write_skin", "write_design", "run_script", "publish_morph"]) expect(prompt).toContain(tool)
      expect(prompt).toMatch(/writes? nothing/i)
    }
    const region = roleOf("region-designer")!.prompt
    expect(region).toContain("Do not call write_skin, write_design or publish_morph")
  })

  test("a brief for a role leads with the role and ends with the parent's words; no role is the words alone", () => {
    const role = roleOf("page-reader")!
    const brief = briefFor(role, "List the nav links.")
    expect(brief.startsWith(role.prompt)).toBe(true)
    expect(brief.endsWith("Your brief from the parent bot:\nList the nav links.")).toBe(true)
    expect(briefFor(undefined, "plain")).toBe("plain")
    expect(roleOf("nobody")).toBeUndefined()
    expect(roleOf(undefined)).toBeUndefined()
  })

  test("the whole-page moves stay with the parent, so no role may publish or dress the site", () => {
    for (const role of CREW_ROLES) {
      expect(role.prompt).toContain("publish_morph")
      expect(role.prompt).toContain("write_design")
    }
  })

  test("every role carries the one line spawn_agent's schema shows the model", () => {
    for (const role of CREW_ROLES) {
      expect(role.description.endsWith(".")).toBe(true)
      expect(role.description.length).toBeLessThan(200)
    }
  })
})
