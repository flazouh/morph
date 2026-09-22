import { expect, test } from "bun:test"
import { watchExtensionContext } from "./window"

test("an invalidated extension context reloads the embedded panel", async () => {
  let checks = 0
  let reloads = 0
  const stop = watchExtensionContext(
    () => {
      checks += 1
      if (checks === 2) throw new Error("Extension context invalidated.")
    },
    () => {
      reloads += 1
    },
    1
  )

  await Bun.sleep(10)
  expect(reloads).toBe(1)
  stop()
  expect(checks).toBe(2)
})
