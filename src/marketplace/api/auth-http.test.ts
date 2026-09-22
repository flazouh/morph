import { describe, expect, test } from "bun:test"
import type { DeviceAuth } from "./auth"
import { authApi, authenticateMarketplaceSession } from "./auth-http"
import type { OAuthService } from "./oauth"

const unused = () => {
  throw new Error("unused")
}

const deviceAuth = (overrides: Partial<DeviceAuth> = {}): DeviceAuth => ({
  issue: unused,
  approve: unused,
  deny: unused,
  exchange: unused,
  authenticate: unused,
  revoke: unused,
  ...overrides
})

const oauthService = (overrides: Partial<OAuthService> = {}): OAuthService => ({
  begin: unused,
  callback: unused,
  ...overrides
})

describe("publisher authentication HTTP", () => {
  test("authenticates the secure marketplace session cookie by its hash", async () => {
    let tokenHash = ""
    const user = {
      id: "u-fork",
      githubId: "42",
      handle: "alex",
      bannedAt: null
    }
    const authenticated = await authenticateMarketplaceSession(
      {
        findSessionUser: async (hash) => {
          tokenHash = hash
          return user
        }
      },
      new Request("https://api.test/v1/releases/run/public", {
        headers: { cookie: "other=x; morph_session=session-secret" }
      }),
      new Date("2026-09-09T20:00:00.000Z")
    )

    expect(authenticated).toEqual(user)
    expect(tokenHash).toMatch(/^[a-f0-9]{64}$/)
    expect(tokenHash).not.toContain("session-secret")
  })

  test("issues a device challenge and reports pending exchange", async () => {
    const api = authApi({
      auth: deviceAuth({
        issue: async () => ({
          deviceCode: "device-secret",
          userCode: "MORP-H123",
          verificationUri: "https://market.test/device?user_code=MORP-H123",
          expiresIn: 600,
          interval: 5,
          scopes: ["publish"]
        }),
        exchange: async () => ({ kind: "pending", interval: 5 })
      }),
      oauth: oauthService(),
      webUrl: "https://market.test/",
      now: () => new Date("2026-09-09T20:00:00.000Z")
    })

    const challenge = await api(
      new Request("https://api.test/v1/auth/device", {
        method: "POST",
        body: JSON.stringify({ scopes: ["publish"] })
      })
    )
    expect(challenge?.status).toBe(201)
    expect(await challenge?.json()).toEqual({
      deviceCode: "device-secret",
      userCode: "MORP-H123",
      verificationUri: "https://market.test/device?user_code=MORP-H123",
      expiresAt: "2026-09-09T20:10:00.000Z",
      intervalSeconds: 5,
      scopes: ["publish"]
    })

    const pending = await api(
      new Request("https://api.test/v1/auth/device/token", {
        method: "POST",
        body: JSON.stringify({ deviceCode: "device-secret" })
      })
    )
    expect(pending?.status).toBe(428)
    expect(await pending?.json()).toEqual({
      error: "authorization_pending",
      intervalSeconds: 5
    })
  })

  test("sets secure HTTP-only state and session cookies around GitHub OAuth", async () => {
    const api = authApi({
      auth: deviceAuth(),
      oauth: oauthService({
        begin: async () => ({
          kind: "redirect",
          url: "https://github.test/oauth?state=csrf-secret",
          state: "csrf-secret"
        }),
        callback: async () => ({
          kind: "approved",
          sessionToken: "session-secret",
          sessionExpiresAt: new Date("2026-09-10T04:00:00.000Z")
        })
      }),
      webUrl: "https://market.test/",
      now: () => new Date("2026-09-09T20:00:00.000Z")
    })

    const start = await api(
      new Request("https://api.test/v1/auth/github?user_code=MORP-H123")
    )
    expect(start?.status).toBe(302)
    const startCookies =
      (start?.headers as Headers & { getSetCookie?: () => string[] })?.getSetCookie?.().join("; ") ??
      start?.headers.get("set-cookie") ??
      ""
    expect(startCookies).toContain(
      "HttpOnly; Secure; SameSite=Lax"
    )

    const callback = await api(
      new Request(
        "https://api.test/v1/auth/github/callback?code=github-code&state=csrf-secret",
        { headers: { cookie: "morph_oauth_state=csrf-secret" } }
      )
    )
    expect(callback?.status).toBe(302)
    const callbackCookies =
      (callback?.headers as Headers & { getSetCookie?: () => string[] })?.getSetCookie?.().join("; ") ??
      callback?.headers.get("set-cookie") ??
      ""
    expect(callbackCookies).toContain(
      "morph_session=session-secret; HttpOnly; Secure; SameSite=Lax"
    )
  })
})
