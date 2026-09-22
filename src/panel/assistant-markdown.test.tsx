import { describe, expect, test } from "bun:test"
import { render, screen } from "@testing-library/react"
import { AssistantMarkdown, safeUrl } from "@/components/agents/assistant-markdown"

describe("safeUrl", () => {
  test("keeps http(s) and mailto, and drops the rest", () => {
    expect(safeUrl("https://github.com/acme")).toBe("https://github.com/acme")
    expect(safeUrl("http://example.com")).toBe("http://example.com")
    expect(safeUrl("mailto:hi@example.com")).toBe("mailto:hi@example.com")
    expect(safeUrl("javascript:alert(1)")).toBe("")
    expect(safeUrl("/relative")).toBe("")
    expect(safeUrl("https://invalid.invalid/x")).toBe("")
  })
})

describe("AssistantMarkdown", () => {
  test("renders headings, lists, and emphasis", () => {
    render(<AssistantMarkdown text={"## Dark\n\nUse a **bold** `canvas`.\n\n- one\n- two"} />)
    expect(screen.getByRole("heading", { level: 2, name: "Dark" })).toBeTruthy()
    expect(screen.getByText("bold").closest("strong, [data-streamdown='strong']")).toBeTruthy()
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual(["one", "two"])
    expect(screen.getByText("canvas").closest("p")?.querySelector("code")).toBeTruthy()
  })

  test("repairs a partial heading while streaming", () => {
    render(<AssistantMarkdown text="# Dark" streaming />)
    expect(screen.getByRole("heading", { level: 1, name: "Dark" })).toBeTruthy()
  })

  test("shows an incomplete fence as a code block", () => {
    const { container } = render(<AssistantMarkdown text={"```css\nbody { color: red;"} streaming />)
    expect(container.querySelector("pre")).toBeTruthy()
    expect(container.textContent).toContain("body { color: red;")
  })

  test("keeps safe links and drops javascript, images, and raw html", () => {
    const { container } = render(
      <AssistantMarkdown
        text={[
          "[safe](https://github.com/acme/app)",
          "[bad](javascript:alert(1))",
          "![x](https://evil.test/x.png)",
          "<script>alert(1)</script>",
          "<img src=x onerror=alert(1)>"
        ].join("\n\n")}
      />
    )
    const safe = screen.getByRole("link", { name: "safe" })
    expect(safe.getAttribute("href")).toBe("https://github.com/acme/app")
    expect(safe.getAttribute("target")).toBe("_blank")
    expect(screen.queryByText("Open external link?")).toBeNull()
    expect(container.querySelector("a[href^='javascript']")).toBeNull()
    expect(screen.queryByRole("button", { name: "bad" })).toBeNull()
    expect(container.querySelector("img")).toBeNull()
    expect(container.querySelector("script")).toBeNull()
    expect(container.textContent).not.toContain("javascript:")
  })
})
