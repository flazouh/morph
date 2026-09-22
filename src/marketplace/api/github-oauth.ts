import type { GitHubOAuthPort, GitHubProfile } from "./oauth"

export interface GitHubOAuthOptions {
  readonly clientId: string
  readonly clientSecret: string
  readonly callbackUrl: string
  readonly fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
}

const jsonRecord = async (response: Response): Promise<Record<string, unknown>> => {
  const value = await response.json().catch(() => null)
  if (!response.ok || typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`GitHub OAuth failed (${response.status})`)
  }
  return value as Record<string, unknown>
}

export const githubOAuth = (options: GitHubOAuthOptions): GitHubOAuthPort => {
  const request = options.fetch ?? fetch
  return {
    authorizationUrl: (state) => {
      const parameters = new URLSearchParams({
        client_id: options.clientId,
        redirect_uri: options.callbackUrl,
        scope: "read:user user:email",
        state
      })
      return `https://github.com/login/oauth/authorize?${parameters}`
    },
    profile: async (code): Promise<GitHubProfile> => {
      const token = await jsonRecord(
        await request("https://github.com/login/oauth/access_token", {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            client_id: options.clientId,
            client_secret: options.clientSecret,
            code,
            redirect_uri: options.callbackUrl
          })
        })
      )
      if (typeof token.access_token !== "string") {
        throw new Error("GitHub returned no OAuth access token")
      }
      const authorization = { Authorization: `Bearer ${token.access_token}` }
      const user = await jsonRecord(
        await request("https://api.github.com/user", {
          headers: { ...authorization, Accept: "application/vnd.github+json" }
        })
      )
      if (
        typeof user.id !== "number" ||
        typeof user.login !== "string" ||
        (user.name !== null && typeof user.name !== "string") ||
        (user.avatar_url !== null && typeof user.avatar_url !== "string") ||
        (user.email !== null && typeof user.email !== "string")
      ) {
        throw new Error("GitHub returned an invalid user identity")
      }
      let email = user.email
      if (email === null) {
        const response = await request("https://api.github.com/user/emails", {
          headers: { ...authorization, Accept: "application/vnd.github+json" }
        })
        const emails = await response.json().catch(() => null)
        if (response.ok && Array.isArray(emails)) {
          const primary = emails.find(
            (item) =>
              typeof item === "object" &&
              item !== null &&
              "primary" in item &&
              item.primary === true &&
              "verified" in item &&
              item.verified === true &&
              "email" in item &&
              typeof item.email === "string"
          ) as { readonly email: string } | undefined
          email = primary?.email ?? null
        }
      }
      return {
        id: String(user.id),
        handle: user.login.toLowerCase(),
        displayName: user.name,
        avatarUrl: user.avatar_url,
        email
      }
    }
  }
}
