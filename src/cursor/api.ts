import { Context, Effect, Layer, Option, Predicate, Schema, Stream } from "effect"

/**
 * Morph's binding to the Cursor Cloud Agents API v1.
 *
 * One Morph thread owns one Cursor agent. The first send creates the agent and its first
 * run; later sends create runs on that agent. Every run is read back over the run's
 * Server-Sent Events stream. Nothing here knows about pages, tools or the panel: it turns
 * documented requests into decoded values and reader-safe failures.
 *
 * Documented at https://cursor.com/docs/cloud-agent/api/endpoints, checked 2026-09-09.
 */

export const CURSOR_API = "https://api.cursor.com"

/** The transport. Tests script it; the service worker leaves it to the browser. */
export type CursorFetch = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1]
) => Promise<Response>

export const CursorRunStatus = Schema.Literals([
  "CREATING",
  "RUNNING",
  "FINISHED",
  "ERROR",
  "CANCELLED",
  "EXPIRED"
])
export type CursorRunStatus = typeof CursorRunStatus.Type
export type CursorTerminalStatus = Exclude<CursorRunStatus, "CREATING" | "RUNNING">

/** The agent's own lifecycle. `ARCHIVED` agents take no new runs. */
export const CursorAgentStatus = Schema.Literals(["ACTIVE", "IDLE", "ARCHIVED"])
export type CursorAgentStatus = typeof CursorAgentStatus.Type

const TERMINAL: ReadonlySet<string> = new Set(["FINISHED", "ERROR", "CANCELLED", "EXPIRED"])

/** A run that reached one of the four documented end states. */
export const isTerminal = (status: string): status is CursorTerminalStatus =>
  TERMINAL.has(status)

/**
 * Cursor answered, and refused. `code` is Cursor's machine-readable code and `detail` is
 * Cursor's own sentence, which the reader may see. Nothing else from the response travels.
 */
export class CursorApiError extends Schema.TaggedError<CursorApiError>()("CursorApiError", {
  status: Schema.Number,
  code: Schema.String,
  detail: Schema.String
}) {
  override readonly message = this.detail
}

/** Cursor could not be reached or did not answer in a shape Morph reads. */
export class CursorTransportError extends Schema.TaggedError<CursorTransportError>()(
  "CursorTransportError",
  { detail: Schema.String }
) {
  override readonly message = this.detail
}

export type CursorFailure = CursorApiError | CursorTransportError

/** The agent this thread stored is gone: deleted, archived, or expired past Cursor's window. */
export const isAgentGone = (failure: CursorFailure): boolean =>
  failure._tag === "CursorApiError" &&
  (failure.code === "agent_not_found" ||
    failure.code === "agent_archived" ||
    failure.status === 404 ||
    failure.status === 410)

/** The agent already has a run in flight. Only one run may be active per agent. */
export const isAgentBusy = (failure: CursorFailure): boolean =>
  failure._tag === "CursorApiError" && failure.code === "agent_busy"

/** Cancel reached a run that had already settled. Cursor documents this as a `409`. */
export const isRunNotCancellable = (failure: CursorFailure): boolean =>
  failure._tag === "CursorApiError" && failure.code === "run_not_cancellable"

/** Cursor rejected the key. */
export const isUnauthorized = (failure: CursorFailure): boolean =>
  failure._tag === "CursorApiError" && (failure.status === 401 || failure.code === "unauthorized")

export const CursorMcpServer = Schema.Struct({
  name: Schema.NonEmptyString,
  type: Schema.Literal("http"),
  url: Schema.NonEmptyString,
  headers: Schema.Record(Schema.String, Schema.String)
})
export type CursorMcpServer = typeof CursorMcpServer.Type

const RunRef = Schema.Struct({
  id: Schema.NonEmptyString,
  status: Schema.optionalKey(CursorRunStatus)
})

const CreateAgentResponse = Schema.Struct({
  agent: Schema.Struct({ id: Schema.NonEmptyString }),
  run: RunRef
})

