begin;

create table marketplace_users (
  id bigint generated always as identity primary key,
  github_id bigint not null unique,
  handle text not null check (handle ~ '^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$'),
  display_name text,
  avatar_url text,
  email text,
  trust text not null default 'new' check (trust in ('new', 'trusted', 'staff')),
  created_at timestamptz not null default now(),
  banned_at timestamptz
);

create unique index marketplace_users_handle_idx on marketplace_users (lower(handle));

create table marketplace_packages (
  id bigint generated always as identity primary key,
  owner_id bigint not null references marketplace_users(id) on delete restrict,
  slug text not null unique check (slug ~ '^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$'),
  name text not null,
  summary text not null,
  license text not null,
  scope_kind text not null check (scope_kind in ('page', 'site')),
  scope_origin text not null check (scope_origin ~ '^https?://[^/]+$'),
  scope_paths text[] not null check (cardinality(scope_paths) > 0),
  github_owner text not null,
  github_repo text not null,
  github_path text not null,
  forked_from_package_id bigint references marketplace_packages(id) on delete set null,
  forked_from_version_id bigint,
  latest_version_id bigint,
  install_count bigint not null default 0 check (install_count >= 0),
  star_count bigint not null default 0 check (star_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unlisted_at timestamptz,
  removed_at timestamptz,
  removal_reason text
);

create index marketplace_packages_owner_id_idx on marketplace_packages (owner_id);
create index marketplace_packages_forked_from_package_id_idx on marketplace_packages (forked_from_package_id);
create index marketplace_packages_active_scope_idx on marketplace_packages (scope_origin, install_count desc)
where unlisted_at is null and removed_at is null;

create table marketplace_versions (
  id bigint generated always as identity primary key,
  package_id bigint not null references marketplace_packages(id) on delete cascade,
  version text not null check (version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$'),
  runtime text not null check (runtime in ('declarative-v1', 'script-v1')),
  manifest jsonb not null,
  github_commit text not null,
  github_path text not null,
  source_digest text not null check (source_digest ~ '^sha256:[a-f0-9]{64}$'),
  view_digest text check (view_digest is null or view_digest ~ '^sha256:[a-f0-9]{64}$'),
  script_digest text check (script_digest is null or script_digest ~ '^sha256:[a-f0-9]{64}$'),
  css_digest text not null check (css_digest ~ '^sha256:[a-f0-9]{64}$'),
  kit_range text not null,
  kit_built_with text not null,
  compiler_version text not null,
  size_bytes bigint not null check (size_bytes >= 0),
  published_by bigint not null references marketplace_users(id) on delete restrict,
  published_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by bigint references marketplace_users(id) on delete set null,
  yanked_at timestamptz,
  yank_reason text,
  unique (id, package_id),
  unique (package_id, version),
  check (
    (runtime = 'declarative-v1' and view_digest is not null and script_digest is null)
    or
    (runtime = 'script-v1' and script_digest is not null and view_digest is null)
  ),
  check (runtime = 'declarative-v1' or reviewed_at is not null)
);

alter table marketplace_packages
  add constraint marketplace_packages_latest_version_fk
  foreign key (latest_version_id, id) references marketplace_versions(id, package_id)
  deferrable initially deferred;

alter table marketplace_packages
  add constraint marketplace_packages_forked_from_version_fk
  foreign key (forked_from_version_id, forked_from_package_id) references marketplace_versions(id, package_id)
  on delete set null;

create index marketplace_packages_latest_version_id_idx on marketplace_packages (latest_version_id);
create index marketplace_packages_forked_from_version_id_idx on marketplace_packages (forked_from_version_id);
create index marketplace_versions_package_id_idx on marketplace_versions (package_id, published_at desc)
where yanked_at is null;
create index marketplace_versions_published_by_idx on marketplace_versions (published_by);
create index marketplace_versions_reviewed_by_idx on marketplace_versions (reviewed_by) where reviewed_by is not null;

create table marketplace_stars (
  user_id bigint not null references marketplace_users(id) on delete cascade,
  package_id bigint not null references marketplace_packages(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, package_id)
);

create index marketplace_stars_package_id_idx on marketplace_stars (package_id);

create table marketplace_install_daily (
  package_id bigint not null references marketplace_packages(id) on delete cascade,
  day date not null,
  count bigint not null default 0 check (count >= 0),
  primary key (package_id, day)
);

create table marketplace_reports (
  id bigint generated always as identity primary key,
  package_id bigint not null references marketplace_packages(id) on delete cascade,
  version_id bigint references marketplace_versions(id) on delete set null,
  reporter_user_id bigint references marketplace_users(id) on delete set null,
  reporter_ip_hash bytea not null,
  category text not null check (category in ('malware', 'privacy', 'license', 'spam', 'broken')),
  detail text not null,
  status text not null default 'open' check (status in ('open', 'reviewing', 'resolved', 'dismissed')),
  resolution text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index marketplace_reports_package_id_idx on marketplace_reports (package_id);
create index marketplace_reports_version_id_idx on marketplace_reports (version_id) where version_id is not null;
create index marketplace_reports_reporter_user_id_idx on marketplace_reports (reporter_user_id) where reporter_user_id is not null;
create index marketplace_reports_open_idx on marketplace_reports (created_at) where status in ('open', 'reviewing');

create table marketplace_sessions (
  id bigint generated always as identity primary key,
  user_id bigint not null references marketplace_users(id) on delete cascade,
  token_hash bytea not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create index marketplace_sessions_user_id_idx on marketplace_sessions (user_id);
create index marketplace_sessions_active_idx on marketplace_sessions (expires_at) where revoked_at is null;

create table marketplace_api_tokens (
  id bigint generated always as identity primary key,
  user_id bigint not null references marketplace_users(id) on delete cascade,
  name text not null,
  token_hash bytea not null unique,
  scopes text[] not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

create index marketplace_api_tokens_user_id_idx on marketplace_api_tokens (user_id);
create index marketplace_api_tokens_active_idx on marketplace_api_tokens (user_id, created_at desc) where revoked_at is null;

create table marketplace_device_codes (
  id bigint generated always as identity primary key,
  user_code_hash bytea not null unique,
  device_code_hash bytea not null unique,
  requested_scopes text[] not null,
  user_id bigint references marketplace_users(id) on delete cascade,
  expires_at timestamptz not null,
  approved_at timestamptz,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index marketplace_device_codes_user_id_idx on marketplace_device_codes (user_id) where user_id is not null;
create index marketplace_device_codes_pending_idx on marketplace_device_codes (expires_at)
where approved_at is null and consumed_at is null;

create table marketplace_audit_log (
  id bigint generated always as identity primary key,
  actor_user_id bigint references marketplace_users(id) on delete set null,
  action text not null,
  subject_type text not null,
  subject_id text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index marketplace_audit_log_actor_user_id_idx on marketplace_audit_log (actor_user_id) where actor_user_id is not null;
create index marketplace_audit_log_subject_idx on marketplace_audit_log (subject_type, subject_id, created_at desc);

revoke all on all tables in schema public from public;
revoke all on all sequences in schema public from public;

commit;
