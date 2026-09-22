-- A release run claims its package version so two publishes of one version cannot race.
-- The claim was permanent, which made a run that stopped halfway hold a version nobody
-- could ever publish: the next attempt carries fresh previews, so it is different content,
-- and it was refused as taken forever. A published version is final, but an abandoned run
-- is not, so a claim can now be released by marking the run superseded, and the index that
-- enforces one claim per version counts only the runs that still hold one.
begin;

alter table marketplace_release_runs
  add column if not exists superseded_at timestamptz;

drop index if exists marketplace_release_runs_package_version_idx;

create unique index marketplace_release_runs_package_version_idx
  on marketplace_release_runs (package_slug, package_version)
  where superseded_at is null;

-- A superseded run is a record of what was tried, never a release: it cannot be completed,
-- and it can never be the row that holds a catalog version.
alter table marketplace_release_runs
  add constraint marketplace_release_runs_superseded_check
  check (superseded_at is null or state <> 'completed');

commit;
