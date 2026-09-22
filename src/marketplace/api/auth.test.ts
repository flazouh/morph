import { describe, expect, test } from "bun:test"
import {
  createDeviceAuth,
  resolveOAuthCallback,
  type ApiTokenRecord,
  type AuthRepository,
  type DeviceCredentialRecord,
  type IssueResult,
  type MarketplaceUser,
  type VerifiedMarketplaceIdentity
} from "./auth"

const start = new Date("2026-09-09T12:00:00.000Z")

class MemoryAuthRepository implements AuthRepository {
  readonly devices: DeviceCredentialRecord[] = []
  readonly tokens: ApiTokenRecord[] = []
  readonly users = new Map<string, MarketplaceUser>()
  createDeviceResult: "created" | "duplicate" = "created"
  approvalResult: "approved" | "duplicate_identity" = "approved"

  async createDevice(record: DeviceCredentialRecord): Promise<"created" | "duplicate"> {
    if (this.createDeviceResult === "duplicate") return "duplicate"
    this.devices.push(record)
    return "created"
  }

  async findDeviceByDeviceCodeHash(hash: string): Promise<DeviceCredentialRecord | null> {
    return this.devices.find((record) => record.deviceCodeHash === hash) ?? null
  }

  async findDeviceByUserCodeHash(hash: string): Promise<DeviceCredentialRecord | null> {
    return this.devices.find((record) => record.userCodeHash === hash) ?? null
  }

  async approveDevice(
    id: string,
    userId: string,
    approvedAt: Date
  ): Promise<"approved" | "duplicate_identity" | "unavailable"> {
    if (this.approvalResult !== "approved") return this.approvalResult
    const record = this.devices.find((device) => device.id === id)
    if (record === undefined) return "unavailable"
    record.userId = userId
    record.approvedAt = approvedAt
    return "approved"
  }

  async denyDevice(id: string, deniedAt: Date): Promise<"denied" | "unavailable"> {
    const record = this.devices.find((device) => device.id === id)
    if (record === undefined) return "unavailable"
    record.deniedAt = deniedAt
    return "denied"
  }

  async recordDevicePoll(id: string, polledAt: Date, minimumIntervalMs: number): Promise<"accepted" | "slow_down"> {
    const record = this.devices.find((device) => device.id === id)
    if (record?.lastPolledAt !== null && record?.lastPolledAt !== undefined) {
      if (polledAt.getTime() - record.lastPolledAt.getTime() < minimumIntervalMs) return "slow_down"
    }
    if (record !== undefined) record.lastPolledAt = polledAt
    return "accepted"
  }

  async consumeDeviceAndCreateToken(
    deviceId: string,
    token: ApiTokenRecord,
    consumedAt: Date
  ): Promise<"created" | "consumed"> {
    const record = this.devices.find((device) => device.id === deviceId)
    if (record === undefined || record.consumedAt !== null) return "consumed"
    record.consumedAt = consumedAt
    this.tokens.push(token)
    return "created"
  }

  async findTokenByHash(hash: string): Promise<ApiTokenRecord | null> {
    return this.tokens.find((token) => token.tokenHash === hash) ?? null
  }

  async revokeToken(id: string, revokedAt: Date): Promise<boolean> {
    const token = this.tokens.find((record) => record.id === id)
    if (token === undefined || token.revokedAt !== null) return false
    token.revokedAt = revokedAt
    return true
  }

  async findUserById(id: string): Promise<MarketplaceUser | null> {
    return this.users.get(id) ?? null
  }
}

const makeHarness = () => {
  const repository = new MemoryAuthRepository()
  let now = new Date(start)
  let nextByte = 0
  const auth = createDeviceAuth({
    repository,
    clock: { now: () => new Date(now) },
    random: {
      bytes: async (length) => Uint8Array.from({ length }, () => {
        nextByte = (nextByte + 17) % 256
        return nextByte
      })
    }
  })
  return {
    auth,
    repository,
    setNow: (value: Date) => {
      now = value
    }
  }
}