const CreateRunResponse = Schema.Struct({ run: RunRef })

/** Get A Run: the run's own record, with its final reply when it has one. */
const GetRunResponse = Schema.Struct({
  id: Schema.NonEmptyString,
  status: CursorRunStatus,
  result: Schema.optionalKey(Schema.String)
})

/** Get An Agent: the lifecycle status and the run the agent is on. */
const GetAgentResponse = Schema.Struct({
  id: Schema.NonEmptyString,
  status: CursorAgentStatus,
  latestRunId: Schema.optionalKey(Schema.NonEmptyString)
})

export const CursorAgentUsage = Schema.Struct({
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  cacheWriteTokens: Schema.Number,
  cacheReadTokens: Schema.Number,
  totalTokens: Schema.Number
})
export type CursorAgentUsage = typeof CursorAgentUsage.Type

const AgentUsageResponse = Schema.Struct({
  totalUsage: CursorAgentUsage
})

const CursorErrorBody = Schema.Struct({
  error: Schema.Struct({
    code: Schema.String,
    message: Schema.String
  })
})

const StatusData = Schema.Struct({ status: CursorRunStatus })
const TextData = Schema.Struct({ text: Schema.String })
const ResultData = Schema.Struct({
  status: CursorRunStatus,
  text: Schema.optionalKey(Schema.String)
})
const ErrorData = Schema.Struct({ code: Schema.String, message: Schema.String })
/** Cursor's account of one tool call: `running` when it is issued, `completed` when it returned. */
const ToolCallData = Schema.Struct({
  callId: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.String)
})

/**
 * Which subagent a `task` call went to. Seen live as a one-key object in the style of a
 * protobuf oneof, `{"computerUse":{}}`, and as `{"kind":"computerUse"}` in the richer
 * `interaction_update` frame. The Task tool's own parameter is the snake_case string. All
 * three are read; `roleOfSubagentType` turns each into the role's name.
 */
const SubagentType = Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.Unknown)])

/**
 * The `task` tool call: Cursor's agent handing a brief to a subagent. Cursor documents the
 * envelope and calls the inner shape internal, so every field here is optional and the
 * names are the ones the Task tool takes today. A frame without them is still a subagent
 * frame, only nameless.
 */
const TaskCallData = Schema.Struct({
  callId: Schema.String,
  status: Schema.optionalKey(Schema.String),
  args: Schema.optionalKey(
    Schema.Struct({
      subagentType: Schema.optionalKey(SubagentType),
      subagent_type: Schema.optionalKey(SubagentType),
      description: Schema.optionalKey(Schema.String),
      prompt: Schema.optionalKey(Schema.String)
    })
  ),
  result: Schema.optionalKey(
    Schema.Struct({
      success: Schema.optionalKey(Schema.Struct({ output: Schema.optionalKey(Schema.String) })),
      error: Schema.optionalKey(Schema.Struct({ message: Schema.optionalKey(Schema.String) }))
    })
  )
})
const TASK_TOOL_NAMES: ReadonlySet<string> = new Set(["task", "Task"])

const decodeCreateAgent = Schema.decodeUnknownOption(CreateAgentResponse)
const decodeCreateRun = Schema.decodeUnknownOption(CreateRunResponse)
const decodeGetRun = Schema.decodeUnknownOption(GetRunResponse)
const decodeGetAgent = Schema.decodeUnknownOption(GetAgentResponse)
const decodeAgentUsage = Schema.decodeUnknownOption(AgentUsageResponse)
const decodeErrorBody = Schema.decodeUnknownOption(CursorErrorBody)
const decodeStatusData = Schema.decodeUnknownOption(Schema.fromJsonString(StatusData))
const decodeTextData = Schema.decodeUnknownOption(Schema.fromJsonString(TextData))
const decodeResultData = Schema.decodeUnknownOption(Schema.fromJsonString(ResultData))
const decodeErrorData = Schema.decodeUnknownOption(Schema.fromJsonString(ErrorData))
const decodeToolCallData = Schema.decodeUnknownOption(Schema.fromJsonString(ToolCallData))
const decodeTaskCallData = Schema.decodeUnknownOption(Schema.fromJsonString(TaskCallData))

