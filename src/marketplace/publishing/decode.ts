import type {
  DeviceChallenge,
  PublisherToken,
  ReleaseStatus
} from "./client"

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined

const validDate = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value))

export const parseDeviceChallenge = (
  value: unknown
): DeviceChallenge | undefined => {
  const item = record(value)
  if (
    typeof item?.deviceCode !== "string" ||
    typeof item.userCode !== "string" ||
    typeof item.verificationUri !== "string" ||
    !validDate(item.expiresAt) ||
    typeof item.intervalSeconds !== "number" ||
    !Number.isInteger(item.intervalSeconds) ||
    item.intervalSeconds <= 0
  ) {
    return undefined
  }
  return {
    deviceCode: item.deviceCode,
    userCode: item.userCode,
    verificationUri: item.verificationUri,
    expiresAt: item.expiresAt,
    intervalSeconds: item.intervalSeconds
  }
}

export const parsePublisherToken = (
  value: unknown
): PublisherToken | undefined => {
  const item = record(value)
  if (
    typeof item?.accessToken !== "string" ||
    item.accessToken === "" ||
    !validDate(item.expiresAt) ||
    !Array.isArray(item.scopes) ||
    item.scopes.length !== 1 ||
    item.scopes[0] !== "publish"
  ) {
    return undefined
  }
  return {
    accessToken: item.accessToken,
    expiresAt: item.expiresAt,
    scopes: ["publish"]
  }
}

const releaseState = (value: unknown): ReleaseStatus["state"] | undefined => {
  switch (value) {
    case "accepted":
    case "compiled":
    case "committed":
    case "verified":
    case "cataloged":
    case "completed":
      return value
    default:
      return undefined
  }
}

export const parseReleaseStatus = (
  value: unknown
): ReleaseStatus | undefined => {
  const item = record(value)
  const state = releaseState(item?.state)
  if (
    typeof item?.id !== "string" ||
    item.id === "" ||
    state === undefined ||
    typeof item.slug !== "string" ||
    typeof item.version !== "string" ||
    (item.commit !== null && typeof item.commit !== "string") ||
    (item.receipt !== null && typeof item.receipt !== "string") ||
    typeof item.retryable !== "boolean" ||
    (item.error !== null && typeof item.error !== "string")
  ) {
    return undefined
  }
  return {
    id: item.id,
    state,
    slug: item.slug,
    version: item.version,
    commit: item.commit,
    receipt: item.receipt,
    retryable: item.retryable,
    error: item.error
  }
}
