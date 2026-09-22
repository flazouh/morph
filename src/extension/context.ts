const INVALIDATED_CONTEXT_MESSAGE = "Extension context invalidated."

/** Chrome uses this exact error after an installed extension reloads around an open page. */
export const isInvalidatedExtensionContext = (error: unknown): boolean =>
  error !== null &&
  typeof error === "object" &&
  "message" in error &&
  (error as { readonly message?: unknown }).message === INVALIDATED_CONTEXT_MESSAGE
