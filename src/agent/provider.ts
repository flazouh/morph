import { Schema } from "effect"

/**
 * The brains a thread can run on. One name for both, so the setting that picks a provider
 * and the bill that reports one can never drift apart.
 */
export const Provider = Schema.Literals(["openrouter", "cursor"])
export type Provider = typeof Provider.Type
