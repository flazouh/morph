begin;

alter table marketplace_api_tokens
  add column expires_at timestamptz not null default (now() + interval '1 hour');

alter table marketplace_device_codes
  add column denied_at timestamptz,
  add column last_polled_at timestamptz;

alter table marketplace_device_codes
  add constraint marketplace_device_codes_terminal_check
  check (num_nonnulls(approved_at, denied_at) <= 1);

create table marketplace_oauth_states (
  id bigint generated always as identity primary key,
  state_hash bytea not null unique,
  device_code_id bigint not null references marketplace_device_codes(id) on delete cascade,
  session_id bigint references marketplace_sessions(id) on delete cascade,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index marketplace_oauth_states_active_idx
  on marketplace_oauth_states (expires_at)
  where consumed_at is null;

create table marketplace_release_runs (
  id bigint generated always as identity primary key,
  owner_id bigint not null references marketplace_users(id) on delete restrict,
  content_key text not null unique check (content_key ~ '^sha256:[a-f0-9]{64}$'),
  package_slug text not null check (package_slug ~ '^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$'),
  package_version text not null check (package_version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$'),
  parent_package_id bigint not null,
  parent_version_id bigint not null,
  parent_commit text not null check (parent_commit ~ '^[a-f0-9]{40}$'),
  state text not null default 'accepted'
    check (state in ('accepted', 'compiled', 'committed', 'verified', 'cataloged', 'completed')),
  submission jsonb not null,
  compiled_artifacts jsonb,
  release_files jsonb,
  permission_delta jsonb not null,
  permission_widening_approved boolean not null default false,
  compiler_version text,
  size_bytes bigint check (size_bytes is null or size_bytes >= 0),
  github_commit text check (github_commit is null or github_commit ~ '^[a-f0-9]{40}$'),
  github_path text,
  catalog_package_id bigint references marketplace_packages(id) on delete restrict,
  catalog_version_id bigint references marketplace_versions(id) on delete restrict,
  cataloged_at timestamptz,
  release_receipt text,
  error_stage text check (error_stage is null or error_stage in ('accepted', 'compiled', 'committed', 'verified', 'cataloged', 'completed')),
  last_error_code text,
  last_error_retryable boolean,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  foreign key (parent_version_id, parent_package_id)
    references marketplace_versions(id, package_id) on delete restrict,
  check (
    (state in ('accepted', 'compiled') and github_commit is null and github_path is null)
    or
    (state not in ('accepted', 'compiled') and github_commit is not null and github_path is not null)
  ),
  check (
    (state = 'completed' and release_receipt is not null and completed_at is not null)
    or state <> 'completed'
  ),
  check (
    num_nonnulls(error_stage, last_error_code, last_error_retryable) in (0, 3)
  )
);

create index marketplace_release_runs_owner_idx
  on marketplace_release_runs (owner_id, created_at desc);
create index marketplace_release_runs_resume_idx
  on marketplace_release_runs (state, updated_at)
  where state <> 'completed';
create unique index marketplace_release_runs_package_version_idx
  on marketplace_release_runs (package_slug, package_version);

do $$
declare
  constraint_name text;
begin
  select conname into constraint_name
  from pg_constraint
  where conrelid = 'marketplace_versions'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) ilike '%reviewed_at is not null%'
  limit 1;
  if constraint_name is not null then
    execute format('alter table marketplace_versions drop constraint %I', constraint_name);
  end if;
end
$$;

-- The runtime check 001 wrote was unnamed, so 002 added a sandbox-aware copy beside it
-- instead of replacing it, and the older one still refuses every sandbox-v1 row. Drop the
-- copies that predate sandbox-v1 and keep the one that knows about it.
do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select conname
    from pg_constraint
    where conrelid = 'marketplace_versions'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%script-v1%'
      and pg_get_constraintdef(oid) not ilike '%sandbox-v1%'
  loop
    execute format('alter table marketplace_versions drop constraint %I', constraint_name);
  end loop;
end
$$;

revoke all on marketplace_oauth_states, marketplace_release_runs from public;
revoke all on all sequences in schema public from public;

commit;
