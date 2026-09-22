import type { ForkPreview } from "./forks/editor"
import { currentRevisionOf, parentKey, type ForkDraft } from "./forks/model"
import type { ForkPreviewAnswer } from "./forks/preview"
import type { InstalledLibrary } from "./installer"
import type { PagePackagePreview, PagePreviewAnswer } from "./preview"
import {
  installedReleaseOn,
  sandboxOn,
  scopeMatches,
  type SandboxInstall
} from "./sandbox/installed"

type SendReply<A> = (answer: A) => void

interface WaitingReply<A> {
  readonly kind: "preview" | "clear"
  readonly id: string | undefined
  readonly send: SendReply<A>
}

const replyChannel = <A>() => {
  let waiting: WaitingReply<A> | undefined
  return {
    replace: (next: WaitingReply<A>, replaced: A): void => {
      const previous = waiting
      waiting = next
      previous?.send(replaced)
    },
    waiting: (): WaitingReply<A> | undefined => waiting,
    settle: (answer: A): void => {
      const settled = waiting
      waiting = undefined
      settled?.send(answer)
    }
  }
}

const temporaryMarketplace = (preview: PagePackagePreview): SandboxInstall => ({
  slug: `preview:${preview.id}`,
  mode: "temporary",
  js: preview.js,
  css: preview.css,
  capabilities: preview.capabilities
})

/**
 * A fork of a sandbox package, drawn as the frame the parent runs in. A page package's
 * fork has no capabilities and no frame; it is not drawn here (see the runtime check in
 * `current`), since the page wears its style and script instead.
 */
const temporaryFork = (preview: ForkPreview): SandboxInstall | undefined =>
  preview.revision.capabilities === undefined
    ? undefined
    : {
        slug: `local:${preview.draftId}`,
        mode: "temporary",
        js: preview.revision.compiled.script,
        css: preview.revision.compiled.style,
        capabilities: preview.revision.capabilities
      }

const savedForkInstall = (draft: ForkDraft): SandboxInstall | undefined => {
  const revision = currentRevisionOf(draft)
  if (revision.capabilities === undefined) return undefined
  return {
    slug: `local:${draft.id}`,
    mode: "temporary",
    js: revision.compiled.script,
    css: revision.compiled.style,
    capabilities: revision.capabilities
  }
}

export interface PagePreviewState {
  readonly changes: EventTarget
  readonly showMarketplace: (preview: PagePackagePreview, send: SendReply<PagePreviewAnswer>) => void
  readonly clearMarketplace: (send: SendReply<PagePreviewAnswer>) => void
  readonly stopMarketplace: (answer: PagePreviewAnswer) => void
  readonly showFork: (preview: ForkPreview, send: SendReply<ForkPreviewAnswer>) => void
  readonly clearFork: (draftId: string, send: SendReply<ForkPreviewAnswer>) => void
  readonly navigate: () => void
  readonly refresh: (installed: SandboxInstall | undefined, mounted: boolean) => void
  readonly current: (
    location: Pick<Location, "origin" | "pathname">,
    library: InstalledLibrary,
    drafts: Readonly<Record<string, ForkDraft>>
  ) => SandboxInstall | undefined
}

export const createPagePreviewState = (): PagePreviewState => {
  const changes = new EventTarget()
  const marketplaceReplies = replyChannel<PagePreviewAnswer>()
  const forkReplies = replyChannel<ForkPreviewAnswer>()
  const suppressedDrafts = new Set<string>()
  let marketplace: PagePackagePreview | undefined
  let fork: ForkPreview | undefined

  const changed = (): void => {
    changes.dispatchEvent(new Event("change"))
  }

  return {
    changes,
    showMarketplace: (preview, send) => {
      marketplaceReplies.replace(
        { kind: "preview", id: preview.id, send },
        {
          type: "marketplacePreviewError",
          message: "the marketplace preview was replaced"
        }
      )
      marketplace = preview
      changed()
    },
    clearMarketplace: (send) => {
      marketplaceReplies.replace(
        { kind: "clear", id: undefined, send },
        {
          type: "marketplacePreviewError",
          message: "the marketplace preview was replaced"
        }
      )
      marketplace = undefined
      changed()
    },
    stopMarketplace: (answer) => {
      const hadPreview = marketplace !== undefined
      marketplace = undefined
      marketplaceReplies.settle(answer)
      if (hadPreview) changed()
    },
    showFork: (preview, send) => {
      forkReplies.replace(
        { kind: "preview", id: preview.draftId, send },
        {
          type: "forkPreviewError",
          message: "the local Morph preview was replaced"
        }
      )
      suppressedDrafts.delete(preview.draftId)
      fork = preview
      changed()
    },
    clearFork: (draftId, send) => {
      forkReplies.replace(
        { kind: "clear", id: draftId, send },
        {
          type: "forkPreviewError",
          message: "the local Morph preview was replaced"
        }
      )
      suppressedDrafts.add(draftId)
      if (fork?.draftId === draftId) fork = undefined
      changed()
    },
    navigate: () => {
      const hadPreview = marketplace !== undefined || fork !== undefined
      marketplace = undefined
      fork = undefined
      marketplaceReplies.settle({
        type: "marketplacePreviewError",
        message: "the marketplace preview stopped when the page changed"
      })
      forkReplies.settle({
        type: "forkPreviewError",
        message: "the local Morph preview stopped when the page changed"
      })
      if (hadPreview) changed()
    },
    refresh: (installed, mounted) => {
      let restore = false
      const marketplaceWaiting = marketplaceReplies.waiting()
      if (marketplaceWaiting?.kind === "preview") {
        if (installed?.slug === `preview:${marketplaceWaiting.id}` && mounted) {
          marketplaceReplies.settle({ type: "marketplacePackagePreviewed" })
        } else {
          marketplace = undefined
          restore = true
          marketplaceReplies.settle({
            type: "marketplacePreviewError",
            message: "the marketplace Morph does not match this page"
          })
        }
      } else if (
        marketplaceWaiting?.kind === "clear" &&
        !installed?.slug.startsWith("preview:")
      ) {
        marketplaceReplies.settle({ type: "marketplacePreviewStopped" })
      }

      const forkWaiting = forkReplies.waiting()
      if (forkWaiting?.kind === "preview") {
        if (installed?.slug === `local:${forkWaiting.id}` && mounted) {
          forkReplies.settle({ type: "forkRevisionPreviewed" })
        } else {
          if (fork?.draftId === forkWaiting.id) fork = undefined
          restore = true
          forkReplies.settle({
            type: "forkPreviewError",
            message: "the local Morph draft does not match this page"
          })
        }
      } else if (
        forkWaiting?.kind === "clear" &&
        installed?.slug !== `local:${forkWaiting.id}`
      ) {
        forkReplies.settle({ type: "forkPreviewCleared" })
      }

      if (restore) queueMicrotask(changed)
    },
    current: (location, library, drafts) => {
      if (marketplace !== undefined && scopeMatches(marketplace.scope, location)) {
        return temporaryMarketplace(marketplace)
      }
      if (fork !== undefined && scopeMatches(fork.scope, location)) {
        return temporaryFork(fork)
      }
      const release = installedReleaseOn(library, location)
      if (release !== undefined) {
        const saved = Object.values(drafts).find(
          (draft) =>
            !suppressedDrafts.has(draft.id) &&
            parentKey(draft.parent) ===
              parentKey({
                slug: release.slug,
                version: release.version,
                commit: release.detail.source.commit
              })
        )
        if (saved !== undefined) return savedForkInstall(saved)
      }
      return sandboxOn(library, location)
    }
  }
}
