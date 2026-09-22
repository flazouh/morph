import { useEffect, useState } from "react"
import { Button, ButtonLink } from "@/components/motion/button"
import { MorphMascots } from "@/panel/Mascot"
import type { MarketplaceClient } from "../client"
import type { PackageQuery, PackageSort, PackageSummary } from "../api/http"
import { PackageDetailView } from "./PackageDetailView"
import { useCatalog } from "./use-catalog"

type Section = "explore" | "library" | "publish"
type Theme = "light" | "dark"

const resultCount = (count: number): string => `${count} ${count === 1 ? "redesign" : "redesigns"}`
const installCount = (count: number): string => (count === 0 ? "No installs yet" : `${count.toLocaleString()} installs`)

const queryFor = (value: string, sort: PackageSort): Partial<PackageQuery> => {
  const text = value.trim()
  if (text === "") return { sort, limit: 24 }
  if (!text.includes(" ") && text.includes(".")) {
    try {
      return { origin: new URL(text.includes("://") ? text : `https://${text}`).origin, sort, limit: 24 }
    } catch {
      return { query: text, sort, limit: 24 }
    }
  }
  return { query: text, sort, limit: 24 }
}

export function MarketplaceApp({
  client,
  theme = "light",
  onThemeChange
}: {
  readonly client: MarketplaceClient
  readonly theme?: Theme
  readonly onThemeChange?: (theme: Theme) => void
}) {
  const [section, setSection] = useState<Section>(() => {
    const selected = new URLSearchParams(window.location.search).get("section")
    return selected === "library" || selected === "publish" ? selected : "explore"
  })
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null)

  const navigate = (next: Section) => {
    setSelectedSlug(null)
    setSection(next)
  }

  return (
    <div className="min-h-full bg-background text-foreground">
      <MarketplaceHeader
        current={section}
        theme={theme}
        onNavigate={navigate}
        onThemeChange={onThemeChange}
      />
      {selectedSlug !== null ? (
        <PackageDetailView slug={selectedSlug} client={client} onBack={() => setSelectedSlug(null)} />
      ) : section === "explore" ? (
        <Explore client={client} onSelect={setSelectedSlug} />
      ) : section === "library" ? (
        <Library onExplore={() => navigate("explore")} />
      ) : (
        <Publish />
      )}
      <Footer />
    </div>
  )
}

