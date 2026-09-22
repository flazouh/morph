import { changesInstalledPage, type MarketplaceAnswer } from "./messages"

export interface MarketplacePagePort {
  readonly active: () => Promise<number | undefined>
  readonly reload: (tabId: number) => Promise<void>
}

export const reloadInstalledPage = async (
  answer: MarketplaceAnswer,
  senderTabId: number | undefined,
  page: MarketplacePagePort
): Promise<void> => {
  if (!changesInstalledPage(answer)) return
  const tabId = senderTabId ?? (await page.active())
  if (tabId !== undefined) await page.reload(tabId)
}
