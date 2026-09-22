import type { ToolStep } from "../session/contract"
import type { CursorEvent } from "./api"

/**
 * A Cursor delegation (its `task` tool call) shown as the crew's own `spawn_agent` step, so
 * the card draws it as a bot with the role's seed. The call id is prefixed: the subagent's
 * page tools arrive through the relay under Cursor's own call ids, and must not collide.
 */
export const delegationCallId = (cursorCallId: string): string => `cursor-task:${cursorCallId}`

export const delegationStep = (
  event: Extract<CursorEvent, { _tag: "subagent" }>,
  at: number,
  previous: ToolStep | undefined
): ToolStep => {
  const callId = delegationCallId(event.callId)
  const input = previous?.input ?? {
    ...(event.role === undefined ? {} : { role: event.role }),
    ...(event.title === undefined ? {} : { title: event.title }),
    ...(event.brief === undefined ? {} : { brief: event.brief })
  }
  if (event.running) return { kind: "tool", callId, name: "spawn_agent", input, at }
  return {
    kind: "tool",
    callId,
    name: "spawn_agent",
    input,
    result: {
      id: event.role ?? event.callId,
      ...(event.role === undefined ? {} : { role: event.role }),
      ...(event.output === undefined ? {} : { output: event.output })
    },
    at: previous?.at ?? at
  }
}
