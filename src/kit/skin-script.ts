/**
 * The seam between the compiler and the kit: the shape of a compiled skin, and the page
 * script that hands one to the kit. They sit together so the wrapper string and the
 * signature it must match cannot drift apart.
 */

/**
 * A compiled skin: the CommonJS body sucrase makes of the model's skin.tsx. It exports
 * `default`, the component, and may export `target`, the selector of the region it
 * replaces. `require` answers from the kit's modules table. `module.exports = C` is
 * honoured too: sucrase leaves a reassignment as written.
 */
export type SkinBody = (require: (id: string) => unknown, exports: Record<string, unknown>, module: { exports: unknown }) => void

/** What one skin adds to the kit's modules, by module id: the icons it imports, inlined. */
export type SkinExtras = Readonly<Record<string, Readonly<Record<string, unknown>>>>

/**
 * The page script a compiled skin becomes: one call into the kit, the body as a function
 * so `require`, `exports` and `module` are its own, then its CSS and its extras. It names
 * `__beui`, so the loader carries the kit with it on later loads.
 */
export const skinScript = (js: string, css: string, extras: SkinExtras = {}): string =>
  `window.__beui.skin(function (require, exports, module) {\n${js}\n}, ${JSON.stringify(css)}, ${JSON.stringify(extras)})`
