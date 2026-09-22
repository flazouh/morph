import { AgentDisclosure } from "@/components/agents/agent-disclosure"
import { Icon } from "./Icon"
import { PackageIcon } from "./icons"

export interface PublishLookProps {
  /** True once this thread has put something on the page. */
  readonly applied: boolean
  /** True once this thread published it, so the offer becomes a statement. */
  readonly published: boolean
  readonly onPublish: () => void
}

/** What the button asks the agent for. Its own flow shows the release and asks to confirm. */
export const PUBLISH_PROMPT = "Publish this look to the Morph marketplace."

/**
 * The offer to publish, at the moment it makes sense: the reader has a redesign on the
 * page and nothing has been said about sharing it.
 *
 * The button sends the prompt the agent already answers, rather than opening a form of its
 * own. One publish path stays: the agent reads the source back, shows the name, version and
 * files, and asks the reader to confirm before anything leaves the browser.
 */
export function PublishLook({ applied, published, onPublish }: PublishLookProps) {
  return (
    <AgentDisclosure open={applied} className="shrink-0">
      {published ? (
        <p className="flex items-center gap-2.5 px-4 py-2.5 text-xs text-muted-foreground">
          <Icon icon={PackageIcon} size={14} className="shrink-0" />
          <span>Published to the marketplace</span>
        </p>
      ) : (
        <button
          type="button"
          onClick={onPublish}
          className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-xs text-foreground transition-colors hover:bg-foreground/[0.04]"
        >
          <Icon icon={PackageIcon} size={14} className="shrink-0 text-muted-foreground" />
          <span className="flex-1">Share this look as a Morph</span>
          <span className="text-muted-foreground">Publish</span>
        </button>
      )}
    </AgentDisclosure>
  )
}
