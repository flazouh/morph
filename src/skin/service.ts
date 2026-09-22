import { Context, Effect, Layer } from "effect"
import { CompileFailure, compileSkin, type Compiled, type Icons, type Sheets, type SkinFiles } from "./compile"

export { CompileFailure }

/**
 * The compiler as the tools see it: sources in, JS, CSS and icons out, or a failure whose
 * message the model can act on. The panel binds it to the bundled sheets and the icon set;
 * tests bind it to the same sheets read from disk and a few icons, or to a fake.
 */
export class Compiler extends Context.Service<
  Compiler,
  {
    readonly compile: (files: SkinFiles) => Effect.Effect<Compiled, CompileFailure>
  }
>()("redesign/Compiler") {}

export const skinCompiler = (sheets: Sheets, icons: Icons): Layer.Layer<Compiler> =>
  Layer.succeed(Compiler, {
    compile: (files) =>
      Effect.tryPromise({
        try: () => compileSkin(files, sheets, icons),
        catch: (e) => (e instanceof CompileFailure ? e : new CompileFailure(e instanceof Error ? e.message : String(e)))
      })
  })
