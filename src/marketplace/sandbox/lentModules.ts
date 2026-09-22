/**
 * The modules sandbox-v1 lends a package, by the names a package imports them under.
 *
 * Two places need this list and they must agree: the guest builds `require` from it, and
 * a package's build marks exactly these as external so it bundles no second copy. When
 * they drifted, nothing failed at build time. The package threw a string inside
 * `Function(...)` and the reader saw it as text in the frame.
 *
 * So the names live here alone, and the guest keys its table by them, which makes a
 * missing entry a type error rather than a message nobody reads until the extension is
 * open. This module holds names and nothing else, because a build config imports it and
 * must not pull the whole guest in with it.
 */
export const LENT_MODULE_IDS = [
  "effect",
  "effect/SchemaIssue",
  "effect/unstable/reactivity/AsyncResult",
  "effect/unstable/reactivity/Atom",
  "effect/unstable/reactivity/AtomRegistry",
  "react",
  "react-dom",
  "react-dom/client",
  "react/jsx-runtime"
] as const

export type LentModuleId = (typeof LENT_MODULE_IDS)[number]
