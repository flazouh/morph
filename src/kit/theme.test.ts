import { describe, expect, test } from "bun:test"
import { luminanceOf, THEME_ATTR, themeKeeper, themeOf } from "./theme"

/**
 * happy-dom has no canvas, so `luminanceOf` gets a canvas whose 2d context answers with
 * a scripted pixel; `themeOf` and the keeper get a luminance function.
 */
const canvasGiving = (pixel: [number, number, number, number] | undefined): HTMLCanvasElement =>
  ({
    getContext: () =>
      pixel === undefined
        ? null
        : {
            clearRect: () => {},
            fillRect: () => {},
            set fillStyle(_: string) {},
            getImageData: () => ({ data: Uint8ClampedArray.from(pixel) })
          }
  }) as unknown as HTMLCanvasElement

describe("theme from the page", () => {
  test("luminance comes from the pixel the browser painted; transparent and no context are unknown", () => {
    expect(luminanceOf("white", canvasGiving([255, 255, 255, 255]))).toBeCloseTo(1)
    expect(luminanceOf("black", canvasGiving([0, 0, 0, 255]))).toBe(0)
    expect(luminanceOf("rgb(246, 246, 239)", canvasGiving([246, 246, 239, 255]))).toBeGreaterThan(0.8)
    expect(luminanceOf("transparent", canvasGiving([0, 0, 0, 0]))).toBeUndefined()
    expect(luminanceOf("white", canvasGiving(undefined))).toBeUndefined()
  })

  test("a light body is light, a dark body is dark, a transparent body falls back to html", () => {
    const byColor = (map: Record<string, number | undefined>) => (color: string) => map[color]
    document.body.style.backgroundColor = "rgb(246, 246, 239)"
    expect(themeOf(document, byColor({ "rgb(246, 246, 239)": 0.9 }))).toBe("light")
    document.body.style.backgroundColor = "rgb(13, 17, 23)"
    expect(themeOf(document, byColor({ "rgb(13, 17, 23)": 0.005 }))).toBe("dark")
    document.body.style.backgroundColor = "transparent"
    document.documentElement.style.backgroundColor = "rgb(0, 0, 0)"
    expect(themeOf(document, byColor({ transparent: undefined, "rgb(0, 0, 0)": 0 }))).toBe("dark")
    document.documentElement.style.backgroundColor = ""
    document.body.style.backgroundColor = ""
  })

  test("the keeper writes the attribute, recomputes on refresh, and yields to a script's own value", () => {
    document.documentElement.removeAttribute(THEME_ATTR)
    const keeper = themeKeeper(document)
    expect(document.documentElement.getAttribute(THEME_ATTR)).toBe("light")
    document.documentElement.setAttribute(THEME_ATTR, "dark")
    expect(keeper.refresh()).toBe("dark")
    expect(document.documentElement.getAttribute(THEME_ATTR)).toBe("dark")
    document.documentElement.removeAttribute(THEME_ATTR)
  })
})
