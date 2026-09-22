-- A page redesign publishes as a root package: a script-v1 release with no parent. The
-- parent columns become optional, and stay one fact: all three set for a fork, none for a
-- root. The catalog already allowed a package without a fork lineage.
begin;

alter table marketplace_release_runs
  alter column parent_package_id drop not null,
  alter column parent_version_id drop not null,
  alter column parent_commit drop not null;

alter table marketplace_release_runs
  add constraint marketplace_release_runs_parent_check
  check (num_nonnulls(parent_package_id, parent_version_id, parent_commit) in (0, 3));

commit;
