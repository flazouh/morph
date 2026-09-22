begin;

alter table marketplace_release_runs
  add column compiled_output jsonb;

-- A legacy compiled run has only digests, not the build bytes needed for its commit.
-- Move it back to the one safe stage so the new server can compile and verify it again.
update marketplace_release_runs
set state = 'accepted',
    compiled_artifacts = null,
    compiler_version = null,
    error_stage = null,
    last_error_code = null,
    last_error_retryable = null,
    updated_at = now()
where state = 'compiled'
  and compiled_output is null;

commit;