/**
 * What Morph reads from a run stream. `interaction_update` and `heartbeat` are dropped
 * on purpose. A `tool_call` frame is kept as a boundary between text segments that says
 * whether the call is running: tool steps come from the extension's own execution, never
 * from Cursor's account of it, but the running frame lands before the relay call does,
 * and a stream read after the run ended has no other mark of where a tool ran.
 *
 * The one tool call read in full is `task`: the agent handing a brief to a subagent. That
 * never reaches the extension, since the subagent's own page tools do, one by one, so the
 * frame is the only record of the delegation. It becomes a `subagent` event with the
 * role, the title and the brief when running, and the subagent's answer when done.
 *
 * `id` is the SSE event id Cursor puts on most events. Morph tracks it so a broken read
 * can resume with `Last-Event-ID` instead of replaying the run from the top.
 */
export type CursorEvent =
  | { readonly _tag: "status"; readonly status: CursorRunStatus; readonly id?: string }
  | { readonly _tag: "assistant"; readonly text: string; readonly id?: string }
  | { readonly _tag: "thinking"; readonly text: string; readonly id?: string }
  | { readonly _tag: "toolCall"; readonly running: boolean; readonly id?: string }
  | {
      readonly _tag: "subagent"
      readonly callId: string
      readonly running: boolean
      readonly role?: string
      readonly title?: string
      readonly brief?: string
      readonly output?: string
      readonly id?: string
    }
  | { readonly _tag: "result"; readonly status: CursorRunStatus; readonly text?: string; readonly id?: string }
  | { readonly _tag: "error"; readonly code: string; readonly message: string; readonly id?: string }
  | { readonly _tag: "done"; readonly id?: string }

export interface CreateAgentInput {
  readonly apiKey: string
  readonly prompt: string
  /** A Cursor model id. Omit to let Cursor resolve the account default. */
  readonly model?: string
  readonly mcpServers: ReadonlyArray<CursorMcpServer>
  /** The crew roles the agent may delegate to. Each runs on the parent's model. */
  readonly customSubagents?: ReadonlyArray<CursorSubagent>
  readonly signal?: AbortSignal
}

/** One custom subagent as Cursor's create call takes it; `model` is added as `inherit`. */
export interface CursorSubagent {
  readonly name: string
  readonly description: string
  readonly prompt: string
}

export interface CreateRunInput {
  readonly apiKey: string
  readonly agentId: string
  readonly prompt: string
  readonly mcpServers: ReadonlyArray<CursorMcpServer>
  readonly signal?: AbortSignal
}

export interface RunRefInput {
  readonly apiKey: string
  readonly agentId: string
  readonly runId: string
  /**
   * Ends the call from Morph's side. Cancelling the run is a separate Cursor call; this
   * only stops Morph waiting on an answer that may never come.
   */
  readonly signal?: AbortSignal
}

export interface StreamRunInput extends RunRefInput {
  /**
   * The last event id a previous read of this run saw. Sent as `Last-Event-ID`, so a
   * resumed stream starts where the broken one stopped instead of replaying the run.
   */
  readonly lastEventId?: string
}

export interface AgentRefInput {
  readonly apiKey: string
  readonly agentId: string
  readonly signal?: AbortSignal
}

export type AgentUsageInput = AgentRefInput

export interface CreatedAgent {
  readonly agentId: string
  readonly runId: string
  readonly status: CursorRunStatus
}

export interface CreatedRun {
  readonly runId: string
  readonly status: CursorRunStatus
}

/** What Get A Run answers: where the run is, and its final reply when it has one. */
export interface CursorRunInfo {
  readonly runId: string
  readonly status: CursorRunStatus
  readonly result?: string
}

