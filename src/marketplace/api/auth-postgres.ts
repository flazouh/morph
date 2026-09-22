import type {
  ApiTokenRecord,
  AuthRepository,
  AuthScope,
  DeviceCredentialRecord,
  MarketplaceUser,
  VerifiedMarketplaceIdentity
} from "./auth"
import type { MarketplaceSessionRepository } from "./auth-http"
import type { OAuthRepository } from "./oauth"

interface DeviceRow {
  readonly id: string | number | bigint
  readonly device_code_hash: string
  readonly user_code_hash: string
  readonly requested_scopes: AuthScope[]
  readonly created_at: Date | string
  readonly expires_at: Date | string
  readonly user_id: string | number | bigint | null
  readonly approved_at: Date | string | null
  readonly denied_at: Date | string | null
  readonly consumed_at: Date | string | null
  readonly last_polled_at: Date | string | null
}

interface TokenRow {
  readonly id: string | number | bigint
  readonly user_id: string | number | bigint
  readonly token_hash: string
  readonly scopes: AuthScope[]
  readonly created_at: Date | string
  readonly expires_at: Date | string
  readonly revoked_at: Date | string | null
}

interface UserRow {
  readonly id: string | number | bigint
  readonly github_id: string | number | bigint
  readonly handle: string
  readonly banned_at: Date | string | null
}

const date = (value: Date | string): Date =>
  value instanceof Date ? value : new Date(value)
const nullableDate = (value: Date | string | null): Date | null =>
  value === null ? null : date(value)

const deviceOf = (row: DeviceRow): DeviceCredentialRecord => ({
  id: String(row.id),
  deviceCodeHash: row.device_code_hash,
  userCodeHash: row.user_code_hash,
  requestedScopes: row.requested_scopes,
  createdAt: date(row.created_at),
  expiresAt: date(row.expires_at),
  userId: row.user_id === null ? null : String(row.user_id),
  approvedAt: nullableDate(row.approved_at),
  deniedAt: nullableDate(row.denied_at),
  consumedAt: nullableDate(row.consumed_at),
  lastPolledAt: nullableDate(row.last_polled_at)
})

const tokenOf = (row: TokenRow): ApiTokenRecord => ({
  id: String(row.id),
  userId: String(row.user_id),
  tokenHash: row.token_hash,
  scopes: row.scopes,
  createdAt: date(row.created_at),
  expiresAt: date(row.expires_at),
  revokedAt: nullableDate(row.revoked_at)
})

const userOf = (row: UserRow): MarketplaceUser => ({
  id: String(row.id),
  githubId: String(row.github_id),
  handle: row.handle,
  bannedAt: nullableDate(row.banned_at)
})

const uniqueViolation = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "23505"

export interface MarketplaceIdentityRepository {
  readonly upsertGitHubIdentity: (identity: {
    readonly githubId: string
    readonly handle: string
    readonly displayName: string | null
    readonly avatarUrl: string | null
    readonly email: string | null
  }) => Promise<VerifiedMarketplaceIdentity | "duplicate_identity">
}

