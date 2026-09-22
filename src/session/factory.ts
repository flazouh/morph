/**
 * Which Session a thread opens. The panel asks for a session; the setting decides which
 * one it gets. Both keep their own history, so switching provider and switching back
 * finds each thread where the reader left it.
 */

import type { Session, Settings } from "./contract"

export interface SessionProviders {
  readonly openrouter: () => Promise<Session>
  readonly cursor: () => Promise<Session>
}

export const openProviderSession = (
  settings: Settings,
  providers: SessionProviders
): Promise<Session> => (settings.provider === "cursor" ? providers.cursor() : providers.openrouter())
