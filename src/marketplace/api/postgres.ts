import { parseManifest, type RedesignManifest } from "../manifest"
import type { MarketplaceRepository, PackageDetail, PackagePage, PackageQuery, PackageSummary } from "./http"

interface SummaryRow {
  readonly id: string | number | bigint
  readonly slug: string
  readonly name: string
  readonly summary: string
  readonly scope_origin: string
  readonly scope_paths: ReadonlyArray<string>
  readonly version: string
  readonly runtime: "declarative-v1" | "script-v1" | "sandbox-v1"
  readonly license: string
  readonly install_count: string | number | bigint
  readonly star_count: string | number | bigint
  readonly updated_at: Date | string
}

interface DetailRow extends SummaryRow {
  readonly author_handle: string
  readonly author_display_name: string | null
  readonly author_avatar_url: string | null
  readonly manifest: unknown
  readonly github_owner: string
  readonly github_repo: string
  readonly github_commit: string
  readonly github_path: string
}

interface PublicSource {
  readonly owner: string
  readonly repository: string
  readonly commit: string
  readonly path: string
  readonly runtime: "declarative-v1" | "script-v1" | "sandbox-v1"
}

const path = (value: string): string => value.split("/").map(encodeURIComponent).join("/")

export const publicPackageRoot = ({ owner, repository, commit, path: folder }: Omit<PublicSource, "runtime">): string =>
  `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/${encodeURIComponent(commit)}/${path(folder)}`

export const publicFilesOf = ({ owner, repository, commit, path: folder, runtime }: PublicSource): PackageDetail["files"] => {
  const root = publicPackageRoot({ owner, repository, commit, path: folder })
  const source = `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/tree/${encodeURIComponent(commit)}/${path(folder)}/source`
  return {
    manifest: `${root}/manifest.json`,
    source,
    before: `${root}/preview-before.webp`,
    after: `${root}/preview-after.webp`,
    css: `${root}/style.css`,
    ...(runtime === "declarative-v1" ? { view: `${root}/view.json` } : { script: `${root}/script.js` })
  }
}

const summaryOf = (row: SummaryRow): PackageSummary => ({
  slug: row.slug,
  name: row.name,
  summary: row.summary,
  origin: row.scope_origin,
  paths: row.scope_paths,
  version: row.version,
  runtime: row.runtime,
  license: row.license,
  installs: Number(row.install_count),
  stars: Number(row.star_count),
  updatedAt: new Date(row.updated_at).toISOString()
})

const pageOf = (rows: ReadonlyArray<SummaryRow>, query: PackageQuery): PackagePage => {
  const hasNext = rows.length > query.limit
  return {
    items: rows.slice(0, query.limit).map(summaryOf),
    nextCursor: hasNext ? String(Number(query.cursor ?? "0") + query.limit) : null
  }
}

export const postgresMarketplace = (sql: typeof Bun.sql): MarketplaceRepository => {
  const list = async (query: PackageQuery): Promise<PackagePage> => {
    const search = query.query === null ? null : `%${query.query}%`
    const offset = Number(query.cursor ?? "0")
    const count = query.limit + 1
    const rows = await sql<SummaryRow[]>`
      select p.id, p.slug, p.name, p.summary, p.scope_origin, p.scope_paths, p.license,
             p.install_count, p.star_count, p.updated_at, v.version, v.runtime
      from marketplace_packages p
      join marketplace_versions v on v.id = p.latest_version_id
      where p.unlisted_at is null and p.removed_at is null and v.yanked_at is null
        and (${query.origin}::text is null or p.scope_origin = ${query.origin})
        and (${search}::text is null or p.name ilike ${search} or p.summary ilike ${search} or p.slug ilike ${search})
      order by
        case when ${query.sort} = 'recent' then p.updated_at end desc,
        case when ${query.sort} = 'stars' then p.star_count end desc,
        case when ${query.sort} = 'popular' then p.install_count end desc,
        p.id desc
      limit ${count} offset ${offset}
    `
    return pageOf(rows, query)
  }

  const get = async (slug: string): Promise<PackageDetail | null> => {
    const [row] = await sql<DetailRow[]>`
      select p.id, p.slug, p.name, p.summary, p.scope_origin, p.scope_paths, p.license,
             p.install_count, p.star_count, p.updated_at, p.github_owner, p.github_repo,
             v.version, v.runtime, v.manifest, v.github_commit, v.github_path,
             u.handle as author_handle, u.display_name as author_display_name, u.avatar_url as author_avatar_url
      from marketplace_packages p
      join marketplace_versions v on v.id = p.latest_version_id
      join marketplace_users u on u.id = p.owner_id
      where p.slug = ${slug} and p.unlisted_at is null and p.removed_at is null and v.yanked_at is null
      limit 1
    `
    if (row === undefined) return null
    let storedManifest: unknown = row.manifest
    if (typeof storedManifest === "string") storedManifest = JSON.parse(storedManifest) as unknown
    const manifest: RedesignManifest = parseManifest(storedManifest)
    const source = {
      repository: `${row.github_owner}/${row.github_repo}`,
      commit: row.github_commit,
      path: row.github_path,
      url: `https://github.com/${encodeURIComponent(row.github_owner)}/${encodeURIComponent(row.github_repo)}/tree/${encodeURIComponent(row.github_commit)}/${path(row.github_path)}`
    }
    return {
      ...summaryOf(row),
      author: {
        handle: row.author_handle,
        displayName: row.author_display_name,
        avatarUrl: row.author_avatar_url
      },
      manifest,
      source,
      files: publicFilesOf({
        owner: row.github_owner,
        repository: row.github_repo,
        commit: row.github_commit,
        path: row.github_path,
        runtime: row.runtime
      })
    }
  }

  const recordInstall = async (slug: string): Promise<boolean> => {
    const rows = await sql<Array<{ readonly package_id: string | number | bigint }>>`
      with updated as (
        update marketplace_packages
        set install_count = install_count + 1
        where slug = ${slug} and unlisted_at is null and removed_at is null
        returning id
      )
      insert into marketplace_install_daily (package_id, day, count)
      select id, current_date, 1 from updated
      on conflict (package_id, day) do update set count = marketplace_install_daily.count + 1
      returning package_id
    `
    return rows.length > 0
  }

  const report: MarketplaceRepository["report"] = async ({ slug, category, detail, reporterHash }) => {
    const [row] = await sql<Array<{ readonly id: string | number | bigint }>>`
      insert into marketplace_reports (package_id, version_id, reporter_ip_hash, category, detail)
      select p.id, p.latest_version_id, decode(${reporterHash}, 'hex'), ${category}, ${detail}
      from marketplace_packages p
      where p.slug = ${slug} and p.removed_at is null
      returning id
    `
    return row === undefined ? null : String(row.id)
  }

  return { list, get, recordInstall, report }
}
