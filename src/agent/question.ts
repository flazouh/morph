import { Effect, Predicate } from "effect"
import type { ToolError } from "./tool-names"

export interface AskUserOption {
  readonly id: string
  readonly label: string
  readonly description?: string
}

/** The draft id a page's own redesign publishes under: there is no draft, only the page. */
export const PAGE_DRAFT_ID = "page"

export interface PublishAuthorization {
  readonly action: "publish_morph"
  /** A local fork draft's id, or `PAGE_DRAFT_ID` for the page's own redesign. */
  readonly draftId: string
  readonly revisionId: string
  readonly name: string
  readonly slug: string
  readonly summary: string
  readonly version: string
  readonly addedPermissions: ReadonlyArray<string>
}

export interface AskUserQuestion {
  readonly question: string
  readonly title?: string
  readonly description?: string
  readonly asciiPreview?: string
  readonly options: ReadonlyArray<AskUserOption>
  readonly allowMultiple: boolean
  readonly authorization?: PublishAuthorization
}

export interface AskUserResult {
  /**
   * The call this answer belongs to, which `publish_morph` takes as its
   * `confirmationCallId`. It is said here because a model cannot know it otherwise: under
   * a provider that runs Morph's tools over MCP, the call id is minted on this side.
   */
  readonly callId: string
  readonly selected: ReadonlyArray<AskUserOption>
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const optionalText = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined

const publishQuestion = (authorization: PublishAuthorization): string => {
  const permissions =
    authorization.addedPermissions.length === 0
      ? "none"
      : authorization.addedPermissions.join(", ")
  return `Publish ${authorization.name} (${authorization.slug}) version ${authorization.version} from revision ${authorization.revisionId}? Summary: ${authorization.summary} Added permissions: ${permissions}.`
}

/**
 * The authorization as the model wrote it. Models often write a nested object as a string
 * of JSON, so a string is read as JSON first and then checked field by field, exactly as
 * an object is. Nothing is trusted either way: the publish is only allowed when these
 * fields match the release the tool later asks to publish.
 */
const authorizationValue = (value: unknown): unknown => {
  if (!Predicate.isString(value)) return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

const publishAuthorizationOf = (
  value: unknown
): PublishAuthorization | undefined => {
  const authorization = record(authorizationValue(value))
  if (authorization?.["action"] !== "publish_morph") return undefined
  const draftId = optionalText(authorization["draftId"])
  const revisionId = optionalText(authorization["revisionId"])
  const name = optionalText(authorization["name"])
  const slug = optionalText(authorization["slug"])
  const summary = optionalText(authorization["summary"])
  const version = optionalText(authorization["version"])
  const addedPermissions = authorization["addedPermissions"]
  if (
    draftId === undefined ||
    revisionId === undefined ||
    name === undefined ||
    slug === undefined ||
    summary === undefined ||
    version === undefined ||
    !Array.isArray(addedPermissions) ||
    !addedPermissions.every((permission): permission is string =>
      optionalText(permission) !== undefined
    ) ||
    new Set(addedPermissions).size !== addedPermissions.length
  ) {
    return undefined
  }
  return {
    action: "publish_morph",
    draftId,
    revisionId,
    name,
    slug,
    summary,
    version,
    addedPermissions
  }
}

export const questionOf = (input: unknown): AskUserQuestion | ToolError => {
  const value = record(input)
  const question = optionalText(value?.["question"])
  const rawOptions = value?.["options"]
  if (question === undefined) return { error: "ask_user needs a question" }
  if (!Array.isArray(rawOptions) || rawOptions.length < 2) {
    return { error: "ask_user needs at least two options" }
  }

  const options = rawOptions.flatMap((raw): ReadonlyArray<AskUserOption> => {
    const option = record(raw)
    const id = optionalText(option?.["id"])
    const label = optionalText(option?.["label"])
    if (id === undefined || label === undefined) return []
    const description = optionalText(option?.["description"])
    return [{ id, label, ...(description === undefined ? {} : { description }) }]
  })
  if (options.length !== rawOptions.length || new Set(options.map((option) => option.id)).size !== options.length) {
    return { error: "ask_user options need unique non-empty ids and labels" }
  }

  const title = optionalText(value?.["title"])
  const description = optionalText(value?.["description"])
  const asciiPreview = optionalText(value?.["asciiPreview"])
  const rawAuthorization = value?.["authorization"]
  const authorization = publishAuthorizationOf(rawAuthorization)
  if (rawAuthorization !== undefined && authorization === undefined) {
    return { error: "ask_user has an invalid publish authorization" }
  }
  const allowMultiple = value?.["allowMultiple"] === true
  if (
    authorization !== undefined &&
    (allowMultiple || !options.some((option) => option.id === "publish"))
  ) {
    return {
      error: "a publish confirmation needs one publish option and single selection"
    }
  }
  return {
    question:
      authorization === undefined ? question : publishQuestion(authorization),
    options,
    allowMultiple,
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(asciiPreview === undefined ? {} : { asciiPreview }),
    ...(authorization === undefined ? {} : { authorization })
  }
}

interface Waiting {
  readonly question: AskUserQuestion
  readonly resolve: (result: AskUserResult | ToolError) => void
}

export interface QuestionController {
  readonly beginTurn: () => void
  readonly ask: (input: unknown, callId: string) => Effect.Effect<AskUserResult | ToolError>
  readonly answer: (callId: string, optionIds: ReadonlyArray<string>) => boolean
  readonly authorizePublish: (
    callId: string,
    expected: PublishAuthorization
  ) => boolean
  /** The release went out: this yes is used up and cannot publish a second time. */
  readonly spendPublish: (callId: string) => void
  /** A run ended: the questions it parked are dead, but the reader's yes still stands. */
  readonly cancelPending: () => void
  /** The reader stopped or closed the thread: nothing they said carries over. */
  readonly cancelAll: () => void
}

export const createQuestionController = (): QuestionController => {
  const waiting = new Map<string, Waiting>()
  const accepted = new Map<
    string,
    { readonly question: AskUserQuestion; readonly result: AskUserResult }
  >()

  return {
    /**
     * A new turn does not take back what the reader already agreed to. Under a provider
     * whose tool call can time out, the publish is retried in a turn after the one the
     * card was answered in, and clearing here left that publish with no evidence. The
     * evidence is safe to keep: it names one revision, `authorizePublish` spends it, and
     * `cancelAll` drops it when the reader stops or closes the thread.
     */
    beginTurn: () => {},
    ask: (input, callId) => {
      const question = questionOf(input)
      if ("error" in question) return Effect.succeed(question)
      return Effect.promise(
        () =>
          new Promise<AskUserResult | ToolError>((resolve) => {
            waiting.set(callId, { question, resolve })
          })
      )
    },
    answer: (callId, optionIds) => {
      const pending = waiting.get(callId)
      if (pending === undefined) return false
      const ids = [...new Set(optionIds)]
      if (ids.length === 0 || (!pending.question.allowMultiple && ids.length !== 1)) return false
      const selected = ids.flatMap((id) => {
        const option = pending.question.options.find((candidate) => candidate.id === id)
        return option === undefined ? [] : [option]
      })
      if (selected.length !== ids.length) return false
      waiting.delete(callId)
      const result = { callId, selected }
      accepted.set(callId, { question: pending.question, result })
      pending.resolve(result)
      return true
    },
    authorizePublish: (callId, expected) => {
      const evidence = accepted.get(callId)
      if (
        evidence?.question.authorization === undefined ||
        evidence.result.selected.length !== 1 ||
        evidence.result.selected[0]?.id !== "publish"
      ) {
        return false
      }
      const actual = evidence.question.authorization
      const samePermissions =
        [...actual.addedPermissions].sort().join("\u0000") ===
        [...expected.addedPermissions].sort().join("\u0000")
      const authorized =
        actual.action === expected.action &&
        actual.draftId === expected.draftId &&
        actual.revisionId === expected.revisionId &&
        actual.name === expected.name &&
        actual.slug === expected.slug &&
        actual.summary === expected.summary &&
        actual.version === expected.version &&
        samePermissions
      return authorized
    },
    /**
     * Spent when the release lands, not when it is authorized. A publish that passes the
     * gate and then fails on something else, a tab that moved out of the way, a network
     * that dropped, must be retryable without asking the reader to agree all over again.
     */
    spendPublish: (callId) => {
      accepted.delete(callId)
    },
    cancelPending: () => {
      for (const pending of waiting.values()) pending.resolve({ error: "question cancelled" })
      waiting.clear()
    },
    cancelAll: () => {
      for (const pending of waiting.values()) pending.resolve({ error: "question cancelled" })
      waiting.clear()
      accepted.clear()
    }
  }
}
