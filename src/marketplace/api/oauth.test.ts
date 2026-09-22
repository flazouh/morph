import { describe, expect, test } from "bun:test"
import type { OAuthRepository } from "./oauth"
import { createOAuthService } from "./oauth"

const identity = {
  verified: true,
  userId: "user-1",
  githubId: "42",
  handle: "alex",
  bannedAt: null
} as const

const repository = () => {
  const writes: unknown[] = []
  const value: OAuthRepository = {
    createState: async (...args) => {
      writes.push(["state", ...args])
      return "created"
    },
    consumeState: async (...args) => {
      writes.push(["consume", ...args])
      return { deviceId: "device-1" }
    },
    upsertIdentity: async (profile) => {
      writes.push(["identity", profile])
      return identity
    },
    approveOAuthDevice: async (...args) => {
      writes.push(["approve", ...args])
      return { kind: "approved" }
    },
    denyOAuthDevice: async (...args) => {
      writes.push(["deny", ...args])
    },
    createSession: async (...args) => {
      writes.push(["session", ...args])
    }
  }
  return { value, writes }
}

describe("GitHub OAuth device approval", () => {
  test("stores only hashes and binds the callback to the HTTP-only cookie state", async () => {
    const repo = repository()
    let randomByte = 1
    const service = createOAuthService({
      repository: repo.value,
      github: {
        authorizationUrl: (state) => `https://github.test/login?state=${state}`,
        profile: async () => ({
          id: "42",
          handle: "alex",
          displayName: "Alex",
          avatarUrl: null,
          email: null
        })
      },
      random: {
        bytes: (length) => new Uint8Array(length).fill(randomByte++)
      },
      now: () => new Date("2026-09-09T20:00:00.000Z")
    })

    const begun = await service.begin("MORP-H123")
    expect(begun.kind).toBe("redirect")
    if (begun.kind !== "redirect") throw new Error("expected redirect")
    expect(JSON.stringify(repo.writes)).not.toContain("MORP-H123")
    expect(JSON.stringify(repo.writes)).not.toContain(begun.state)

    expect(
      await service.callback({
        code: "github-code",
        state: begun.state,
        stateCookie: "other-state",
        error: null
      })
    ).toEqual({ kind: "state_mismatch" })
    expect(repo.writes.filter((write) => (write as unknown[])[0] === "consume")).toHaveLength(0)

    const approved = await service.callback({
      code: "github-code",
      state: begun.state,
      stateCookie: begun.state,
      error: null
    })
    expect(approved.kind).toBe("approved")
    if (approved.kind !== "approved") throw new Error("expected approval")
    expect(JSON.stringify(repo.writes)).not.toContain(approved.sessionToken)
    expect(repo.writes.some((write) => (write as unknown[])[0] === "approve")).toBe(true)
  })

  test("denies the device when GitHub denies OAuth", async () => {
    const repo = repository()
    const service = createOAuthService({
      repository: repo.value,
      github: {
        authorizationUrl: () => "https://github.test/login",
        profile: async () => {
          throw new Error("must not run")
        }
      },
      random: { bytes: (length) => new Uint8Array(length).fill(1) },
      now: () => new Date("2026-09-09T20:00:00.000Z")
    })

    expect(
      await service.callback({
        code: null,
        state: "same",
        stateCookie: "same",
        error: "access_denied"
      })
    ).toEqual({ kind: "denied" })
    expect(repo.writes.some((write) => (write as unknown[])[0] === "deny")).toBe(true)
  })
})