const identity = (overrides: Partial<VerifiedMarketplaceIdentity> = {}): VerifiedMarketplaceIdentity => ({
  verified: true,
  userId: "user-1",
  githubId: "123",
  handle: "alex",
  bannedAt: null,
  ...overrides
})

const expectIssued = (result: IssueResult): Exclude<IssueResult, { readonly kind: "invalid_scope" }> => {
  if ("kind" in result) throw new Error("expected credentials")
  return result
}

describe("device authentication", () => {
  test("issues secure credentials while storing only SHA-256 hashes and the publish scope", async () => {
    const { auth, repository } = makeHarness()

    const issued = expectIssued(await auth.issue(["publish"]))

    expect(issued).toMatchObject({
      expiresIn: 600,
      interval: 5,
      scopes: ["publish"]
    })
    expect(issued.deviceCode).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(issued.userCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    expect(issued.verificationUri).toBe(
      `/marketplace/device?section=publish&user_code=${issued.userCode}`
    )
    expect(repository.devices).toHaveLength(1)
    expect(repository.devices[0]).toMatchObject({
      requestedScopes: ["publish"],
      userId: null,
      approvedAt: null,
      deniedAt: null,
      consumedAt: null
    })
    expect(repository.devices[0]).not.toHaveProperty("deviceCode")
    expect(repository.devices[0]).not.toHaveProperty("userCode")
    expect(repository.devices[0]?.deviceCodeHash).toMatch(/^[a-f0-9]{64}$/)
    expect(repository.devices[0]?.userCodeHash).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(repository.devices[0])).not.toContain(issued.deviceCode)
    expect(JSON.stringify(repository.devices[0])).not.toContain(issued.userCode)
  })

  test("refuses missing, unknown, or wider scopes", async () => {
    const { auth } = makeHarness()

    expect(await auth.issue([])).toEqual({ kind: "invalid_scope" })
    expect(await auth.issue(["read"])).toEqual({ kind: "invalid_scope" })
    expect(await auth.issue(["publish", "publish"])).toEqual({ kind: "invalid_scope" })
  })

  test("approves only a verified, active Marketplace user and reports repository identity conflicts", async () => {
    const { auth, repository } = makeHarness()
    const issued = await auth.issue(["publish"])
    if ("kind" in issued) throw new Error("expected credentials")

    expect(await auth.approve("WRONG-CODE", identity())).toEqual({ kind: "invalid_code" })
    expect(await auth.approve(issued.userCode, identity({ bannedAt: start }))).toEqual({ kind: "banned_user" })
    repository.approvalResult = "duplicate_identity"
    expect(await auth.approve(issued.userCode, identity())).toEqual({ kind: "duplicate_identity" })
    repository.approvalResult = "approved"
    expect(await auth.approve(issued.userCode, identity())).toEqual({ kind: "approved" })
  })

  test("represents OAuth denial and state mismatch without accepting an identity", () => {
    expect(resolveOAuthCallback({ expectedState: "safe", state: "safe", error: "access_denied", identity: null }))
      .toEqual({ kind: "denied" })
    expect(resolveOAuthCallback({ expectedState: "safe", state: "wrong", error: null, identity: identity() }))
      .toEqual({ kind: "state_mismatch" })
    expect(resolveOAuthCallback({ expectedState: "safe", state: "safe", error: null, identity: null }))
      .toEqual({ kind: "identity_missing" })
    expect(resolveOAuthCallback({ expectedState: "safe", state: "safe", error: null, identity: identity() }))
      .toEqual({ kind: "verified", identity: identity() })
  })

  test("exchanges once and returns pending, slow-down, denied, expired, and consumed states", async () => {
    const { auth, repository, setNow } = makeHarness()
    const pending = await auth.issue(["publish"])
    if ("kind" in pending) throw new Error("expected credentials")

    expect(await auth.exchange(pending.deviceCode)).toEqual({ kind: "pending", interval: 5 })
    expect(await auth.exchange(pending.deviceCode)).toEqual({ kind: "slow_down", interval: 10 })

    const denied = await auth.issue(["publish"])
    if ("kind" in denied) throw new Error("expected credentials")
    expect(await auth.deny(denied.userCode)).toEqual({ kind: "denied" })
    expect(await auth.exchange(denied.deviceCode)).toEqual({ kind: "denied" })

    const expired = await auth.issue(["publish"])
    if ("kind" in expired) throw new Error("expected credentials")
    setNow(new Date(start.getTime() + 600_001))
    expect(await auth.exchange(expired.deviceCode)).toEqual({ kind: "expired" })

    setNow(start)
    const approved = await auth.issue(["publish"])
    if ("kind" in approved) throw new Error("expected credentials")
    repository.users.set("user-1", {
      id: "user-1",
      githubId: "123",
      handle: "alex",
      bannedAt: null
    })
    expect(await auth.approve(approved.userCode, identity())).toEqual({ kind: "approved" })
    const exchanged = await auth.exchange(approved.deviceCode)
    expect(exchanged).toMatchObject({
      kind: "success",
      tokenType: "Bearer",
      expiresIn: 900,
      scopes: ["publish"]
    })
    if (exchanged.kind !== "success") throw new Error("expected token")
    expect(exchanged.accessToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(repository.tokens[0]).not.toHaveProperty("accessToken")
    expect(JSON.stringify(repository.tokens[0])).not.toContain(exchanged.accessToken)
    expect(await auth.exchange(approved.deviceCode)).toEqual({ kind: "consumed" })
  })

  test("rejects missing, invalid, expired, revoked, banned, and under-scoped bearer tokens", async () => {
    const { auth, repository, setNow } = makeHarness()

    expect(await auth.authenticate(null, "publish")).toEqual({ kind: "missing" })
    expect(await auth.authenticate("Basic abc", "publish")).toEqual({ kind: "invalid" })
    expect(await auth.authenticate("Bearer unknown", "publish")).toEqual({ kind: "invalid" })

    const issued = await auth.issue(["publish"])
    if ("kind" in issued) throw new Error("expected credentials")
    repository.users.set("user-1", { id: "user-1", githubId: "123", handle: "alex", bannedAt: null })
    await auth.approve(issued.userCode, identity())
    const exchanged = await auth.exchange(issued.deviceCode)
    if (exchanged.kind !== "success") throw new Error("expected token")

    expect(await auth.authenticate(`Bearer ${exchanged.accessToken}`, "publish")).toEqual({
      kind: "authenticated",
      user: repository.users.get("user-1")!,
      scopes: ["publish"],
      tokenId: repository.tokens[0]!.id
    })
    repository.tokens[0]!.scopes = []
    expect(await auth.authenticate(`Bearer ${exchanged.accessToken}`, "publish")).toEqual({ kind: "insufficient_scope" })
    repository.tokens[0]!.scopes = ["publish"]
    repository.users.get("user-1")!.bannedAt = start
    expect(await auth.authenticate(`Bearer ${exchanged.accessToken}`, "publish")).toEqual({ kind: "banned_user" })
    repository.users.get("user-1")!.bannedAt = null
    expect(await auth.revoke(exchanged.accessToken)).toEqual({ kind: "revoked" })
    expect(await auth.authenticate(`Bearer ${exchanged.accessToken}`, "publish")).toEqual({ kind: "revoked" })

    repository.tokens[0]!.revokedAt = null
    setNow(new Date(start.getTime() + 900_001))
    expect(await auth.authenticate(`Bearer ${exchanged.accessToken}`, "publish")).toEqual({ kind: "expired" })
  })

  test("refuses exchange when the approved user became banned", async () => {
    const { auth, repository } = makeHarness()
    const issued = await auth.issue(["publish"])
    if ("kind" in issued) throw new Error("expected credentials")
    repository.users.set("user-1", { id: "user-1", githubId: "123", handle: "alex", bannedAt: start })
    await auth.approve(issued.userCode, identity())

    expect(await auth.exchange(issued.deviceCode)).toEqual({ kind: "banned_user" })
    expect(repository.tokens).toEqual([])
  })
})
