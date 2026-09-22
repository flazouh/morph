import { parseInstalledLibrary, type InstalledLibrary } from "./installer"

const KEY = "marketplace-library-v1"
const EMPTY: InstalledLibrary = { active: {}, history: {} }

export const chromeLibraryMemory = {
  read: async (): Promise<InstalledLibrary> => {
    const value = (await chrome.storage.local.get(KEY))[KEY]
    return parseInstalledLibrary(value) ?? EMPTY
  },
  write: async (library: InstalledLibrary): Promise<void> => {
    await chrome.storage.local.set({ [KEY]: library })
  }
}