function MarketplaceHeader({
  current,
  theme,
  onNavigate,
  onThemeChange
}: {
  readonly current: Section
  readonly theme: Theme
  readonly onNavigate: (section: Section) => void
  readonly onThemeChange?: (theme: Theme) => void
}) {
  return (
    <header className="sticky top-0 z-50 border-b border-border bg-background/95 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-5 px-5 sm:px-8">
        <button
          type="button"
          onClick={() => onNavigate("explore")}
          className="flex min-h-11 items-center gap-2.5 rounded-lg pr-2 font-semibold tracking-[-0.02em] outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <MorphMascots height={24} />
          <span>Morph</span>
        </button>
        <nav className="ml-auto flex items-center gap-1" aria-label="Marketplace">
          {(["explore", "library", "publish"] as const).map((item) => (
            <button
              key={item}
              type="button"
              aria-current={current === item ? "page" : undefined}
              onClick={() => onNavigate(item)}
              className={`min-h-11 rounded-lg px-3 text-sm font-medium capitalize outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${
                current === item ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {item}
            </button>
          ))}
        </nav>
        {onThemeChange === undefined ? null : (
          <button
            type="button"
            onClick={() => onThemeChange(theme === "light" ? "dark" : "light")}
            className="hidden min-h-11 rounded-lg px-3 text-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring sm:block"
          >
            {theme === "light" ? "Dark theme" : "Light theme"}
          </button>
        )}
      </div>
    </header>
  )
}

function Explore({
  client,
  onSelect
}: {
  readonly client: Pick<MarketplaceClient, "list">
  readonly onSelect: (slug: string) => void
}) {
  const [search, setSearch] = useState("")
  const [sort, setSort] = useState<PackageSort>("popular")
  const [query, setQuery] = useState<Partial<PackageQuery>>({ sort: "popular", limit: 24 })
  const catalog = useCatalog(client, query)
  const { items, status } = catalog.state
  const loading = status === "loading"
  const error = status === "error"

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    setQuery(queryFor(search, sort))
  }

  const changeSort = (next: PackageSort) => {
    setSort(next)
    setQuery(queryFor(search, next))
  }

  return (
    <main className="marketplace-reveal">
      <section className="border-b border-border">
        <div className="mx-auto max-w-6xl px-5 pb-14 pt-16 sm:px-8 sm:pb-20 sm:pt-24">
          <h1 className="max-w-3xl text-balance text-4xl font-semibold leading-[1.08] tracking-[-0.04em] sm:text-6xl">
            Find a better version of the sites you use.
          </h1>
          <p className="mt-5 max-w-2xl text-base leading-7 text-muted-foreground sm:text-lg">
            Browse open-source redesigns. Check every page, permission, and source file before you install.
          </p>
          <form
            role="search"
            onSubmit={submit}
            className="mt-9 flex max-w-2xl flex-col gap-2 rounded-2xl bg-card p-2 sm:flex-row"
          >
            <label className="sr-only" htmlFor="marketplace-search">
              Website or search term
            </label>
            <input
              id="marketplace-search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Try news.ycombinator.com"
              className="h-12 min-w-0 flex-1 rounded-xl bg-transparent px-3 text-base outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
            />
            <Button type="submit" size="lg">
              Find redesigns
            </Button>
          </form>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-5 py-12 sm:px-8 sm:py-16" aria-live="polite">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="text-2xl font-semibold tracking-[-0.025em]">Explore redesigns</h2>
            <p className="mt-1.5 text-sm text-muted-foreground">
              {loading ? "Loading the public catalog…" : error ? "Catalog unavailable" : resultCount(items.length)}
            </p>
          </div>
          <label className="flex min-h-11 items-center gap-2 text-sm text-muted-foreground">
            Sort
            <select
              value={sort}
              onChange={(event) => changeSort(event.target.value as PackageSort)}
              className="h-10 rounded-lg bg-card px-3 font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="popular">Popular</option>
              <option value="recent">Recent</option>
              <option value="stars">Stars</option>
            </select>
          </label>
        </div>

        {error ? (
          <div className="mt-8 rounded-2xl bg-card p-8">
            <h3 className="text-lg font-semibold">The marketplace could not load.</h3>
            <p className="mt-2 text-sm text-muted-foreground">Check your connection, then try again.</p>
            <Button className="mt-5" variant="secondary" onClick={catalog.retry}>
              Try again
            </Button>
          </div>
        ) : loading ? (
          <LoadingRows />
        ) : items.length === 0 ? (
          <div className="mt-8 rounded-2xl bg-card p-8 text-center">
            <h3 className="text-lg font-semibold">No redesigns match this search.</h3>
            <p className="mt-2 text-sm text-muted-foreground">Try a domain or a shorter search term.</p>
          </div>
        ) : (
          <div className="mt-8 divide-y divide-border-strong">
            {items.map((item) => (
              <PackageRow key={item.slug} item={item} onSelect={onSelect} />
            ))}
          </div>
        )}
      </section>
    </main>
  )
}

function PackageRow({ item, onSelect }: { readonly item: PackageSummary; readonly onSelect: (slug: string) => void }) {
  const hostname = new URL(item.origin).hostname
  return (
    <article className="group grid gap-5 py-7 first:pt-0 sm:grid-cols-[96px_minmax(0,1fr)_auto] sm:items-center">
      <SiteMark origin={item.origin} hostname={hostname} />
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h3 className="text-xl font-semibold tracking-[-0.02em]">{item.name}</h3>
          <span className="rounded-full bg-muted px-2 py-1 font-mono text-[10px] text-muted-foreground">v{item.version}</span>
        </div>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">{item.summary}</p>
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>{hostname}</span>
          <span>{item.paths.length === 1 ? "1 page" : `${item.paths.length} pages`}</span>
          <span>{installCount(item.installs)}</span>
          <span>{item.license}</span>
        </div>
      </div>
      <Button variant="secondary" onClick={() => onSelect(item.slug)} aria-label={`View ${item.name}`}>
        View redesign
      </Button>
    </article>
  )
}

function SiteMark({ origin, hostname }: { readonly origin: string; readonly hostname: string }) {
  const [failed, setFailed] = useState(false)

  return (
    <div className="grid size-24 place-items-center rounded-2xl bg-card">
      {failed ? (
        <span className="font-mono text-lg font-medium text-accent">{hostname.slice(0, 2).toUpperCase()}</span>
      ) : (
        <img
          src={`${origin}/favicon.ico`}
          alt={`${hostname} favicon`}
          className="size-12 object-contain"
          onError={() => setFailed(true)}
        />
      )}
    </div>
  )
}

function LoadingRows() {
  return (
    <div className="mt-8 space-y-px" aria-hidden="true">
      {[0, 1, 2].map((item) => (
        <div key={item} className="grid animate-pulse gap-5 border-b border-border-strong py-7 sm:grid-cols-[96px_minmax(0,1fr)_110px]">
          <div className="size-24 rounded-2xl bg-muted" />
          <div className="py-2">
            <div className="h-5 w-40 rounded bg-muted" />
            <div className="mt-4 h-4 max-w-xl rounded bg-muted" />
            <div className="mt-3 h-3 w-64 rounded bg-muted" />
          </div>
          <div className="h-10 rounded-full bg-muted" />
        </div>
      ))}
    </div>
  )
}

function Library({ onExplore }: { readonly onExplore: () => void }) {
  return (
    <main className="marketplace-reveal mx-auto grid min-h-[68vh] max-w-6xl place-items-center px-5 py-16">
      <div className="max-w-lg text-center">
        <div className="mx-auto grid size-16 place-items-center rounded-2xl bg-card">
          <MorphMascots height={30} />
        </div>
        <h1 className="mt-7 text-3xl font-semibold tracking-[-0.03em]">Your library stays in Morph.</h1>
        <p className="mt-4 text-sm leading-6 text-muted-foreground">
          Open the extension to update, remove, or restore installed redesigns. Your library does not need an account.
        </p>
        <Button className="mt-7" onClick={onExplore}>
          Explore redesigns
        </Button>
      </div>
    </main>
  )
}

interface PublicRelease {
  readonly id: string
  readonly state: string
  readonly slug: string
  readonly version: string
  readonly error: string | null
  readonly retryable: boolean
  readonly sourceUrl: string | null
}

function Publish() {
  const parameters = new URLSearchParams(window.location.search)
  const [userCode, setUserCode] = useState(parameters.get("user_code") ?? "")
  const releaseId = parameters.get("release")
  const auth = parameters.get("auth")
  const [release, setRelease] = useState<PublicRelease>()
  const [releaseError, setReleaseError] = useState<string>()

  const readRelease = async () => {
    if (releaseId === null) return
    try {
      const response = await fetch(
        `/v1/releases/${encodeURIComponent(releaseId)}/public`,
        { credentials: "include" }
      )
      if (!response.ok) throw new Error(`Release status failed (${response.status})`)
      setRelease(await response.json() as PublicRelease)
      setReleaseError(undefined)
    } catch (error) {
      setReleaseError(error instanceof Error ? error.message : "Release status failed")
    }
  }

  useEffect(() => {
    void readRelease()
  }, [releaseId])

  const retry = async () => {
    if (releaseId === null) return
    const response = await fetch(
      `/v1/releases/${encodeURIComponent(releaseId)}/retry`,
      { method: "POST", credentials: "include" }
    )
    if (!response.ok) {
      setReleaseError(`Release retry failed (${response.status})`)
      return
    }
    setRelease(await response.json() as PublicRelease)
    setReleaseError(undefined)
  }

  const code = userCode.trim().toUpperCase()
  const signInUrl = `/v1/auth/github?user_code=${encodeURIComponent(code)}`
  return (
    <main className="marketplace-reveal mx-auto max-w-6xl px-5 py-16 sm:px-8 sm:py-24">
      <div className="max-w-2xl">
        <h1 className="text-4xl font-semibold tracking-[-0.035em] sm:text-5xl">Publish from the work you already made.</h1>
        <p className="mt-5 text-base leading-7 text-muted-foreground">
          Morph packages the editable source, compiled output, page scope, permissions, and version history together.
        </p>
        <div className="mt-10 rounded-2xl bg-card p-6 sm:p-8">
          <h2 className="text-xl font-semibold tracking-[-0.02em]">
            {auth === "approved" ? "GitHub is connected." : "Connect the Morph extension"}
          </h2>
          {auth === "approved" ? (
            <p className="mt-3 text-sm leading-6 text-muted-foreground">
              Return to Morph. Publishing will continue from the saved release step.
            </p>
          ) : (
            <>
              <p className="mt-3 max-w-xl text-sm leading-6 text-muted-foreground">
                Enter the code from Morph. GitHub confirms your identity. It does not grant access to the package repository.
              </p>
              <label htmlFor="device-code" className="mt-6 block text-sm font-medium">
                Device code
              </label>
              <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                <input
                  id="device-code"
                  value={userCode}
                  onChange={(event) => setUserCode(event.target.value)}
                  placeholder="MORP-H123"
                  autoComplete="one-time-code"
                  className="h-11 min-w-0 flex-1 rounded-xl bg-background px-3 font-mono text-sm uppercase outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                <ButtonLink
                  href={code === "" ? undefined : signInUrl}
                  aria-disabled={code === ""}
                  onClick={(event) => {
                    if (code === "") event.preventDefault()
                  }}
                >
                  Continue with GitHub
                </ButtonLink>
              </div>
            </>
          )}
        </div>

        {releaseId === null ? null : (
          <div className="mt-4 rounded-2xl bg-card p-6 sm:p-8" aria-live="polite">
            <h2 className="text-xl font-semibold tracking-[-0.02em]">Release status</h2>
            {release === undefined ? (
              <p className="mt-3 text-sm text-muted-foreground">
                {releaseError ?? "Loading release…"}
              </p>
            ) : (
              <>
                <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
                  <span className="font-medium">{release.slug}@{release.version}</span>
                  <span className="rounded-full bg-muted px-2 py-1 text-xs capitalize text-muted-foreground">
                    {release.state}
                  </span>
                </div>
                {release.error === null ? null : (
                  <p className="mt-3 text-sm text-destructive">{release.error}</p>
                )}
                <div className="mt-5 flex flex-wrap gap-2">
                  {release.retryable ? (
                    <Button variant="secondary" onClick={() => void retry()}>
                      Retry release
                    </Button>
                  ) : null}
                  {release.sourceUrl === null ? null : (
                    <ButtonLink href={release.sourceUrl} variant="secondary">
                      View source
                    </ButtonLink>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </main>
  )
}

function Footer() {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto flex max-w-6xl flex-col gap-2 px-5 py-8 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-8">
        <span>Morph marketplace</span>
        <span>Open source by default. Exact scope before install.</span>
      </div>
    </footer>
  )
}
