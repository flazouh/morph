import {
  compilePackage,
  type CompiledPackage,
  type CompilerPorts,
  type PackageSource
} from "./compile"
import { PackageCompileError } from "./error"

export type PackageCompileAsk = {
  readonly type: "compileMorphPackage"
  readonly source: PackageSource
}

export type PackageCompileAnswer =
  | {
      readonly type: "morphPackageCompiled"
      readonly compiled: CompiledPackage
    }
  | {
      readonly type: "morphPackageCompileFailed"
      readonly error: {
        readonly message: string
        readonly reason: string
        readonly file?: string
        readonly id?: string
      }
    }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const isPackageCompileAsk = (value: unknown): value is PackageCompileAsk => {
  if (!isRecord(value) || value.type !== "compileMorphPackage" || !isRecord(value.source)) {
    return false
  }
  const { entry, style, files } = value.source
  return (
    typeof entry === "string" &&
    typeof style === "string" &&
    isRecord(files) &&
    Object.values(files).every((text) => typeof text === "string")
  )
}

export const packageCompileHandler =
  (ports: CompilerPorts) =>
  async (ask: PackageCompileAsk): Promise<PackageCompileAnswer> => {
    try {
      return {
        type: "morphPackageCompiled",
        compiled: await compilePackage(ask.source, ports)
      }
    } catch (cause) {
      if (cause instanceof PackageCompileError) {
        return {
          type: "morphPackageCompileFailed",
          error: {
            message: cause.message,
            reason: cause.reason,
            ...(cause.file === undefined ? {} : { file: cause.file }),
            ...(cause.id === undefined ? {} : { id: cause.id })
          }
        }
      }
      return {
        type: "morphPackageCompileFailed",
        error: {
          message: cause instanceof Error ? cause.message : String(cause),
          reason: "compile"
        }
      }
    }
  }