/** What Get An Agent answers: the lifecycle, and the run the agent is on. */
export interface CursorAgentInfo {
  readonly agentId: string
  readonly status: CursorAgentStatus
  readonly latestRunId?: string
}

/** One SSE frame: the `event:` name, the joined `data:` lines, and the resume id. */
interface Frame {
  readonly event: string
  readonly data: string
  readonly id?: string
}

const framesOf = (block: string): Frame | undefined => {
  let event = ""
  let id: string | undefined
  const data: Array<string> = []
  for (const raw of block.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw
    if (line === "" || line.startsWith(":")) continue
    const separator = line.indexOf(":")
    const field = separator === -1 ? line : line.slice(0, separator)
    const rest = separator === -1 ? "" : line.slice(separator + 1)
    const value = rest.startsWith(" ") ? rest.slice(1) : rest
    if (field === "event") event = value
    else if (field === "data") data.push(value)
    else if (field === "id") id = value
  }
  return event === "" ? undefined : { event, data: data.join("\n"), ...(id === undefined ? {} : { id }) }
}

const eventOf = (frame: Frame): CursorEvent | undefined => {
  const id = frame.id === undefined ? {} : { id: frame.id }
  if (frame.event === "status") {
    const decoded = decodeStatusData(frame.data)
    return Option.isNone(decoded) ? undefined : { _tag: "status", status: decoded.value.status, ...id }
  }
  if (frame.event === "assistant" || frame.event === "thinking") {
    const decoded = decodeTextData(frame.data)
    if (Option.isNone(decoded)) return undefined
    return frame.event === "assistant"
      ? { _tag: "assistant", text: decoded.value.text, ...id }
      : { _tag: "thinking", text: decoded.value.text, ...id }
  }
  if (frame.event === "result") {
    const decoded = decodeResultData(frame.data)
    if (Option.isNone(decoded)) return undefined
    const { status, text } = decoded.value
    return text === undefined ? { _tag: "result", status, ...id } : { _tag: "result", status, text, ...id }
  }
  if (frame.event === "error") {
    const decoded = decodeErrorData(frame.data)
    if (Option.isNone(decoded)) return undefined
    return { _tag: "error", code: decoded.value.code, message: decoded.value.message, ...id }
  }
  if (frame.event === "done") return { _tag: "done", ...id }
  if (frame.event === "tool_call") {
    const decoded = decodeToolCallData(frame.data)
    const status = Option.isNone(decoded) ? undefined : decoded.value.status
    const running = status === "running"
    if (Option.isSome(decoded) && decoded.value.name !== undefined && TASK_TOOL_NAMES.has(decoded.value.name)) {
      const task = decodeTaskCallData(frame.data)
      if (Option.isSome(task)) return { _tag: "subagent", ...subagentOf(task.value, running), ...id }
    }
    return { _tag: "toolCall", running, ...id }
  }
  return undefined
}

/**
 * The role name in a subagent type. A string is the name. An object names the role in its
 * `name`, else its `kind`, else its one key; a custom role nested under that key, as in
 * `{"custom":{"name":"reviewer"}}`, is read through to the name.
 */
export const roleOfSubagentType = (value: typeof SubagentType.Type | undefined): string | undefined => {
  if (value === undefined) return undefined
  if (Predicate.isString(value)) return value
  const name = value.name
  if (Predicate.isString(name)) return name
  const kind = value.kind
  if (Predicate.isString(kind)) return kind
  const keys = Object.keys(value)
  const key = keys[0]
  if (key === undefined || keys.length !== 1) return undefined
  const inner = value[key]
  if (Predicate.isObject(inner) && Predicate.isString(inner.name)) return inner.name
  return key
}

