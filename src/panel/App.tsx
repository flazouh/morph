import { Key01Icon } from "./icons"
import { useRef, useState } from "react"
import { AgentDisclosure } from "@/components/agents/agent-disclosure"
import { TodoList } from "@/components/agents/todo-list"
import { AnimatedToastStack, useAnimatedToastStack } from "@/components/motion/animated-toast-stack"
import {
  DEFAULT_SETTINGS,
  followPage as defaultFollowPage,
  openSession as defaultOpenSession,
  settings as defaultSettings,
  skills as defaultSkills,
  threads as defaultThreads,
  userScripts as defaultUserScripts,
  type Session,
  type Settings,
  type SettingsStore,
  type ThreadStore,
  type UserScriptsGate
} from "@/session"
import type { SkillsStore } from "@/skills/contract"
import { useAppearance } from "./appearance"
import { ChatTabs } from "./ChatTabs"
import { Composer } from "./Composer"
import { Header } from "./Header"
import { SettingsView } from "./SettingsView"
import { loadCursorModels as defaultLoadCursorModels, loadModels, type CatalogModel } from "./models"
import { Icon } from "./Icon"
import { botMascot } from "./Mascot"
import { currentTodosOf, lastAppliedAt, publishedIn } from "./activity"
import { MarketplaceMatches } from "./MarketplaceMatches"
import { PublishLook, PUBLISH_PROMPT } from "./PublishLook"
import { useModels } from "./use-models"
import { Transcript } from "./Transcript"
import { useThreadSession, type Follow } from "./use-session"
import { useSettings } from "./use-settings"
import { useInspectorHandoff } from "./use-inspector-handoff"
import { UserScriptsCard } from "./UserScriptsCard"
import { postInspectorPanelMessage } from "./window"
import type { PanelAction } from "@/overlay/messages"

export interface AppProps {
  /** Injected in tests. Defaults to the real `openSession`. */
  openSession?: (threadId?: string) => Promise<Session>
  /** Injected in tests. Defaults to the real store. */
  settings?: SettingsStore
  /** Injected in tests. Defaults to the durable skill store. */
  skills?: SkillsStore
  /** Injected in tests. Defaults to the durable site thread store. */
  threads?: ThreadStore
  /** Injected in tests. Defaults to following the tab this panel is beside. */
  followPage?: Follow
  /** Injected in tests. Defaults to OpenRouter's live catalog. */
  loadModels?: () => Promise<ReadonlyArray<CatalogModel>>
  /** Injected in tests. Defaults to Cursor's account-specific catalog. */
  loadCursorModels?: (key: string) => Promise<ReadonlyArray<CatalogModel>>
  /** Injected in tests. Defaults to asking the worker about `chrome.userScripts`. */
  userScripts?: UserScriptsGate
  /** Present only when this panel runs inside the page card. */
  onWindowAction?: (action: PanelAction) => void
}

