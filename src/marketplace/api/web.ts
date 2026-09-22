import { extname, join, normalize } from "node:path"

const types: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff2": "font/woff2"
}

export const marketplaceWeb =
  (root: string) =>
  async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const page =
      url.pathname === "/" ||
      url.pathname === "/marketplace" ||
      url.pathname === "/marketplace/device"
    const relative = page ? "marketplace.html" : decodeURIComponent(url.pathname.slice(1))
    const path = normalize(join(root, relative))
    if (!path.startsWith(`${normalize(root)}/`) && path !== normalize(root)) {
      return new Response("Not found", { status: 404 })
    }
    const file = Bun.file(path)
    if (!(await file.exists())) return new Response("Not found", { status: 404 })
    return new Response(file, {
      headers: {
        "Cache-Control": page ? "no-cache" : "public, max-age=31536000, immutable",
        "Content-Type": types[extname(path)] ?? file.type ?? "application/octet-stream"
      }
    })
  }
