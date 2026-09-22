import { expect, test } from "bun:test"
import { githubOAuth } from "./github-oauth"

test("GitHub OAuth requests identity scopes and returns a verified profile", async () => {
  const requests: Array<{ readonly url: string; readonly init?: RequestInit }> = []
  const oauth = githubOAuth({
    clientId: "client-id",
    clientSecret: "client-secret",
    callbackUrl: "https://market.test/v1/auth/github/callback",
    fetch: async (input, init) => {
      const url = String(input)
      requests.push({ url, init })
      if (url.endsWith("access_token")) {
        return Response.json({ access_token: "github-access" })
      }
      if (url.endsWith("/user")) {
        return Response.json({
          id: 42,
          login: "Alex",
          name: "Alex",
          avatar_url: "https://avatars.test/42",
          email: null
        })
      }
      return Response.json([
        { email: "other@example.com", primary: false, verified: true },
        { email: "alex@example.com", primary: true, verified: true }
      ])
    }
  })

  const authorization = new URL(oauth.authorizationUrl("csrf-state"))
  expect(authorization.searchParams.get("scope")).toBe("read:user user:email")
  expect(authorization.searchParams.get("scope")).not.toContain("repo")
  expect(authorization.searchParams.get("state")).toBe("csrf-state")
  expect(await oauth.profile("one-use-code")).toEqual({
    id: "42",
    handle: "alex",
    displayName: "Alex",
    avatarUrl: "https://avatars.test/42",
    email: "alex@example.com"
  })
  expect(requests[0]?.init?.body).toContain("client-secret")
  expect(requests[1]?.init?.headers).toEqual({
    Authorization: "Bearer github-access",
    Accept: "application/vnd.github+json"
  })
})
