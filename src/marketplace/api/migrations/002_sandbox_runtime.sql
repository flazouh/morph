begin;

alter table marketplace_versions
  drop constraint if exists marketplace_versions_runtime_check;

alter table marketplace_versions
  add constraint marketplace_versions_runtime_check
  check (runtime in ('declarative-v1', 'script-v1', 'sandbox-v1'));

alter table marketplace_versions
  drop constraint if exists marketplace_versions_runtime_artifacts_check;

alter table marketplace_versions
  add constraint marketplace_versions_runtime_artifacts_check
  check (
    (runtime = 'declarative-v1' and view_digest is not null and script_digest is null)
    or
    (runtime = 'script-v1' and script_digest is not null and view_digest is null)
    or
    (runtime = 'sandbox-v1' and script_digest is not null and view_digest is null)
  );

commit;
