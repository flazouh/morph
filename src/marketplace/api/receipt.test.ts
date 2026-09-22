import { expect, test } from "bun:test"
import type { ReleaseReceipt } from "./publishing"
import { releaseReceiptSigner } from "./receipt"

const receipt: ReleaseReceipt = {
  contentKey: `sha256:${"1".repeat(64)}`,
  slug: "alex/quiet",
  version: "1.0.0",
  repository: "flazouh/morph-packages",
  commit: "2".repeat(40),
  path: "packages/alex/quiet/1.0.0",
  compiler: "morph-package-1",
  artifacts: {
    script: `sha256:${"3".repeat(64)}`,
    css: `sha256:${"4".repeat(64)}`
  },
  files: {},
  parent: {
    slug: "flazouh/gitquiet",
    version: "1.0.0",
    commit: "5".repeat(40)
  },
  permissions: { added: [], removed: [] },
  catalogedAt: "2026-09-09T20:00:00.000Z"
}

test("release receipts are deterministic signed claims without the signing secret", async () => {
  const sign = releaseReceiptSigner("a secure receipt secret with more than 32 bytes")
  const first = await sign(receipt)
  expect(await sign(receipt)).toBe(first)
  expect(first).toStartWith("v1.")
  expect(first).not.toContain("a secure receipt secret")
  expect(await sign({ ...receipt, version: "1.0.1" })).not.toBe(first)
  expect(() => releaseReceiptSigner("short")).toThrow()
})
