import type {
  ApprovalResult,
  CryptographicRandomPort,
  VerifiedMarketplaceIdentity
} from "./auth"
import { hashAuthSecret } from "./auth-hash"

export interface GitHubProfile {
  readonly id: string
  readonly handle: string
  readonly displayName: string | null
  readonly avatarUrl: string | null
  readonly email: string | null
}

export interface GitHubOAuthPort {
  readonly authorizationUrl: (state: string) => string
  readonly profile: (code: string) => Promise<GitHubProfile>
}

export interface OAuthRepository {
  readonly createState: (
    userCodeHash: string,
    stateHash: string,
    expiresAt: Date
  ) => Promise<"created" | "invalid_code" | "expired">
  readonly consumeState: (
    stateHash: string,
    consumedAt: Date
  ) => Promise<{ readonly deviceId: string } | null>
  readonly upsertIdentity: (
    profile: GitHubProfile
  ) => Promise<VerifiedMarketplaceIdentity | "duplicate_identity">
  readonly approveOAuthDevice: (
    deviceId: string,
    identity: VerifiedMarketplaceIdentity,
    approvedAt: Date
  ) => Promise<ApprovalResult>
  readonly denyOAuthDevice: (deviceId: string, deniedAt: Date) => Promise<void>
  readonly createSession: (
    userId: string,
    tokenHash: string,
    expiresAt: Date
  ) => Promise<void>
}

export interface OAuthService {
  readonly begin: (
    userCode: string
  ) => Promise<
    | { readonly kind: "redirect"; readonly url: string; readonly state: string }
    | { readonly kind: "invalid_code" | "expired" }
  >
  readonly callback: (input: {
    readonly code: string | null
    readonly state: string | null
    readonly stateCookie: string | null
    readonly error: string | null
  }) => Promise<
    | {
        readonly kind: "approved"
        readonly sessionToken: string
        readonly sessionExpiresAt: Date
      }
    | {
        readonly kind:
          | "denied"
          | "state_mismatch"
          | "invalid_state"
          | "duplicate_identity"
          | "banned_user"
          | "approval_failed"
      }
  >
}

const base64Url = (bytes: Uint8Array): string => {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}

export const createOAuthService = (options: {
  readonly repository: OAuthRepository
  readonly github: GitHubOAuthPort
  readonly random: CryptographicRandomPort
  readonly now: () => Date
  readonly stateLifetimeMs?: number
  readonly sessionLifetimeMs?: number
}): OAuthService => {
  const stateLifetimeMs = options.stateLifetimeMs ?? 10 * 60_000
  const sessionLifetimeMs = options.sessionLifetimeMs ?? 8 * 60 * 60_000
  const secret = async (): Promise<string> =>
    base64Url(await options.random.bytes(32))

  return {
    begin: async (userCode) => {
      const state = await secret()
      const result = await options.repository.createState(
        await hashAuthSecret(userCode.trim().toUpperCase()),
        await hashAuthSecret(state),
        new Date(options.now().getTime() + stateLifetimeMs)
      )
      return result === "created"
        ? {
            kind: "redirect",
            url: options.github.authorizationUrl(state),
            state
          }
        : { kind: result }
    },
    callback: async ({ code, state, stateCookie, error }) => {
      if (state === null || stateCookie === null || state !== stateCookie) {
        return { kind: "state_mismatch" }
      }
      const pending = await options.repository.consumeState(
        await hashAuthSecret(state),
        options.now()
      )
      if (pending === null) return { kind: "invalid_state" }
      if (error !== null || code === null) {
        await options.repository.denyOAuthDevice(pending.deviceId, options.now())
        return { kind: "denied" }
      }
      const identity = await options.repository.upsertIdentity(
        await options.github.profile(code)
      )
      if (identity === "duplicate_identity") return { kind: identity }
      if (identity.bannedAt !== null) return { kind: "banned_user" }
      const approval = await options.repository.approveOAuthDevice(
        pending.deviceId,
        identity,
        options.now()
      )
      if (approval.kind !== "approved") return { kind: "approval_failed" }
      const sessionToken = await secret()
      const sessionExpiresAt = new Date(options.now().getTime() + sessionLifetimeMs)
      await options.repository.createSession(
        identity.userId,
        await hashAuthSecret(sessionToken),
        sessionExpiresAt
      )
      return { kind: "approved", sessionToken, sessionExpiresAt }
    }
  }
}
