export type AuthScope = "publish"

export interface MarketplaceUser {
  readonly id: string
  readonly githubId: string
  readonly handle: string
  bannedAt: Date | null
}

export interface VerifiedMarketplaceIdentity {
  readonly verified: true
  readonly userId: string
  readonly githubId: string
  readonly handle: string
  readonly bannedAt: Date | null
}

export interface DeviceCredentialRecord {
  readonly id: string
  readonly deviceCodeHash: string
  readonly userCodeHash: string
  readonly requestedScopes: AuthScope[]
  readonly createdAt: Date
  readonly expiresAt: Date
  userId: string | null
  approvedAt: Date | null
  deniedAt: Date | null
  consumedAt: Date | null
  lastPolledAt: Date | null
}

export interface ApiTokenRecord {
  readonly id: string
  readonly userId: string
  readonly tokenHash: string
  scopes: AuthScope[]
  readonly createdAt: Date
  readonly expiresAt: Date
  revokedAt: Date | null
}

export interface AuthRepository {
  createDevice(record: DeviceCredentialRecord): Promise<"created" | "duplicate">
  findDeviceByDeviceCodeHash(hash: string): Promise<DeviceCredentialRecord | null>
  findDeviceByUserCodeHash(hash: string): Promise<DeviceCredentialRecord | null>
  approveDevice(
    id: string,
    userId: string,
    approvedAt: Date
  ): Promise<"approved" | "duplicate_identity" | "unavailable">
  denyDevice(id: string, deniedAt: Date): Promise<"denied" | "unavailable">
  recordDevicePoll(id: string, polledAt: Date, minimumIntervalMs: number): Promise<"accepted" | "slow_down">
  consumeDeviceAndCreateToken(
    deviceId: string,
    token: ApiTokenRecord,
    consumedAt: Date
  ): Promise<"created" | "consumed">
  findTokenByHash(hash: string): Promise<ApiTokenRecord | null>
  revokeToken(id: string, revokedAt: Date): Promise<boolean>
  findUserById(id: string): Promise<MarketplaceUser | null>
}

export interface ClockPort {
  now(): Date
}

export interface CryptographicRandomPort {
  bytes(length: number): Promise<Uint8Array> | Uint8Array
}

export interface DeviceAuthOptions {
  readonly repository: AuthRepository
  readonly clock: ClockPort
  readonly random: CryptographicRandomPort
  readonly verificationUri?: string
  readonly deviceLifetimeMs?: number
  readonly tokenLifetimeMs?: number
  readonly pollingIntervalMs?: number
}

export type OAuthCallback =
  | { readonly kind: "verified"; readonly identity: VerifiedMarketplaceIdentity }
  | { readonly kind: "denied" }
  | { readonly kind: "state_mismatch" }
  | { readonly kind: "identity_missing" }

export const resolveOAuthCallback = (input: {
  readonly expectedState: string
  readonly state: string | null
  readonly error: string | null
  readonly identity: VerifiedMarketplaceIdentity | null
}): OAuthCallback => {
  if (input.state !== input.expectedState) return { kind: "state_mismatch" }
  if (input.error !== null) return { kind: "denied" }
  if (input.identity === null) return { kind: "identity_missing" }
  return { kind: "verified", identity: input.identity }
}

export type IssueResult =
  | {
      readonly deviceCode: string
      readonly userCode: string
      readonly verificationUri: string
      readonly expiresIn: number
      readonly interval: number
      readonly scopes: AuthScope[]
    }
  | { readonly kind: "invalid_scope" }

export type ApprovalResult =
  | { readonly kind: "approved" }
  | { readonly kind: "denied" }
  | { readonly kind: "invalid_code" }
  | { readonly kind: "expired" }
  | { readonly kind: "consumed" }
  | { readonly kind: "banned_user" }
  | { readonly kind: "duplicate_identity" }

export type ExchangeResult =
  | {
      readonly kind: "success"
      readonly accessToken: string
      readonly tokenType: "Bearer"
      readonly expiresIn: number
      readonly scopes: AuthScope[]
    }
  | { readonly kind: "pending"; readonly interval: number }
  | { readonly kind: "slow_down"; readonly interval: number }
  | { readonly kind: "denied" }
  | { readonly kind: "invalid_code" }
  | { readonly kind: "expired" }
  | { readonly kind: "consumed" }
  | { readonly kind: "banned_user" }

