import type { ThreadMascotIdentity } from "./Mascot"
import { botMascot, ThreadMascot } from "./Mascot"
import { botTargetsOf, type ToolCall } from "./tools-view"

export function ToolBots({
  call,
  current
}: {
  call: ToolCall
  current: ThreadMascotIdentity
}) {
  const bots = botTargetsOf(call, current.seed)

  return (
    <span className="inline-flex shrink-0 -space-x-1" data-testid="tool-bots">
      {bots.map((bot) => (
        <span key={bot.seed} className="grid size-4 place-items-center">
          <ThreadMascot
            {...(bot.destination ? botMascot(bot.seed) : current)}
            size={14}
            label={`${bot.destination ? "Destination" : "Tool"} bot ${bot.seed}`}
          />
        </span>
      ))}
    </span>
  )
}
