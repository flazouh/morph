import type { AuthScope, DeviceAuth, MarketplaceUser } from "./auth"
import { hashAuthSecret } from "./auth-hash"
import type { OAuthService } from "./oauth"

export interface MarketplaceSessionRepository {
  readonly findSessionUser: (
    tokenHash: string,
    activeAt: Date
  ) => Promise<MarketplaceUser | null>
}

export interface AuthHttpOptions {
  readonly auth: DeviceAuth
  readonly oauth: OAuthService
  readonly webUrl: string
  readonly now: () => Date
}

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type"
} as const

const json = (value: unknown, status = 200): Response =>
  Response.json(value, {
    status,
    headers: { ...cors, "Content-Type": "application/json; charset=utf-8" }
  })

const cookieValue = (request: Request, name: string): string | null => {
  const cookies = request.headers.get("cookie")?.split(";") ?? []
  for (const cookie of cookies) {
    const [key, ...parts] = cookie.trim().split("=")
    if (key === name) {
      try {
        return decodeURIComponent(parts.join("="))
      } catch {
        return null
      }
    }
  }
  return null
}

export const authenticateMarketplaceSession = async (
  repository: MarketplaceSessionRepository,
  request: Request,
  activeAt: Date
): Promise<MarketplaceUser | null> => {
  const token = cookieValue(request, "morph_session")
  if (token === null || token === "") return null
  const user = await repository.findSessionUser(
    await hashAuthSecret(token),
    activeAt
  )
  return user?.bannedAt === null ? user : null
}

const bearer = (request: Request): string | null => {
  const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(
    request.headers.get("authorization") ?? ""
  )
  return match?.[1] ?? null
}

export const authApi =
  (options: AuthHttpOptions) =>
  async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url)
    if (request.method === "OPTIONS" && url.pathname.startsWith("/v1/auth/")) {
      return new Response(null, { status: 204, headers: cors })
    }
    if (request.method === "POST" && url.pathname === "/v1/auth/device") {
      const body = await request.json().catch(() => null)
      const scopes =
        typeof body === "object" &&
        body !== null &&
        "scopes" in body &&
        Array.isArray(body.scopes)
          ? body.scopes.filter((scope: unknown): scope is string => typeof scope === "string")
          : []
      const result = await options.auth.issue(scopes)
      if ("kind" in result) return json({ error: result.kind }, 400)
      return json(
        {
          deviceCode: result.deviceCode,
          userCode: result.userCode,
          verificationUri: result.verificationUri,
          expiresAt: new Date(
            options.now().getTime() + result.expiresIn * 1_000
          ).toISOString(),
          intervalSeconds: result.interval,
          scopes: result.scopes
        },
        201
      )
    }
    if (request.method === "POST" && url.pathname === "/v1/auth/device/token") {
      const body = await request.json().catch(() => null)
      const code =
        typeof body === "object" &&
        body !== null &&
        "deviceCode" in body &&
        typeof body.deviceCode === "string"
          ? body.deviceCode
          : ""
      const result = await options.auth.exchange(code)
      if (result.kind === "success") {
        return json({
          accessToken: result.accessToken,
          expiresAt: new Date(
            options.now().getTime() + result.expiresIn * 1_000
          ).toISOString(),
          scopes: result.scopes
        })
      }
      const statuses: Record<Exclude<typeof result.kind, "success">, number> = {
        pending: 428,
        slow_down: 429,
        denied: 403,
        invalid_code: 401,
        expired: 401,
        consumed: 401,
        banned_user: 403
      }
      const error =
        result.kind === "pending" ? "authorization_pending" : result.kind
      return json(
        {
          error,
          ...(
            result.kind === "pending" || result.kind === "slow_down"
              ? { intervalSeconds: result.interval }
              : {}
          )
        },
        statuses[result.kind]
      )
    }
    if (request.method === "POST" && url.pathname === "/v1/auth/token/revoke") {
      const token = bearer(request)
      if (token === null) return json({ error: "invalid_token" }, 401)
      const result = await options.auth.revoke(token)
      return result.kind === "revoked"
        ? json({ revoked: true })
        : json({ error: "invalid_token" }, 401)
    }
    if (request.method === "GET" && url.pathname === "/v1/auth/github") {
      const result = await options.oauth.begin(url.searchParams.get("user_code") ?? "")
      if (result.kind !== "redirect") {
        return json({ error: result.kind }, result.kind === "expired" ? 410 : 400)
      }
      return new Response(null, {
        status: 302,
        headers: {
          Location: result.url,
          "Set-Cookie": `morph_oauth_state=${encodeURIComponent(result.state)}; HttpOnly; Secure; SameSite=Lax; Path=/v1/auth/github; Max-Age=600`
        }
      })
    }
    if (
      request.method === "GET" &&
      url.pathname === "/v1/auth/github/callback"
    ) {
      const result = await options.oauth.callback({
        code: url.searchParams.get("code"),
        state: url.searchParams.get("state"),
        error: url.searchParams.get("error"),
        stateCookie: cookieValue(request, "morph_oauth_state")
      })
      if (result.kind !== "approved") {
        const target = new URL(options.webUrl)
        target.searchParams.set("section", "publish")
        target.searchParams.set("auth", result.kind)
        return Response.redirect(target, 302)
      }
      const target = new URL(options.webUrl)
      target.searchParams.set("section", "publish")
      target.searchParams.set("auth", "approved")
      return new Response(null, {
        status: 302,
        headers: {
          Location: target.href,
          "Set-Cookie": `morph_session=${encodeURIComponent(result.sessionToken)}; HttpOnly; Secure; SameSite=Lax; Path=/; Expires=${result.sessionExpiresAt.toUTCString()}`
        }
      })
    }
    return null
  }

export const authenticatePublisher = async (
  auth: DeviceAuth,
  request: Request
): Promise<
  | {
      readonly userId: string
      readonly handle: string
      readonly scopes: ReadonlyArray<AuthScope>
    }
  | Response
> => {
  const result = await auth.authenticate(
    request.headers.get("authorization"),
    "publish"
  )
  return result.kind === "authenticated"
    ? { userId: result.user.id, handle: result.user.handle, scopes: result.scopes }
    : json(
        {
          error:
            result.kind === "missing" || result.kind === "invalid"
              ? "invalid_token"
              : result.kind
        },
        result.kind === "insufficient_scope" ? 403 : 401
      )
}
