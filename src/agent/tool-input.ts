/**
 * What every tool module does with a model's call: read one field of an untyped input,
 * declare a closed JSON schema, and hand a failure back as a `ToolError` instead of a
 * thrown one. Shared here so the page tools, the fork tools and the page publish tools
 * read a call the same way.
 */
import { Effect, Predicate, Schema } from "effect"
import type { ToolError } from "./tool-names"

/** The string at `key`, or nothing. Models send "" for "none", so an empty string is none. */
export const str = (input: unknown, key: string): string | undefined => {
  if (!Predicate.isObject(input)) return undefined
  const value = input[key]
  return Predicate.isString(value) && value !== "" ? value : undefined
}

/** A tool's own refusal: one line the model reads as the tool's answer. */
export class ToolFailure extends Schema.TaggedError<ToolFailure>()("ToolFailure", { message: Schema.String }) {}

/** A closed object schema: what is listed is all a call may carry. */
export const object = (properties: Record<string, unknown>, required: ReadonlyArray<string>) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false
})

/** Anything thrown, as a `ToolFailure` carrying its message. */
export const failure = (cause: unknown): ToolFailure => new ToolFailure({ message: cause instanceof Error ? cause.message : String(cause) })

/** The result, or the failure's message as the tool's error: a tool never fails its run. */
export const asAnswer = <A, E extends Error, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<unknown, never, R> =>
  Effect.match(effect, {
    onFailure: (error): ToolError => ({ error: error.message }),
    onSuccess: (value) => value
  })
