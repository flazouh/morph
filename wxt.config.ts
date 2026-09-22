import { resolve } from "node:path"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "wxt"
import packageJson from "./package.json" with { type: "json" }
import { ICONS_ASSET } from "./src/kit/module-ids"
import { packIconSet } from "./src/skin/icon-codec"

const root = import.meta.dirname
const icon = (size: 16 | 32 | 48 | 128): string => `icons/morph-${size}.png`

/**
 * The Hugeicons free set as one packed JSON file at the output root. The compilers fetch
 * it (src/skin/icons.ts): they run in the service worker for a Cursor run, where Chrome
 * refuses the dynamic `import()` a chunk would need.
 */
const iconsAsset = async (): Promise<string> => {
  const set = await import("@hugeicons/core-free-icons")
  return JSON.stringify(packIconSet(Object.fromEntries(Object.entries(set))))
}

export default defineConfig({
  hooks: {
    "build:publicAssets": async (_wxt, files) => {
      files.push({ relativeDest: ICONS_ASSET, contents: await iconsAsset() })
    }
  },
  srcDir: "src",
  manifestVersion: 3,
  browser: "chrome",
  manifest: {
    name: "Morph",
    version: packageJson.version,
    description:
      "Restyle the page you are on with an AI agent. Preview the new interface live and commit the code to your repository.",
    minimum_chrome_version: "135",
    icons: {
      16: icon(16),
      32: icon(32),
      48: icon(48),
      128: icon(128)
    },
    permissions: [
      "storage",
      "unlimitedStorage",
      "userScripts",
      "activeTab",
      "scripting",
      "tabs"
    ],
    host_permissions: ["<all_urls>"],
    action: {
      default_title: "Open Morph",
      default_icon: {
        16: icon(16),
        32: icon(32),
        48: icon(48),
        128: icon(128)
      }
    },
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'none'; frame-src 'self'",
      sandbox:
        "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'none'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'"
    },
    web_accessible_resources: [
      {
        resources: [
          "panel.html",
          "sandbox.html",
          "kit.js",
          "declarative.js",
          "assets/*",
          "chunks/*",
          "fonts/*"
        ],
        matches: ["<all_urls>"]
      }
    ]
  },
  vite: () => ({
    plugins: [react(), tailwindcss()],
    define: {
      __KIT_VERSION__: JSON.stringify(packageJson.version)
    },
    resolve: {
      alias: {
        "@": resolve(root, "src"),
        "@aws-sdk/client-bedrock-runtime": resolve(root, "src/stubs/bedrock.ts"),
        "@tanstack/ai-bedrock": resolve(root, "src/stubs/bedrock.ts")
      }
    },
    build: {
      target: "es2022",
      sourcemap: false,
      modulePreload: false
    }
  })
})
