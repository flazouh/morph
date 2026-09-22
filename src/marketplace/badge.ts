/**
 * What the toolbar icon says about the page in front: how many Morphs the reader could
 * add to it.
 *
 * The card's own strip lists them, but only once the reader opens the card. The icon is
 * the one Morph surface on every page, so the count belongs there: silent when the page
 * has nothing, a number when it does. It counts what the reader does not already have,
 * since a Morph they installed is not news.
 */
import type { PackageMatch } from "./discovery"
import type { InstalledLibrary } from "./installer"

export interface Badge {
  /** What the icon shows. Empty means no badge. */
  readonly text: string
  /** What its tooltip says, in full. */
  readonly title: string
}

export const NO_BADGE: Badge = { text: "", title: "Morph" }

/** The mark's own pink, so the count reads as Morph's and not as the browser's. */
export const BADGE_COLOR = "#E02988"

/** More than this many is a wide badge on a small icon, so the count moves to the tooltip. */
const MOST = 9

export const badgeFor = (count: number): Badge =>
  count <= 0
    ? NO_BADGE
    : { text: count > MOST ? `${MOST}+` : String(count), title: `${count} ${count === 1 ? "Morph" : "Morphs"} for this page` }

export interface BadgePorts {
  readonly find: (
    location: Pick<Location, "origin" | "pathname">,
    installed: InstalledLibrary
  ) => Promise<ReadonlyArray<PackageMatch>>
  readonly library: () => Promise<InstalledLibrary>
  readonly show: (tabId: number, badge: Badge) => Promise<void>
}

/** A page Morph can restyle, and so a page the marketplace has anything to say about. */
const pageOf = (url: string | undefined): URL | undefined => {
  if (url === undefined || url === "") return undefined
  try {
    const location = new URL(url)
    return location.protocol === "https:" || location.protocol === "http:" ? location : undefined
  } catch {
    return undefined
  }
}

/**
 * Puts the count for `url` on `tabId`'s icon, and answers with it.
 *
 * Every failure reads as nothing to add. A marketplace that cannot answer must clear the
 * badge rather than leave the last page's count on this one, and a tab that went away
 * while this ran is not the caller's problem: the badge is a hint, never a step in a task.
 */
export const markTab = async (ports: BadgePorts, tabId: number, url: string | undefined): Promise<number> => {
  const page = pageOf(url)
  let count = 0
  if (page !== undefined) {
    try {
      const matches = await ports.find(page, await ports.library())
      count = matches.filter((match) => !match.installed).length
    } catch {
      count = 0
    }
  }
  await ports.show(tabId, badgeFor(count)).catch(() => undefined)
  return count
}
