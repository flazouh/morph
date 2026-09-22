import { useEffect, useRef, useState } from "react"
import {
  createExtensionMarketplace,
  type ExtensionMarketplace
} from "@/marketplace/extension"
import {
  currentPageDiscovery,
  type PackageMatch
} from "@/marketplace/discovery"
import { createMarketplaceClient } from "@/marketplace/client"
import type { PackageDetail } from "@/marketplace/api/http"
import { Icon } from "./Icon"
import { PackageIcon, ViewIcon, Wrench01Icon } from "./icons"

const marketplaceClient = createMarketplaceClient()
const extensionMarketplace = createExtensionMarketplace(marketplaceClient)
const discovery = currentPageDiscovery(marketplaceClient)

export interface MarketplaceMatchesProps {
  readonly url?: string
  readonly marketplace?: ExtensionMarketplace
  readonly findMatches?: typeof discovery.find
  readonly onModify: (name: string) => void
}

const faviconOf = (origin: string): string => new URL("/favicon.ico", origin).href

export function MarketplaceMatches({
  url,
  marketplace = extensionMarketplace,
  findMatches = discovery.find,
  onModify
}: MarketplaceMatchesProps) {
  const [matches, setMatches] = useState<ReadonlyArray<PackageMatch>>([])
  const [details, setDetails] = useState<Readonly<Record<string, PackageDetail>>>({})
  const [previewing, setPreviewing] = useState<string>()
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  const previewingRef = useRef<string | undefined>(undefined)

  useEffect(() => {
    void marketplace.stopPreview().catch(() => {})
    return () => {
      if (previewingRef.current !== undefined) {
        void marketplace.stopPreview().catch(() => {})
      }
    }
  }, [marketplace])

  useEffect(() => {
    if (url === undefined) {
      setMatches([])
      return
    }
    let current = true
    void marketplace
      .list()
      .then((installed) => findMatches(new URL(url), installed))
      .then((found) => {
        if (!current) return
        setMatches(found)
        void Promise.all(
          found.map(async (match) => [
            match.package.slug,
            await marketplace.detail(match.package.slug)
          ] as const)
        ).then((entries) => {
          if (current) setDetails(Object.fromEntries(entries))
        }).catch(() => {})
      })
      .catch(() => {
        if (current) setMatches([])
      })
    return () => {
      current = false
    }
  }, [findMatches, marketplace, url])

  if (matches.length === 0) return null

  const preview = async (match: PackageMatch) => {
    setBusy(match.package.slug)
    setError(undefined)
    try {
      if (previewing === match.package.slug) {
        await marketplace.stopPreview()
        previewingRef.current = undefined
        setPreviewing(undefined)
      } else {
        await marketplace.preview(match.package.slug)
        previewingRef.current = match.package.slug
        setPreviewing(match.package.slug)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Preview failed")
    } finally {
      setBusy(undefined)
    }
  }

  const install = async (match: PackageMatch) => {
    setBusy(match.package.slug)
    setError(undefined)
    try {
      await marketplace.install(match.package.slug)
      previewingRef.current = undefined
      setPreviewing(undefined)
      setMatches((items) =>
        items.map((item) =>
          item.package.slug === match.package.slug
            ? { ...item, installed: true }
            : item
        )
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Install failed")
    } finally {
      setBusy(undefined)
    }
  }

  const modify = async (match: PackageMatch) => {
    setError(undefined)
    try {
      if (previewing !== undefined) {
        await marketplace.stopPreview()
        previewingRef.current = undefined
        setPreviewing(undefined)
      }
      onModify(match.package.name)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The preview could not stop")
    }
  }

  return (
    <section
      aria-label="Morphs for this page"
      className="shrink-0 border-b border-border/60 bg-card/35"
    >
      <div className="flex items-center gap-2 px-3 py-2 text-[11px] text-muted-foreground">
        <Icon icon={PackageIcon} size={13} />
        <span className="font-medium text-foreground">
          {matches.length} {matches.length === 1 ? "Morph" : "Morphs"} for this page
        </span>
        <span className="truncate">{matches[0]?.reason}</span>
      </div>
      <div className="border-t border-border/40">
        {matches.map((match) => {
          const permissions = details[match.package.slug]?.manifest.permissions
          const active = previewing === match.package.slug
          return (
            <div
              key={`${match.package.slug}@${match.package.version}`}
              className="flex min-w-0 items-center gap-2 px-3 py-2"
            >
              <img
                src={faviconOf(match.package.origin)}
                alt=""
                width={18}
                height={18}
                className="size-[18px] shrink-0 rounded-[4px]"
                onError={(event) => {
                  event.currentTarget.hidden = true
                }}
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium text-foreground">
                  {match.package.name}
                </div>
                <div className="truncate text-[10px] text-muted-foreground">
                  {permissions === undefined
                    ? match.package.summary
                    : `${permissions.page.length} page · ${permissions.network.length} network permissions`}
                </div>
              </div>
              <button
                type="button"
                disabled={busy !== undefined}
                onClick={() => void preview(match)}
                className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11px] text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-50"
              >
                <Icon icon={ViewIcon} size={12} />
                {active ? "Restore" : "Preview"}
              </button>
              {match.installed ? (
                <button
                  type="button"
                  disabled={busy !== undefined}
                  onClick={() => void modify(match)}
                  className="inline-flex h-7 items-center gap-1 rounded-md bg-foreground px-2 text-[11px] text-background transition-opacity hover:opacity-85 disabled:opacity-50"
                >
                  <Icon icon={Wrench01Icon} size={12} />
                  Modify
                </button>
              ) : (
                <button
                  type="button"
                  disabled={busy !== undefined}
                  onClick={() => void install(match)}
                  className="h-7 rounded-md bg-foreground px-2 text-[11px] text-background transition-opacity hover:opacity-85 disabled:opacity-50"
                >
                  Install
                </button>
              )}
            </div>
          )
        })}
      </div>
      {error === undefined ? null : (
        <p role="alert" className="px-3 pb-2 text-[11px] text-destructive">
          {error}
        </p>
      )}
    </section>
  )
}
