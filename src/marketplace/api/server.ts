import { join } from "node:path"
import { LENT_MODULE_IDS } from "../sandbox/lentModules"
import { compilePackage } from "../compiler/compile"
import { nodeCompilerPorts, nodePageCompilerPorts } from "../compiler/node"
import { compilePagePackage } from "../compiler/page"
import { marketplaceApp } from "./app"
import { createDeviceAuth } from "./auth"
import { authApi, authenticateMarketplaceSession } from "./auth-http"
import { postgresAuth } from "./auth-postgres"
import { releaseGitHub } from "./github-release"
import { githubOAuth } from "./github-oauth"
import { marketplaceApi } from "./http"
import { createOAuthService } from "./oauth"
import { postgresMarketplace } from "./postgres"
import { releasePublisher } from "./publishing"
import { releaseReceiptSigner } from "./receipt"
import { releaseApi } from "./release-http"
import { postgresReleases } from "./release-postgres"
import { marketplaceWeb } from "./web"

const port = Number(Bun.env.PORT ?? "3000")
const required = (name: string): string => {
  const value = Bun.env[name]
  if (value === undefined || value === "") throw new Error(`${name} is required`)
  return value
}
const publicUrl =
  Bun.env.MARKETPLACE_WEB_URL ??
  (Bun.env.RAILWAY_PUBLIC_DOMAIN === undefined
    ? `http://localhost:${port}`
    : `https://${Bun.env.RAILWAY_PUBLIC_DOMAIN}`)
const random = {
  bytes: (length: number): Uint8Array => crypto.getRandomValues(new Uint8Array(length))
}
const authRepository = postgresAuth(Bun.sql)
const auth = createDeviceAuth({
  repository: authRepository,
  clock: { now: () => new Date() },
  random,
  verificationUri: `${publicUrl}/marketplace/device`
})
const oauth = createOAuthService({
  repository: authRepository,
  github: githubOAuth({
    clientId: required("GITHUB_OAUTH_CLIENT_ID"),
    clientSecret: required("GITHUB_OAUTH_CLIENT_SECRET"),
    callbackUrl: `${publicUrl}/v1/auth/github/callback`
  }),
  random,
  now: () => new Date()
})
const compilerPorts = await nodeCompilerPorts(process.cwd(), LENT_MODULE_IDS)
const pageCompilerPorts = await nodePageCompilerPorts(process.cwd())
const publisher = releasePublisher({
  repository: postgresReleases(Bun.sql),
  github: releaseGitHub({ token: required("GITHUB_RELEASE_TOKEN") }),
  compile: (runtime, source) =>
    runtime === "sandbox-v1" ? compilePackage(source, compilerPorts) : compilePagePackage(source, pageCompilerPorts),
  sign: releaseReceiptSigner(required("RELEASE_RECEIPT_SECRET")),
  now: () => new Date()
})
const reportSalt = required("REPORT_SALT")
const fetch = marketplaceApp({
  auth: authApi({ auth, oauth, webUrl: `${publicUrl}/marketplace`, now: () => new Date() }),
  releases: releaseApi(
    auth,
    publisher,
    (request) => authenticateMarketplaceSession(authRepository, request, new Date())
  ),
  catalog: marketplaceApi(postgresMarketplace(Bun.sql), { reportSalt }),
  web: marketplaceWeb(join(process.cwd(), "dist"))
})

Bun.serve({
  port,
  fetch,
  error(error) {
    console.error(error)
    return Response.json({ error: "internal_error" }, { status: 500 })
  }
})

console.log(`Redesign marketplace API listening on ${port}`)
