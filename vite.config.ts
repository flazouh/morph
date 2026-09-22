import { resolve } from "node:path"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "vite"

/** Standalone web pages. WXT owns every Chrome extension entrypoint. */
export default defineConfig(({ mode }) => {
  const designSystem = mode === "design-system"
  const marketplace = mode === "marketplace"
  const input: Record<string, string> = designSystem
    ? { designSystem: resolve(import.meta.dirname, "design-system.html") }
    : marketplace
      ? { marketplace: resolve(import.meta.dirname, "marketplace.html") }
    : {
        marketplace: resolve(import.meta.dirname, "marketplace.html"),
        sandboxHost: resolve(import.meta.dirname, "sandbox-host.html"),
        sandbox: resolve(import.meta.dirname, "sandbox.html")
      }
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": resolve(import.meta.dirname, "src"),
        // The Bedrock adapter is never used; alias it to a stub so the bundle stays small
        // and free of Node-only code.
        "@aws-sdk/client-bedrock-runtime": resolve(import.meta.dirname, "src/stubs/bedrock.ts"),
        "@tanstack/ai-bedrock": resolve(import.meta.dirname, "src/stubs/bedrock.ts")
      }
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
      target: "es2022",
      sourcemap: !marketplace,
      rollupOptions: {
        input,
        output: {
          entryFileNames: "[name].js",
          chunkFileNames: "chunks/[name]-[hash].js",
          assetFileNames: "assets/[name]-[hash][extname]"
        }
      },
    }
  }
})