export type AuthenticationResult =
  | {
      readonly kind: "authenticated"
      readonly user: MarketplaceUser
      readonly tokenId: string
      readonly scopes: AuthScope[]
    }
  | { readonly kind: "missing" }
  | { readonly kind: "invalid" }
  | { readonly kind: "expired" }
  | { readonly kind: "revoked" }
  | { readonly kind: "banned_user" }
  | { readonly kind: "insufficient_scope" }

export interface DeviceAuth {
  issue(scopes: ReadonlyArray<string>): Promise<IssueResult>
  approve(userCode: string, identity: VerifiedMarketplaceIdentity): Promise<ApprovalResult>
  deny(userCode: string): Promise<ApprovalResult>
  exchange(deviceCode: string): Promise<ExchangeResult>
  authenticate(authorization: string | null | undefined, requiredScope: AuthScope): Promise<AuthenticationResult>
  revoke(accessToken: string): Promise<{ readonly kind: "revoked" } | { readonly kind: "invalid" }>
}

const encoder = new TextEncoder()
const userCodeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")

const sha256 = async (value: string): Promise<string> =>
  hex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))))

const base64Url = (bytes: Uint8Array): string => {
  let value = ""
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0
    const second = bytes[index + 1] ?? 0
    const third = bytes[index + 2] ?? 0
    const bits = (first << 16) | (second << 8) | third
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    value += alphabet[(bits >>> 18) & 63]
    value += alphabet[(bits >>> 12) & 63]
    if (index + 1 < bytes.length) value += alphabet[(bits >>> 6) & 63]
    if (index + 2 < bytes.length) value += alphabet[bits & 63]
  }
  return value
}

const isPublishOnly = (scopes: ReadonlyArray<string>): scopes is ReadonlyArray<AuthScope> =>
  scopes.length === 1 && scopes[0] === "publish"

const seconds = (milliseconds: number): number => Math.ceil(milliseconds / 1_000)

const completeVerificationUri = (verificationUri: string, userCode: string): string => {
  const absolute = /^[a-z][a-z0-9+.-]*:/i.test(verificationUri)
  const url = new URL(verificationUri, "https://morph.invalid")
  url.searchParams.set("section", "publish")
  url.searchParams.set("user_code", userCode)
  return absolute ? url.href : `${url.pathname}${url.search}${url.hash}`
}