const subagentOf = (
  task: typeof TaskCallData.Type,
  running: boolean
): { callId: string; running: boolean; role?: string; title?: string; brief?: string; output?: string } => {
  const role = roleOfSubagentType(task.args?.subagentType ?? task.args?.subagent_type)
  if (running) {
    return {
      callId: task.callId,
      running,
      ...(role === undefined ? {} : { role }),
      ...(task.args?.description === undefined ? {} : { title: task.args.description }),
      ...(task.args?.prompt === undefined ? {} : { brief: task.args.prompt })
    }
  }
  const output = task.result?.success?.output ?? task.result?.error?.message
  return { callId: task.callId, running, ...(role === undefined ? {} : { role }), ...(output === undefined ? {} : { output }) }
}

/**
 * Reads one SSE body into the events Morph uses. A frame Morph does not read, and a frame
 * whose data does not decode, are both skipped: one bad frame must not end a live run.
 */
const STOPPED = Symbol("stopped")

/** Resolves once, when the caller stops reading. A pending body read never resolves by itself. */
const stopped = (signal: AbortSignal | undefined): Promise<typeof STOPPED> =>
  new Promise((resolve) => {
    if (signal === undefined) return
    if (signal.aborted) {
      resolve(STOPPED)
      return
    }
    signal.addEventListener("abort", () => resolve(STOPPED), { once: true })
  })

