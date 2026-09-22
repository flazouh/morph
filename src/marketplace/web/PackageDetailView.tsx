import { useEffect, useState } from "react"
import { Button, ButtonLink } from "@/components/motion/button"
import type { MarketplaceClient } from "../client"
import type { PackageDetail } from "../api/http"

const count = (value: number, singular: string): string =>
  value === 0 ? `No ${singular}s yet` : `${value.toLocaleString()} ${value === 1 ? singular : `${singular}s`}`

const scopeLabel = (detail: PackageDetail): string =>
  detail.manifest.scope.kind === "site" ? "Runs across this site" : "Runs on this page"

const scopeValue = (detail: PackageDetail): string =>
  detail.manifest.scope.paths.map((path) => `${detail.manifest.scope.origin}${path}`).join(", ")

type CopyState = "idle" | "copying" | "copied" | "error"

export function PackageDetailView({
  slug,
  client,
  onBack
}: {
  readonly slug: string
  readonly client: Pick<MarketplaceClient, "get">
  readonly onBack: () => void
}) {
  const [detail, setDetail] = useState<PackageDetail | null>(null)
  const [error, setError] = useState(false)
  const [copyState, setCopyState] = useState<CopyState>("idle")

  useEffect(() => {
    let active = true
    setDetail(null)
    setError(false)
    void client
      .get(slug)
      .then((value) => {
        if (active) setDetail(value)
      })
      .catch(() => {
        if (active) setError(true)
      })
    return () => {
      active = false
    }
  }, [client, slug])

  const copyInstallRequest = async () => {
    setCopyState("copying")
    try {
      if (navigator.clipboard === undefined) throw new Error("Clipboard unavailable")
      await navigator.clipboard.writeText(`Install ${slug} from the Morph marketplace`)
      setCopyState("copied")
    } catch {
      setCopyState("error")
    }
  }

  if (error) {
    return (
      <main className="mx-auto grid min-h-[70vh] max-w-6xl place-items-center px-5 py-16">
        <div className="max-w-sm text-center">
          <h1 className="text-2xl font-semibold tracking-[-0.025em]">This redesign could not load.</h1>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">Return to Explore and try another redesign.</p>
          <Button className="mt-6" onClick={onBack}>
            Back to Explore
          </Button>
        </div>
      </main>
    )
  }

  if (detail === null) {
    return (
      <main className="mx-auto min-h-[70vh] max-w-6xl px-5 py-16" aria-live="polite">
        <div className="h-5 w-24 animate-pulse rounded bg-muted" />
        <div className="mt-12 h-12 w-64 animate-pulse rounded-lg bg-muted" />
        <div className="mt-5 h-5 max-w-xl animate-pulse rounded bg-muted" />
      </main>
    )
  }

  return (
    <main className="marketplace-reveal mx-auto max-w-6xl px-5 pb-20 pt-8 sm:px-8 sm:pt-12">
      <button
        type="button"
        onClick={onBack}
        className="min-h-11 rounded-lg px-2 text-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        Back to Explore
      </button>

      <div className="mt-7 grid items-start gap-10 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>{new URL(detail.origin).hostname}</span>
            <span aria-hidden="true">·</span>
            <span>v{detail.version}</span>
            <span aria-hidden="true">·</span>
            <span>{detail.license}</span>
          </div>
          <h1 className="mt-4 text-4xl font-semibold tracking-[-0.035em] sm:text-5xl">{detail.name}</h1>
          <p className="mt-5 max-w-2xl text-base leading-7 text-muted-foreground">{detail.summary}</p>

          <div className="mt-8 lg:hidden">
            <InstallPanel detail={detail} copyState={copyState} onCopy={copyInstallRequest} />
          </div>

          <section className="mt-10 overflow-hidden rounded-2xl bg-muted" aria-label="Before and after preview">
            <div className="grid min-h-72 gap-px bg-border md:grid-cols-2">
              <Preview image={detail.files.before} label="Before" />
              <Preview image={detail.files.after} label="After" />
            </div>
          </section>

          <section className="mt-12">
            <h2 className="text-xl font-semibold tracking-[-0.02em]">What it can access</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
              Morph checks this scope before activation. The redesign cannot run outside these pages.
            </p>
            <div className="mt-5 divide-y divide-border-strong rounded-xl bg-card px-5">
              <Fact label={scopeLabel(detail)} value={scopeValue(detail)} />
              <Fact
                label="Page access"
                value={detail.manifest.permissions.page.length === 0 ? "No page permissions" : detail.manifest.permissions.page.join(", ")}
              />
              <Fact
                label="Network access"
                value={
                  detail.manifest.permissions.network.length === 0
                    ? "No outside network access"
                    : detail.manifest.permissions.network.join(", ")
                }
              />
            </div>
          </section>
        </div>

        <aside className="sticky top-24 hidden lg:block">
          <InstallPanel detail={detail} copyState={copyState} onCopy={copyInstallRequest} />
        </aside>
      </div>
    </main>
  )
}

function InstallPanel({
  detail,
  copyState,
  onCopy
}: {
  readonly detail: PackageDetail
  readonly copyState: CopyState
  readonly onCopy: () => Promise<void>
}) {
  const buttonLabel =
    copyState === "copying"
      ? "Copying install request…"
      : copyState === "copied"
        ? "Install request copied"
        : "Copy install request"

  return (
    <div className="rounded-2xl bg-card p-5">
      <p className="text-sm font-medium">{scopeLabel(detail)}</p>
      <p className="mt-1 break-all font-mono text-[11px] leading-5 text-muted-foreground">{scopeValue(detail)}</p>
      <Button
        className="mt-5 w-full"
        size="lg"
        disabled={copyState === "copying"}
        onClick={() => void onCopy()}
      >
        {buttonLabel}
      </Button>
      {copyState === "error" ? (
        <p className="mt-3 text-xs leading-5 text-destructive" role="status">
          The install request could not copy. Copy this manually:{" "}
          <code className="font-mono">Install {detail.slug} from the Morph marketplace</code>
        </p>
      ) : (
        <p className="mt-3 text-xs leading-5 text-muted-foreground">
          Paste the request into Morph on the website you want to change.
        </p>
      )}
      <div className="mt-6 space-y-3 border-t border-border-strong pt-5 text-xs">
        <DetailRow label="Author" value={detail.author.displayName ?? `@${detail.author.handle}`} />
        <DetailRow label="Installs" value={count(detail.installs, "install")} />
        <DetailRow label="Runtime" value={detail.runtime === "declarative-v1" ? "Safe view" : "Page script"} />
      </div>
      <ButtonLink
        href={detail.source.url}
        target="_blank"
        rel="noreferrer"
        variant="outline"
        className="mt-5 w-full"
      >
        View source
      </ButtonLink>
    </div>
  )
}

function Preview({ image, label }: { readonly image: string; readonly label: string }) {
  return (
    <figure className="relative min-h-72 overflow-hidden bg-background">
      <img src={image} alt={`${label} redesign preview`} className="h-full min-h-72 w-full object-cover" />
      <figcaption className="absolute left-3 top-3 rounded-full bg-background/90 px-3 py-1.5 text-xs font-medium shadow-sm backdrop-blur-sm">
        {label}
      </figcaption>
    </figure>
  )
}

function Fact({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="grid gap-1 py-4 sm:grid-cols-[180px_minmax(0,1fr)] sm:gap-5">
      <p className="text-sm font-medium">{label}</p>
      <p className="break-words text-sm text-muted-foreground sm:text-right">{value}</p>
    </div>
  )
}

function DetailRow({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  )
}