export const createDeviceAuth = (options: DeviceAuthOptions): DeviceAuth => {
  const deviceLifetimeMs = options.deviceLifetimeMs ?? 10 * 60_000
  const tokenLifetimeMs = options.tokenLifetimeMs ?? 15 * 60_000
  const pollingIntervalMs = options.pollingIntervalMs ?? 5_000
  const verificationUri = options.verificationUri ?? "/marketplace/device"

  const secret = async (length: number): Promise<string> => base64Url(await options.random.bytes(length))
  const userCode = async (): Promise<string> => {
    const bytes = await options.random.bytes(8)
    const value = Array.from(bytes, (byte) => userCodeAlphabet.charAt(byte & 31)).join("")
    return `${value.slice(0, 4)}-${value.slice(4)}`
  }
  const normalizeUserCode = (value: string): string => value.trim().toUpperCase()
  const isExpired = (expiresAt: Date, now: Date): boolean => expiresAt.getTime() <= now.getTime()

  const findUserDevice = async (code: string): Promise<DeviceCredentialRecord | null> =>
    options.repository.findDeviceByUserCodeHash(await sha256(normalizeUserCode(code)))

  const issue = async (scopes: ReadonlyArray<string>): Promise<IssueResult> => {
    if (!isPublishOnly(scopes)) return { kind: "invalid_scope" }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const now = options.clock.now()
      const deviceCode = await secret(32)
      const readableCode = await userCode()
      const record: DeviceCredentialRecord = {
        id: await secret(16),
        deviceCodeHash: await sha256(deviceCode),
        userCodeHash: await sha256(readableCode),
        requestedScopes: ["publish"],
        createdAt: now,
        expiresAt: new Date(now.getTime() + deviceLifetimeMs),
        userId: null,
        approvedAt: null,
        deniedAt: null,
        consumedAt: null,
        lastPolledAt: null
      }
      if (await options.repository.createDevice(record) === "created") {
        return {
          deviceCode,
          userCode: readableCode,
          verificationUri: completeVerificationUri(verificationUri, readableCode),
          expiresIn: seconds(deviceLifetimeMs),
          interval: seconds(pollingIntervalMs),
          scopes: ["publish"]
        }
      }
    }
    throw new Error("Could not allocate unique device credentials")
  }

  const approve = async (
    code: string,
    identity: VerifiedMarketplaceIdentity
  ): Promise<ApprovalResult> => {
    if (identity.verified !== true) return { kind: "invalid_code" }
    if (identity.bannedAt !== null) return { kind: "banned_user" }
    const record = await findUserDevice(code)
    if (record === null) return { kind: "invalid_code" }
    const now = options.clock.now()
    if (isExpired(record.expiresAt, now)) return { kind: "expired" }
    if (record.consumedAt !== null) return { kind: "consumed" }
    if (record.deniedAt !== null) return { kind: "denied" }
    const result = await options.repository.approveDevice(record.id, identity.userId, now)
    if (result === "duplicate_identity") return { kind: "duplicate_identity" }
    return result === "approved" ? { kind: "approved" } : { kind: "invalid_code" }
  }

  const deny = async (code: string): Promise<ApprovalResult> => {
    const record = await findUserDevice(code)
    if (record === null) return { kind: "invalid_code" }
    const now = options.clock.now()
    if (isExpired(record.expiresAt, now)) return { kind: "expired" }
    if (record.consumedAt !== null) return { kind: "consumed" }
    if (record.deniedAt !== null) return { kind: "denied" }
    return await options.repository.denyDevice(record.id, now) === "denied"
      ? { kind: "denied" }
      : { kind: "invalid_code" }
  }

  const exchange = async (code: string): Promise<ExchangeResult> => {
    if (code.trim() === "") return { kind: "invalid_code" }
    const record = await options.repository.findDeviceByDeviceCodeHash(await sha256(code))
    if (record === null) return { kind: "invalid_code" }
    const now = options.clock.now()
    if (isExpired(record.expiresAt, now)) return { kind: "expired" }
    if (record.consumedAt !== null) return { kind: "consumed" }
    if (record.deniedAt !== null) return { kind: "denied" }
    if (record.approvedAt === null || record.userId === null) {
      const poll = await options.repository.recordDevicePoll(record.id, now, pollingIntervalMs)
      return poll === "slow_down"
        ? { kind: "slow_down", interval: seconds(pollingIntervalMs) + 5 }
        : { kind: "pending", interval: seconds(pollingIntervalMs) }
    }
    const user = await options.repository.findUserById(record.userId)
    if (user === null || user.bannedAt !== null) return { kind: "banned_user" }
    const accessToken = await secret(32)
    const token: ApiTokenRecord = {
      id: await secret(16),
      userId: user.id,
      tokenHash: await sha256(accessToken),
      scopes: [...record.requestedScopes],
      createdAt: now,
      expiresAt: new Date(now.getTime() + tokenLifetimeMs),
      revokedAt: null
    }
    const consumed = await options.repository.consumeDeviceAndCreateToken(record.id, token, now)
    if (consumed === "consumed") return { kind: "consumed" }
    return {
      kind: "success",
      accessToken,
      tokenType: "Bearer",
      expiresIn: seconds(tokenLifetimeMs),
      scopes: [...record.requestedScopes]
    }
  }

  const authenticate = async (
    authorization: string | null | undefined,
    requiredScope: AuthScope
  ): Promise<AuthenticationResult> => {
    if (authorization === null || authorization === undefined || authorization.trim() === "") return { kind: "missing" }
    const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(authorization)
    if (match === null || match[1] === undefined) return { kind: "invalid" }
    const token = await options.repository.findTokenByHash(await sha256(match[1]))
    if (token === null) return { kind: "invalid" }
    if (token.revokedAt !== null) return { kind: "revoked" }
    if (isExpired(token.expiresAt, options.clock.now())) return { kind: "expired" }
    if (!token.scopes.includes(requiredScope)) return { kind: "insufficient_scope" }
    const user = await options.repository.findUserById(token.userId)
    if (user === null) return { kind: "invalid" }
    if (user.bannedAt !== null) return { kind: "banned_user" }
    return { kind: "authenticated", user, tokenId: token.id, scopes: [...token.scopes] }
  }

  const revoke = async (accessToken: string): Promise<{ kind: "revoked" } | { kind: "invalid" }> => {
    if (accessToken === "") return { kind: "invalid" }
    const token = await options.repository.findTokenByHash(await sha256(accessToken))
    if (token === null) return { kind: "invalid" }
    await options.repository.revokeToken(token.id, options.clock.now())
    return { kind: "revoked" }
  }

  return { issue, approve, deny, exchange, authenticate, revoke }
}