export function App({
  openSession = defaultOpenSession,
  settings: store = defaultSettings,
  skills: skillStore = defaultSkills,
  threads: threadStore = defaultThreads,
  followPage = defaultFollowPage,
  loadModels: load = loadModels,
  loadCursorModels: loadCursor = defaultLoadCursorModels,
  userScripts = defaultUserScripts,
  onWindowAction
}: AppProps) {
  const current = useSettings(store)
  const provider = current?.provider ?? DEFAULT_SETTINGS.provider
  const {
    session,
    error: openError,
    steps,
    turn,
    state,
    spend,
    threads: threadState,
    selectThread,
    newThread,
    closeThread,
    nameThread
  } = useThreadSession(openSession, followPage, threadStore, current === null ? undefined : provider)
  useAppearance(current)
  const selectedModel =
    provider === "cursor"
      ? (current?.cursorModel ?? DEFAULT_SETTINGS.cursorModel)
      : (current?.model ?? DEFAULT_SETTINGS.model)
  const catalog = useModels(provider, selectedModel, current?.cursorKey ?? DEFAULT_SETTINGS.cursorKey, load, loadCursor)
  const [view, setView] = useState<"chat" | "settings">("chat")
  const [draft, setDraft] = useState("")
  const composer = useRef<HTMLTextAreaElement>(null)
  const { toasts, showToast, dismissToast } = useAnimatedToastStack({ defaultDuration: 2600, limit: 3 })

  const working = state === "working"
  // Taking the look off leaves the transcript as it was, so the run state still reads
  // "applied". The page wears nothing then, and there is nothing to offer until a later
  // write puts something back.
  const [undressedAt, setUndressedAt] = useState(0)
  const applied = state === "applied" && lastAppliedAt(steps) >= undressedAt
  const currentTodos = currentTodosOf(steps)
  const selectedThreadIndex = threadState?.items.findIndex((thread) => thread.id === threadState.selected)
  const mascotVariant = selectedThreadIndex !== undefined && selectedThreadIndex >= 0 ? selectedThreadIndex : 0
  const selectedThread = threadState?.items.find((thread) => thread.id === threadState.selected)
  // Stays closed until the store answers, so a stored key never flashes the banner.
  const keyMissing =
    current !== null && (provider === "cursor" ? current.cursorKey.trim() === "" : current.openRouterKey === "")

  // A failed turn is drawn as an error step by the session itself; `send` never rejects.
  const send = (text: string) => {
    nameThread(text)
    void session?.send(text)
  }

  const steer = async (text: string) => {
    if (session === null) return
    await session.stop()
    await session.send(text)
  }

  useInspectorHandoff({
    embedded: onWindowAction !== undefined,
    session,
    working,
    onSend: send,
    onSteer: (text) => void steer(text)
  })

  const removeLook = async (scope: "Page" | "Site", remove: () => Promise<void>) => {
    try {
      await remove()
      setUndressedAt(steps.length)
      showToast({ status: "neutral", title: `${scope} look removed` })
    } catch (error) {
      showToast({
        status: "error",
        title: `${scope} look not removed`,
        description: error instanceof Error ? error.message : String(error)
      })
    }
  }

  const forgetPage = async () => {
    if (session === null) return
    await removeLook("Page", () => session.forgetPage())
  }

  const forgetSite = async () => {
    if (session === null) return
    await removeLook("Site", () => session.forgetSite())
  }

  const saveSettings = (patch: Partial<Settings>) => {
    void store.write(patch)
  }

  const modifyMorph = (name: string) => {
    setDraft(`Modify ${name}: `)
    composer.current?.focus()
  }

  // The settings workspace takes the whole panel and, on the page card, widens it.
  const openSettings = () => {
    setView("settings")
    onWindowAction?.({ type: "setChatWide", wide: true })
  }
  const closeSettings = () => {
    setView("chat")
    onWindowAction?.({ type: "setChatWide", wide: false })
  }

  if (view === "settings") {
    return (
      <div className="flex h-full min-w-80 flex-col overflow-hidden bg-background font-sans text-foreground">
        <SettingsView
          settings={current ?? DEFAULT_SETTINGS}
          skills={skillStore}
          onChange={saveSettings}
          onBack={closeSettings}
          loadCursorModels={loadCursor}
        />
      </div>
    )
  }

  return (
    <div className="flex h-full min-w-80 flex-col overflow-hidden bg-background font-sans text-foreground">
      <Header
        busy={session === null || working}
        onForgetPage={() => void forgetPage()}
        onForgetSite={() => void forgetSite()}
        onOpenSettings={openSettings}
        onWindowAction={onWindowAction}
        onToggleInspector={
          onWindowAction === undefined ? undefined : () => postInspectorPanelMessage({ type: "toggleInspector" })
        }
      />
      {threadState === null ? null : (
        <ChatTabs
          threads={threadState.items}
          selected={threadState.selected}
          onSelect={(id) => void selectThread(id)}
          onNew={() => void newThread()}
          onClose={(id) => void closeThread(id)}
        />
      )}
      <MarketplaceMatches url={session?.url} onModify={modifyMorph} />
      <UserScriptsCard gate={userScripts} className="shrink-0" />

      <AgentDisclosure open={keyMissing} className="shrink-0 bg-warning/8">
        <button
          type="button"
          onClick={openSettings}
          className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-xs text-foreground transition-colors hover:bg-foreground/[0.04]"
        >
          <Icon icon={Key01Icon} size={14} className="shrink-0 text-warning" />
          <span className="flex-1">Add your {provider === "cursor" ? "Cursor" : "OpenRouter"} key to start</span>
          <span className="text-muted-foreground">Settings</span>
        </button>
      </AgentDisclosure>

      <main id="chat-transcript" role="tabpanel" aria-labelledby="active-chat-thread-tab" className="min-h-0 flex-1">
        {session === null ? (
          <div className="px-4 py-3 text-xs text-muted-foreground">{openError ?? "Opening session…"}</div>
        ) : (
          <Transcript
            steps={steps}
            turn={turn}
            state={state}
            provider={provider}
            mascot={selectedThread?.agentId === undefined
              ? { seed: session.threadId, variant: mascotVariant }
              : botMascot(selectedThread.agentId)}
            onAnswerQuestion={(callId, optionIds) => session.answerQuestion(callId, optionIds)}
          />
        )}
      </main>

      <footer className="shrink-0">
        <PublishLook applied={applied} published={publishedIn(steps)} onPublish={() => send(PUBLISH_PROMPT)} />
        {currentTodos.length > 0 ? (
          <div className="mx-2 mb-1 rounded-xl bg-card/70 px-1 py-0.5">
            <TodoList items={currentTodos.map((todo) => ({ id: todo.id, title: todo.title, status: todo.status }))} />
          </div>
        ) : null}
        <div className="p-2">
          <Composer
            ref={composer}
            value={draft}
            onValueChange={setDraft}
            disabled={session === null}
            working={working}
            onSend={send}
            onStop={() => void session?.stop()}
            onSteer={(text) => void steer(text)}
            models={catalog}
            model={selectedModel}
            onModelChange={(model) => void store.write(provider === "cursor" ? { cursorModel: model } : { model })}
            spend={spend}
          />
        </div>
      </footer>

      <AnimatedToastStack
        toasts={toasts}
        onDismiss={dismissToast}
        position="bottom-center"
        placement="fixed"
        maxVisible={3}
        className="bottom-24 w-[calc(100%-1.5rem)] max-w-xs"
        classNames={{ surface: "rounded-md border-0 bg-card p-1.5 shadow-lg", title: "text-xs", description: "text-[11px]" }}
      />
    </div>
  )
}
