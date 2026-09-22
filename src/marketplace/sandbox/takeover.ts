/**
 * Host-owned page takeover for a sandbox package.
 *
 * The guest cannot see the page. Morph hides the declared slot and mounts a
 * flow-sized frame in its place. Restore puts GitHub's content back.
 */

export interface TakeoverGrant {
  readonly slot: string
  readonly fallback?: string
}

export interface PageTakeover {
  readonly parent: Element
  readonly restore: () => void
}

const HIDDEN = "data-morph-hidden"

const firstOf = (document: Document, selectors: ReadonlyArray<string>): Element | null => {
  for (const selector of selectors) {
    const found = document.querySelector(selector)
    if (found !== null) return found
  }
  return null
}

const hideChildren = (slot: Element): ReadonlyArray<Element> => {
  const hidden: Element[] = []
  for (const child of [...slot.children]) {
    if (child instanceof HTMLElement) {
      child.setAttribute(HIDDEN, "")
      child.hidden = true
      hidden.push(child)
    }
  }
  return hidden
}

export const takePage = (document: Document, grant: TakeoverGrant): PageTakeover | undefined => {
  const slot = firstOf(document, grant.fallback === undefined ? [grant.slot] : [grant.slot, grant.fallback])
  if (slot === null) return undefined
  const hidden = hideChildren(slot)
  return {
    parent: slot,
    restore: () => {
      for (const child of hidden) {
        if (child instanceof HTMLElement) {
          child.removeAttribute(HIDDEN)
          child.hidden = false
        }
      }
    }
  }
}
