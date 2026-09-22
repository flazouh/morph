/** Vite handles `.css` side-effect imports; this only tells tsc they resolve. */
declare module "*.css" {}
/** Vite's `?inline` gives the compiled stylesheet as a string. The kit adopts it into shadow roots. */
declare module "*.css?inline" {
  const css: string
  export default css
}
/** Vite's `?raw` gives the file's own text, uncompiled. The skin compiler feeds Tailwind's sheets to Tailwind this way. */
declare module "*.css?raw" {
  const css: string
  export default css
}
