import { expect, test } from "bun:test"

test("publishing migration adds expiring credentials and resumable release keys", async () => {
  const sql = await Bun.file(
    new URL("./003_publishing.sql", import.meta.url)
  ).text()

  expect(sql).toContain("add column expires_at timestamptz not null")
  expect(sql).toContain("state_hash bytea not null unique")
  expect(sql).toContain("content_key text not null unique")
  expect(sql).toContain("foreign key (parent_version_id, parent_package_id)")
  expect(sql).toContain("unique index marketplace_release_runs_package_version_idx")
  expect(sql).toContain("state <> 'completed'")
  expect(sql).toContain("compiled_artifacts jsonb")
  expect(sql).toContain("last_error_retryable boolean")
  expect(sql).toContain("reviewed_at is not null")
  expect(sql).not.toContain("token text")
  expect(sql).not.toContain("device_code text")
})

test("compiled output migration upgrades release databases that already ran migration 003", async () => {
  const sql = await Bun.file(
    new URL("./004_compiled_output.sql", import.meta.url)
  ).text()

  expect(sql).toContain("add column compiled_output jsonb")
  expect(sql).toContain("where state = 'compiled'")
})

test("root releases migration lets a run have no parent, and never a partial one", async () => {
  const sql = await Bun.file(
    new URL("./005_root_releases.sql", import.meta.url)
  ).text()

  expect(sql).toContain("alter column parent_package_id drop not null")
  expect(sql).toContain("alter column parent_version_id drop not null")
  expect(sql).toContain("alter column parent_commit drop not null")
  expect(sql).toContain("num_nonnulls(parent_package_id, parent_version_id, parent_commit) in (0, 3)")
})