const cursorEvents = async function* (
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): AsyncGenerator<CursorEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const stop = stopped(signal)
  let buffer = ""
  try {
    for (;;) {
      // An aborted browser fetch rejects the pending read. That is the caller stopping,
      // not a broken stream, so it ends the read the same way the signal does.
      const chunk = await Promise.race([reader.read(), stop]).catch(
        (error: unknown): typeof STOPPED => {
          if (signal?.aborted === true) return STOPPED
          throw error
        }
      )
      if (chunk === STOPPED || chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      let split = buffer.indexOf("\n\n")
      while (split !== -1) {
        const block = buffer.slice(0, split)
        buffer = buffer.slice(split + 2)
        const frame = framesOf(block)
        const event = frame === undefined ? undefined : eventOf(frame)
        if (event !== undefined) yield event
        split = buffer.indexOf("\n\n")
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

const authHeaders = (apiKey: string): Record<string, string> => ({
  Authorization: `Bearer ${apiKey}`
})

export class CursorClient extends Context.Service<
  CursorClient,
  {
    readonly createAgent: (input: CreateAgentInput) => Effect.Effect<CreatedAgent, CursorFailure>
    readonly createRun: (input: CreateRunInput) => Effect.Effect<CreatedRun, CursorFailure>
    readonly streamRun: (input: StreamRunInput) => Stream.Stream<CursorEvent, CursorFailure>
    readonly getRun: (input: RunRefInput) => Effect.Effect<CursorRunInfo, CursorFailure>
    readonly getAgent: (input: AgentRefInput) => Effect.Effect<CursorAgentInfo, CursorFailure>
    readonly cancelRun: (input: RunRefInput) => Effect.Effect<void, CursorFailure>
    readonly archiveAgent: (input: AgentRefInput) => Effect.Effect<void, CursorFailure>
    readonly getAgentUsage: (input: AgentUsageInput) => Effect.Effect<CursorAgentUsage, CursorFailure>
  }
>()("morph/cursor/CursorClient") {
  static readonly layerWith = (fetchImpl: CursorFetch): Layer.Layer<CursorClient> =>
    Layer.succeed(CursorClient, makeCursorClient(fetchImpl))

  static readonly layer: Layer.Layer<CursorClient> = Layer.sync(CursorClient, () =>
    makeCursorClient((input, init) => fetch(input, init))
  )
}

const makeCursorClient = (fetchImpl: CursorFetch): CursorClient["Service"] => {
  const request = Effect.fn("CursorClient.request")(function* (
    path: string,
    apiKey: string,
    body: unknown,
    signal?: AbortSignal
  ): Effect.fn.Return<Response, CursorFailure> {
    const response = yield* Effect.tryPromise({
      try: () =>
        fetchImpl(`${CURSOR_API}${path}`, {
          method: "POST",
          headers: { ...authHeaders(apiKey), "Content-Type": "application/json" },
          body: JSON.stringify(body),
          ...(signal === undefined ? {} : { signal })
        }),
      catch: () => new CursorTransportError({ detail: "Could not reach Cursor." })
    })
    if (!response.ok) return yield* failureOf(response)
    return response
  })

  const failureOf = Effect.fn("CursorClient.failureOf")(function* (
    response: Response
  ): Effect.fn.Return<never, CursorApiError> {
    const payload = yield* Effect.tryPromise(() => response.json()).pipe(Effect.option)
    const decoded = Option.isNone(payload) ? Option.none() : decodeErrorBody(payload.value)
    if (Option.isSome(decoded) && decoded.value.error.message !== "") {
      return yield* new CursorApiError({
        status: response.status,
        code: decoded.value.error.code,
        detail: decoded.value.error.message
      })
    }
    return yield* new CursorApiError({
      status: response.status,
      code: "",
      detail: `Cursor refused the request (${response.status}).`
    })
  })

  const readJson = Effect.fn("CursorClient.readJson")(function* (
    response: Response
  ): Effect.fn.Return<unknown, CursorTransportError> {
    return yield* Effect.tryPromise({
      try: () => response.json(),
      catch: () => new CursorTransportError({ detail: "Cursor returned an unreadable response." })
    })
  })

  const unexpected = new CursorTransportError({ detail: "Cursor returned an unexpected response." })

  const createAgent = Effect.fn("CursorClient.createAgent")(function* (
    input: CreateAgentInput
  ): Effect.fn.Return<CreatedAgent, CursorFailure> {
    // No `repos` and no `env` is what Cursor documents as a no-repository agent. Morph's
    // agent works on the page through the extension's tools, so it never needs one.
    const body = {
      prompt: { text: input.prompt },
      ...(input.model === undefined || input.model === "" ? {} : { model: { id: input.model } }),
      mcpServers: input.mcpServers,
      ...(input.customSubagents === undefined || input.customSubagents.length === 0
        ? {}
        : { customSubagents: input.customSubagents.map((role) => ({ ...role, model: "inherit" })) })
    }
    const response = yield* request("/v1/agents", input.apiKey, body, input.signal)
    const decoded = decodeCreateAgent(yield* readJson(response))
    if (Option.isNone(decoded)) return yield* unexpected
    return {
      agentId: decoded.value.agent.id,
      runId: decoded.value.run.id,
      status: decoded.value.run.status ?? "CREATING"
    }
  })

  const createRun = Effect.fn("CursorClient.createRun")(function* (
    input: CreateRunInput
  ): Effect.fn.Return<CreatedRun, CursorFailure> {
    const response = yield* request(
      `/v1/agents/${encodeURIComponent(input.agentId)}/runs`,
      input.apiKey,
      { prompt: { text: input.prompt }, mcpServers: input.mcpServers },
      input.signal
    )
    const decoded = decodeCreateRun(yield* readJson(response))
    if (Option.isNone(decoded)) return yield* unexpected
    return { runId: decoded.value.run.id, status: decoded.value.run.status ?? "CREATING" }
  })

  const openStream = Effect.fn("CursorClient.openStream")(function* (
    input: StreamRunInput
  ): Effect.fn.Return<Stream.Stream<CursorEvent, CursorFailure>, CursorFailure> {
    const response = yield* Effect.tryPromise({
      try: () =>
        fetchImpl(
          `${CURSOR_API}/v1/agents/${encodeURIComponent(input.agentId)}/runs/${encodeURIComponent(input.runId)}/stream`,
          {
            headers: {
              ...authHeaders(input.apiKey),
              Accept: "text/event-stream",
              ...(input.lastEventId === undefined ? {} : { "Last-Event-ID": input.lastEventId })
            },
            ...(input.signal === undefined ? {} : { signal: input.signal })
          }
        ),
      catch: () => new CursorTransportError({ detail: "Could not reach Cursor." })
    })
    if (!response.ok) return yield* failureOf(response)
    const body = response.body
    if (body === null) return yield* new CursorTransportError({ detail: "Cursor sent an empty run stream." })
    return Stream.fromAsyncIterable(
      cursorEvents(body, input.signal),
      () => new CursorTransportError({ detail: "The Cursor run stream stopped." })
    )
  })

  const cancelRun = Effect.fn("CursorClient.cancelRun")(function* (
    input: RunRefInput
  ): Effect.fn.Return<void, CursorFailure> {
    yield* request(
      `/v1/agents/${encodeURIComponent(input.agentId)}/runs/${encodeURIComponent(input.runId)}/cancel`,
      input.apiKey,
      {}
    )
  })

  /** A documented GET: the same transport and refusal handling as a POST, with no body. */
  const getJson = Effect.fn("CursorClient.getJson")(function* (
    path: string,
    apiKey: string,
    signal?: AbortSignal
  ): Effect.fn.Return<unknown, CursorFailure> {
    const response = yield* Effect.tryPromise({
      try: () =>
        fetchImpl(`${CURSOR_API}${path}`, {
          headers: authHeaders(apiKey),
          ...(signal === undefined ? {} : { signal })
        }),
      catch: () => new CursorTransportError({ detail: "Could not reach Cursor." })
    })
    if (!response.ok) return yield* failureOf(response)
    return yield* readJson(response)
  })

  const getRun = Effect.fn("CursorClient.getRun")(function* (
    input: RunRefInput
  ): Effect.fn.Return<CursorRunInfo, CursorFailure> {
    const payload = yield* getJson(
      `/v1/agents/${encodeURIComponent(input.agentId)}/runs/${encodeURIComponent(input.runId)}`,
      input.apiKey,
      input.signal
    )
    const decoded = decodeGetRun(payload)
    if (Option.isNone(decoded)) return yield* unexpected
    return {
      runId: decoded.value.id,
      status: decoded.value.status,
      ...(decoded.value.result === undefined ? {} : { result: decoded.value.result })
    }
  })

  const getAgent = Effect.fn("CursorClient.getAgent")(function* (
    input: AgentRefInput
  ): Effect.fn.Return<CursorAgentInfo, CursorFailure> {
    const payload = yield* getJson(
      `/v1/agents/${encodeURIComponent(input.agentId)}`,
      input.apiKey,
      input.signal
    )
    const decoded = decodeGetAgent(payload)
    if (Option.isNone(decoded)) return yield* unexpected
    return {
      agentId: decoded.value.id,
      status: decoded.value.status,
      ...(decoded.value.latestRunId === undefined ? {} : { latestRunId: decoded.value.latestRunId })
    }
  })

  const archiveAgent = Effect.fn("CursorClient.archiveAgent")(function* (
    input: AgentRefInput
  ): Effect.fn.Return<void, CursorFailure> {
    yield* request(`/v1/agents/${encodeURIComponent(input.agentId)}/archive`, input.apiKey, {})
  })

  const getAgentUsage = Effect.fn("CursorClient.getAgentUsage")(function* (
    input: AgentUsageInput
  ): Effect.fn.Return<CursorAgentUsage, CursorFailure> {
    const payload = yield* getJson(
      `/v1/agents/${encodeURIComponent(input.agentId)}/usage`,
      input.apiKey,
      input.signal
    )
    const decoded = decodeAgentUsage(payload)
    if (Option.isNone(decoded)) return yield* unexpected
    return decoded.value.totalUsage
  })

  return CursorClient.of({
    createAgent,
    createRun,
    streamRun: (input) => Stream.unwrap(openStream(input)),
    getRun,
    getAgent,
    cancelRun,
    archiveAgent,
    getAgentUsage
  })
}