export const postgresAuth = (
  sql: typeof Bun.sql
): AuthRepository &
  MarketplaceIdentityRepository &
  MarketplaceSessionRepository &
  OAuthRepository => {
  const findDevice = async (
    column: "device_code_hash" | "user_code_hash",
    hash: string
  ): Promise<DeviceCredentialRecord | null> => {
    const rows = column === "device_code_hash"
      ? await sql<DeviceRow[]>`
          select id, encode(device_code_hash, 'hex') as device_code_hash,
                 encode(user_code_hash, 'hex') as user_code_hash,
                 requested_scopes, created_at, expires_at, user_id,
                 approved_at, denied_at, consumed_at, last_polled_at
          from marketplace_device_codes
          where device_code_hash = decode(${hash}, 'hex')
          limit 1
        `
      : await sql<DeviceRow[]>`
          select id, encode(device_code_hash, 'hex') as device_code_hash,
                 encode(user_code_hash, 'hex') as user_code_hash,
                 requested_scopes, created_at, expires_at, user_id,
                 approved_at, denied_at, consumed_at, last_polled_at
          from marketplace_device_codes
          where user_code_hash = decode(${hash}, 'hex')
          limit 1
        `
    return rows[0] === undefined ? null : deviceOf(rows[0])
  }

  const upsertGitHubIdentity: MarketplaceIdentityRepository["upsertGitHubIdentity"] = async (identity) => {
    try {
      const rows = await sql<UserRow[]>`
        insert into marketplace_users
          (github_id, handle, display_name, avatar_url, email)
        values
          (${identity.githubId}, ${identity.handle}, ${identity.displayName},
           ${identity.avatarUrl}, ${identity.email})
        on conflict (github_id) do update
        set handle = excluded.handle,
            display_name = excluded.display_name,
            avatar_url = excluded.avatar_url,
            email = excluded.email
        returning id, github_id, handle, banned_at
      `
      const user = rows[0]
      if (user === undefined) throw new Error("GitHub identity was not stored")
      return {
        verified: true,
        userId: String(user.id),
        githubId: String(user.github_id),
        handle: user.handle,
        bannedAt: nullableDate(user.banned_at)
      }
    } catch (error) {
      if (uniqueViolation(error)) return "duplicate_identity"
      throw error
    }
  }

  return {
    createDevice: async (record) => {
      try {
        await sql`
          insert into marketplace_device_codes
            (user_code_hash, device_code_hash, requested_scopes, expires_at, created_at)
          values
            (decode(${record.userCodeHash}, 'hex'), decode(${record.deviceCodeHash}, 'hex'),
             array(
               select value
               from jsonb_array_elements_text(
                 (${JSON.stringify(record.requestedScopes)}::text)::jsonb
               ) as value
             ),
             ${record.expiresAt}, ${record.createdAt})
        `
        return "created"
      } catch (error) {
        if (uniqueViolation(error)) return "duplicate"
        throw error
      }
    },
    findDeviceByDeviceCodeHash: (hash) => findDevice("device_code_hash", hash),
    findDeviceByUserCodeHash: (hash) => findDevice("user_code_hash", hash),
    approveDevice: async (id, userId, approvedAt) => {
      const rows = await sql<Array<{ readonly user_id: string | number | bigint }>>`
        update marketplace_device_codes
        set user_id = ${userId}, approved_at = ${approvedAt}
        where id = ${id} and consumed_at is null and denied_at is null
          and (user_id is null or user_id = ${userId})
        returning user_id
      `
      if (rows.length > 0) return "approved"
      const existing = await sql<Array<{ readonly user_id: string | number | bigint | null }>>`
        select user_id from marketplace_device_codes where id = ${id} limit 1
      `
      return existing[0]?.user_id === null || existing[0] === undefined
        ? "unavailable"
        : "duplicate_identity"
    },
    denyDevice: async (id, deniedAt) => {
      const rows = await sql<Array<{ readonly id: string | number | bigint }>>`
        update marketplace_device_codes
        set denied_at = ${deniedAt}
        where id = ${id} and approved_at is null and denied_at is null and consumed_at is null
        returning id
      `
      return rows.length > 0 ? "denied" : "unavailable"
    },
    recordDevicePoll: async (id, polledAt, minimumIntervalMs) => {
      const before = new Date(polledAt.getTime() - minimumIntervalMs)
      const rows = await sql<Array<{ readonly id: string | number | bigint }>>`
        update marketplace_device_codes
        set last_polled_at = ${polledAt}
        where id = ${id} and (last_polled_at is null or last_polled_at <= ${before})
        returning id
      `
      return rows.length > 0 ? "accepted" : "slow_down"
    },
    consumeDeviceAndCreateToken: async (deviceId, token, consumedAt) =>
      sql.begin(async (transaction) => {
        const consumed = await transaction<Array<{ readonly id: string | number | bigint }>>`
          update marketplace_device_codes
          set consumed_at = ${consumedAt}
          where id = ${deviceId} and consumed_at is null and approved_at is not null
          returning id
        `
        if (consumed.length === 0) return "consumed" as const
        await transaction`
          insert into marketplace_api_tokens
            (user_id, name, token_hash, scopes, created_at, expires_at)
          values
            (${token.userId}, 'Morph extension', decode(${token.tokenHash}, 'hex'),
             array(
               select value
               from jsonb_array_elements_text(
                 (${JSON.stringify(token.scopes)}::text)::jsonb
               ) as value
             ),
             ${token.createdAt}, ${token.expiresAt})
        `
        return "created" as const
      }),
    findTokenByHash: async (hash) => {
      const rows = await sql<TokenRow[]>`
        select id, user_id, encode(token_hash, 'hex') as token_hash, scopes,
               created_at, expires_at, revoked_at
        from marketplace_api_tokens
        where token_hash = decode(${hash}, 'hex')
        limit 1
      `
      return rows[0] === undefined ? null : tokenOf(rows[0])
    },
    revokeToken: async (id, revokedAt) => {
      const rows = await sql<Array<{ readonly id: string | number | bigint }>>`
        update marketplace_api_tokens
        set revoked_at = ${revokedAt}
        where id = ${id} and revoked_at is null
        returning id
      `
      return rows.length > 0
    },
    findUserById: async (id) => {
      const rows = await sql<UserRow[]>`
        select id, github_id, handle, banned_at
        from marketplace_users
        where id = ${id}
        limit 1
      `
      return rows[0] === undefined ? null : userOf(rows[0])
    },
    upsertGitHubIdentity,
    createState: async (userCodeHash, stateHash, expiresAt) => {
      const rows = await sql<Array<{ readonly id: string | number | bigint }>>`
        insert into marketplace_oauth_states (state_hash, device_code_id, expires_at)
        select decode(${stateHash}, 'hex'), d.id, ${expiresAt}
        from marketplace_device_codes d
        where d.user_code_hash = decode(${userCodeHash}, 'hex')
          and d.expires_at > now() and d.consumed_at is null and d.denied_at is null
        returning id
      `
      if (rows.length > 0) return "created"
      const device = await findDevice("user_code_hash", userCodeHash)
      return device !== null && device.expiresAt.getTime() <= Date.now()
        ? "expired"
        : "invalid_code"
    },
    consumeState: async (stateHash, consumedAt) => {
      const rows = await sql<Array<{ readonly device_code_id: string | number | bigint }>>`
        update marketplace_oauth_states
        set consumed_at = ${consumedAt}
        where state_hash = decode(${stateHash}, 'hex')
          and consumed_at is null and expires_at > ${consumedAt}
        returning device_code_id
      `
      return rows[0] === undefined
        ? null
        : { deviceId: String(rows[0].device_code_id) }
    },
    upsertIdentity: (profile) =>
      upsertGitHubIdentity({
        githubId: profile.id,
        handle: profile.handle,
        displayName: profile.displayName,
        avatarUrl: profile.avatarUrl,
        email: profile.email
      }),
    approveOAuthDevice: async (deviceId, identity, approvedAt) => {
      if (identity.bannedAt !== null) return { kind: "banned_user" }
      const rows = await sql<Array<{ readonly id: string | number | bigint }>>`
        update marketplace_device_codes
        set user_id = ${identity.userId}, approved_at = ${approvedAt}
        where id = ${deviceId} and consumed_at is null and denied_at is null
          and approved_at is null and user_id is null
        returning id
      `
      return rows.length > 0 ? { kind: "approved" } : { kind: "invalid_code" }
    },
    denyOAuthDevice: async (deviceId, deniedAt) => {
      await sql`
        update marketplace_device_codes
        set denied_at = ${deniedAt}
        where id = ${deviceId} and approved_at is null and consumed_at is null
      `
    },
    createSession: async (userId, tokenHash, expiresAt) => {
      await sql`
        insert into marketplace_sessions (user_id, token_hash, expires_at)
        values (${userId}, decode(${tokenHash}, 'hex'), ${expiresAt})
      `
    },
    findSessionUser: async (tokenHash, activeAt) => {
      const rows = await sql<UserRow[]>`
        select users.id, users.github_id, users.handle, users.banned_at
        from marketplace_sessions sessions
        join marketplace_users users on users.id = sessions.user_id
        where sessions.token_hash = decode(${tokenHash}, 'hex')
          and sessions.expires_at > ${activeAt}
          and sessions.revoked_at is null
          and users.banned_at is null
        limit 1
      `
      return rows[0] === undefined ? null : userOf(rows[0])
    }
  }
}
