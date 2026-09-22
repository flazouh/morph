import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, test } from "bun:test"
import type { CatalogModel } from "./models"
import { useModels } from "./use-models"

afterEach(cleanup)

const CURSOR: ReadonlyArray<CatalogModel> = [
  { value: "composer-2", label: "Composer 2", in: "—", out: "—" }
]

test("a Cursor key being typed asks Cursor once, for the key that was typed", async () => {
  const asked: Array<string> = []
  const loadCursor = async (key: string): Promise<ReadonlyArray<CatalogModel>> => {
    asked.push(key)
    return CURSOR
  }

  function Harness({ cursorKey }: { readonly cursorKey: string }) {
    const catalog = useModels("cursor", "composer-2", cursorKey, async () => [], loadCursor, 5)
    return <output data-testid="models">{catalog.map((model) => model.value).join(",")}</output>
  }

  const view = render(<Harness cursorKey="c" />)
  for (const key of ["cr", "crs", "crsr", "crsr_", "crsr_key"]) {
    view.rerender(<Harness cursorKey={key} />)
  }

  await waitFor(() => expect(asked.length).toBeGreaterThan(0))
  expect(asked).toEqual(["crsr_key"])
  expect(screen.getByTestId("models").textContent).toBe("composer-2")
})

test("the OpenRouter catalog is not held back by the Cursor key's wait", () => {
  function Harness() {
    const catalog = useModels(
      "openrouter",
      "openai/gpt-5.2",
      "",
      async () => [],
      async () => [],
      5
    )
    return <output data-testid="models">{catalog.length > 0 ? "ready" : "empty"}</output>
  }

  render(<Harness />)
  expect(screen.getByTestId("models").textContent).toBe("ready")
})
