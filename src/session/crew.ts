import { createCrew, createCrewRuntime, createWork, type Crew, type CrewRuntime, type Work } from "../agent/crew"
import { pageKey } from "../agent/page"
import type { CrewToolContext } from "../agent/tools"
import type { CrewAsk } from "../overlay/messages"
import type { Session } from "./contract"
import type { ChatThread, ThreadState, ThreadStatus, ThreadStore } from "./threads"

interface PageRef {
  readonly id: number
  readonly url: string
}

interface CrewBundle {
  readonly crew: Crew
  readonly runtime: CrewRuntime
  readonly work: Work
  readonly threadByAgent: Map<string, string>
  readonly targets: Map<string, string>
  readonly renderBots: () => void
  readonly clearBots: () => void
}

export interface PreparedCrew {
  readonly context?: CrewToolContext
  readonly cached?: Session
}

export interface CrewSessions {
  readonly prepare: (
    page: PageRef,
    state: ThreadState,
    thread: ChatThread
  ) => PreparedCrew
  readonly remember: (url: string, threadId: string, session: Session) => void
  readonly stop: () => Promise<void>
}

export interface CrewSessionOptions {
  readonly threads: ThreadStore
  readonly open: (threadId: string, page: PageRef) => Promise<Session>
  readonly send: (tabId: number, message: CrewAsk) => Promise<void>
  readonly id?: () => string
}

const agentIdOf = (thread: ChatThread): string => thread.agentId ?? thread.id
const sessionKey = (url: string, threadId: string): string => `${pageKey(url)}\x00${threadId}`

const assistantOutput = (session: Session): string => {
  const last = session.steps().at(-1)
  if (last?.kind === "error") throw new Error(last.text)
  return [...session.steps()].reverse().find((step) => step.kind === "assistant")?.text ?? "Done."
}

export const createCrewSessions = (options: CrewSessionOptions): CrewSessions => {
  const bundles = new Map<string, CrewBundle>()
  const sessions = new Map<string, Session>()
  const makeId = options.id ?? (() => crypto.randomUUID())

  const prepare = (
    page: PageRef,
    state: ThreadState,
    thread: ChatThread
  ): PreparedCrew => {
    const rootId = thread.rootId ?? thread.id
    const bundleKey = sessionKey(page.url, rootId)
    let bundle = bundles.get(bundleKey)
    if (bundle === undefined) {
      const crew = createCrew()
      const root = state.items.find((item) => item.id === rootId) ?? thread
      const rootAgentId = agentIdOf(root)
      crew.spawnAgent(rootAgentId, null)
      const work = createWork(crew)
      const threadByAgent = new Map([[rootAgentId, root.id]])
      const targets = new Map<string, string>()
      const renderBots = () => {
        const bots = [...crew.state().agents.values()].flatMap((agent) => {
          const selector = targets.get(agent.id)
          return selector === undefined
            ? []
            : [{ id: agent.id, selector, status: agent.status, label: "Morph bot" }]
        })
        void options.send(page.id, { type: "setCrewBots", bots }).catch(() => undefined)
      }
      const clearBots = () => {
        void options.send(page.id, { type: "clearCrewBots" }).catch(() => undefined)
      }
      const runtime: CrewRuntime = createCrewRuntime(crew, makeId, async (childId, parentId, brief, title, target) => {
        const current = await options.threads.state(page.url)
        const parent = current.items.find((item) => agentIdOf(item) === parentId)
        if (parent === undefined) throw new Error(`parent bot "${parentId}" has no chat`)
        const child = await options.threads.createChild(state.site, parent.id, {
          title: title ?? brief,
          target,
          status: "working",
          agentId: childId
        })
        threadByAgent.set(childId, child.id)
        if (target !== undefined) targets.set(childId, target)
        renderBots()
        const session = await options.open(child.id, page)
        const childKey = sessionKey(page.url, child.id)
        if (crew.state().stopped) {
          await session.stop()
          throw new Error("crew stopped before the child started")
        }
        sessions.set(childKey, session)
        return {
          completion: session.send(brief).then(() => assistantOutput(session)),
          stop: () => session.stop()
        }
      })
      bundle = { crew, runtime, work, threadByAgent, targets, renderBots, clearBots }
      const written = new Map<string, ThreadStatus>()
      crew.subscribe(() => {
        for (const agent of crew.state().agents.values()) {
          const chat = threadByAgent.get(agent.id)
          if (chat === undefined || written.get(chat) === agent.status) continue
          written.set(chat, agent.status)
          void options.threads.status(state.site, chat, agent.status)
        }
        renderBots()
      })
      bundles.set(bundleKey, bundle)
    }

    const agentId = agentIdOf(thread)
    if (!bundle.crew.state().agents.has(agentId)) {
      const cached = sessions.get(sessionKey(page.url, thread.id))
      return cached === undefined ? {} : { cached }
    }
    const parent = state.items.find((candidate) => candidate.id === thread.parentId)
    const context: CrewToolContext = {
      agentId,
      ...(thread.parentId === undefined
        ? {}
        : { parentId: parent === undefined ? thread.parentId : agentIdOf(parent) }),
      runtime: bundle.runtime,
      work: bundle.work,
      setTarget: (selector) => {
        bundle.targets.set(agentId, selector)
        bundle.renderBots()
      }
    }
    const cached = sessions.get(sessionKey(page.url, thread.id))
    return cached === undefined ? { context } : { context, cached }
  }

  const remember = (url: string, threadId: string, session: Session): void => {
    sessions.set(sessionKey(url, threadId), session)
  }

  const stop = async (): Promise<void> => {
    const activeBundles = [...bundles.values()]
    const activeSessions = [...new Set(sessions.values())]
    await Promise.all([
      ...activeBundles.map((bundle) => bundle.runtime.stop()),
      ...activeSessions.map((session) => session.stop())
    ])
    for (const bundle of activeBundles) bundle.clearBots()
    bundles.clear()
    sessions.clear()
  }

  return { prepare, remember, stop }
}
