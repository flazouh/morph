import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, test } from "bun:test"
import { NO_SPEND } from "@/agent/spend"
import { IDLE_TURN, type ChatThread, type Session, type ThreadState, type ThreadStore } from "@/session"
import { memoryThreads } from "@/session/threads"
import { useThreadSession, type Follow } from "./use-session"

afterEach(cleanup)

const sessionOf = (threadId: string, url: string, onDispose?: () => void): Session => {
  const steps: ReturnType<Session["steps"]> = []
  return {
    threadId,
    url,
    send: async () => undefined,
    stop: async () => undefined,
    answerQuestion: async () => false,
    steps: () => steps,
    turn: () => IDLE_TURN,
    state: () => "idle",
    spend: () => NO_SPEND,
    subscribe: () => () => undefined,
    reset: async () => undefined,
    clear: async () => undefined,
    forgetPage: async () => undefined,
    forgetSite: async () => undefined,
    ...(onDispose === undefined
      ? {}
      : {
          dispose: async () => {
            onDispose()
          }
        })
  }
}

test("a session from the old page cannot return to the cache after navigation", async () => {
  const firstThread = "https://example.com/old"
  const secondThread = "thread-two"
  const store = memoryThreads(() => secondThread)
  let move: (() => void) | undefined
  const follow: Follow = (onChange) => {
    move = onChange
    return () => {
      move = undefined
    }
  }
  let resolveStale: ((session: Session) => void) | undefined
  const stale = new Promise<Session>((resolve) => {
    resolveStale = resolve
  })
  let opens = 0
  const open = async (threadId?: string): Promise<Session> => {
    opens += 1
    if (opens === 1) return sessionOf(firstThread, "https://example.com/old")
    if (opens === 2) return stale
    return sessionOf(threadId ?? firstThread, "https://example.com/new")
  }

  function Harness() {
    const value = useThreadSession(open, follow, store)
    return (
      <>
        <output data-testid="session-url">{value.session?.url ?? "opening"}</output>
        <button type="button" onClick={() => void value.newThread()}>
          New
        </button>
      </>
    )
  }

  render(<Harness />)
  await waitFor(() => expect(screen.getByTestId("session-url").textContent).toBe("https://example.com/old"))
  fireEvent.click(screen.getByRole("button", { name: "New" }))
  await waitFor(() => expect(opens).toBe(2))

  act(() => {
    if (move === undefined) throw new Error("The page listener did not start.")
    move()
  })
  await waitFor(() => expect(screen.getByTestId("session-url").textContent).toBe("https://example.com/new"))
  await act(async () => {
    resolveStale?.(sessionOf(secondThread, "https://example.com/old"))
    await stale
  })

  await act(async () => store.select("https://example.com", firstThread))
  await waitFor(() => expect(screen.getByTestId("session-url").textContent).toBe("https://example.com/new"))
  await act(async () => store.select("https://example.com", secondThread))
  await waitFor(() => expect(screen.getByTestId("session-url").textContent).toBe("https://example.com/new"))
})

test("old-site thread actions stay blocked until the new site state loads", async () => {
  const oldState: ThreadState = {
    site: "https://example.com",
    selected: "old-thread",
    items: [{ id: "old-thread", title: "Old thread", createdAt: 0 }]
  }
  const newState: ThreadState = {
    site: "https://other.test",
    selected: "new-thread",
    items: [{ id: "new-thread", title: "New thread", createdAt: 1 }]
  }
  let resolveNewState: ((state: ThreadState) => void) | undefined
  const pendingNewState = new Promise<ThreadState>((resolve) => {
    resolveNewState = resolve
  })
  const createdOn: Array<string> = []
  const created: ChatThread = { id: "created", title: "New chat", createdAt: 2 }
  const store: ThreadStore = {
    state: (url) => (url.startsWith("https://other.test") ? pendingNewState : Promise.resolve(oldState)),
    create: async (site) => {
      createdOn.push(site)
      return created
    },
    createChild: async () => created,
    select: async () => undefined,
    name: async () => undefined,
    status: async () => undefined,
    remove: async () => oldState,
    subscribe: () => () => undefined
  }
  let move: (() => void) | undefined
  const follow: Follow = (onChange) => {
    move = onChange
    return () => {
      move = undefined
    }
  }
  let newPage = false
  const open = async (threadId?: string) =>
    newPage
      ? sessionOf(threadId ?? "new-thread", "https://other.test/account")
      : sessionOf(threadId ?? "old-thread", "https://example.com/home")

  function Harness() {
    const value = useThreadSession(open, follow, store)
    return (
      <>
        <output data-testid="session-url">{value.session?.url ?? "opening"}</output>
        <button type="button" onClick={() => void value.newThread()}>
          New
        </button>
      </>
    )
  }

  render(<Harness />)
  await waitFor(() => expect(screen.getByTestId("session-url").textContent).toBe("https://example.com/home"))
  newPage = true
  act(() => {
    if (move === undefined) throw new Error("The page listener did not start.")
    move()
  })
  await waitFor(() => expect(screen.getByTestId("session-url").textContent).toBe("https://other.test/account"))

  fireEvent.click(screen.getByRole("button", { name: "New" }))
  expect(createdOn).toEqual([])

  await act(async () => {
    resolveNewState?.(newState)
    await pendingNewState
  })
})

test("a late thread read cannot restore metadata from the page before navigation", async () => {
  const oldState: ThreadState = {
    site: "https://example.com",
    selected: "old-thread",
    items: [{ id: "old-thread", title: "Old thread", createdAt: 0 }]
  }
  let resolveOldState: ((state: ThreadState) => void) | undefined
  const pendingOldState = new Promise<ThreadState>((resolve) => {
    resolveOldState = resolve
  })
  const store: ThreadStore = {
    state: () => pendingOldState,
    create: async () => ({ id: "unused", title: "New chat", createdAt: 2 }),
    createChild: async () => ({ id: "unused-child", title: "New chat", createdAt: 3 }),
    select: async () => undefined,
    name: async () => undefined,
    status: async () => undefined,
    remove: async () => oldState,
    subscribe: () => () => undefined
  }
  let move: (() => void) | undefined
  const follow: Follow = (onChange) => {
    move = onChange
    return () => {
      move = undefined
    }
  }
  let newPage = false
  const open = async () =>
    newPage ? new Promise<Session>(() => {}) : sessionOf("old-thread", "https://example.com/home")

  function Harness() {
    const value = useThreadSession(open, follow, store)
    return (
      <>
        <output data-testid="session-url">{value.session?.url ?? "opening"}</output>
        <output data-testid="thread-site">{value.threads?.site ?? "none"}</output>
      </>
    )
  }

  render(<Harness />)
  await waitFor(() => expect(screen.getByTestId("session-url").textContent).toBe("https://example.com/home"))
  await act(async () => {
    newPage = true
    move?.()
    resolveOldState?.(oldState)
    await pendingOldState
  })
  expect(screen.getByTestId("session-url").textContent).toBe("opening")
  expect(screen.getByTestId("thread-site").textContent).toBe("none")
})

test("changing the provider opens the same thread again on the other provider", async () => {
  const store = memoryThreads(() => "thread-one")
  const follow: Follow = () => () => undefined
  const opened: Array<string> = []
  let provider = "openrouter"
  const open = async (threadId?: string): Promise<Session> => {
    opened.push(provider)
    return sessionOf(threadId ?? "old-thread", `https://example.com/home#${provider}`)
  }

  function Harness({ current }: { readonly current: string }) {
    const value = useThreadSession(open, follow, store, current)
    return <output data-testid="session-url">{value.session?.url ?? "opening"}</output>
  }

  const view = render(<Harness current="openrouter" />)
  await waitFor(() =>
    expect(screen.getByTestId("session-url").textContent).toBe("https://example.com/home#openrouter")
  )

  provider = "cursor"
  view.rerender(<Harness current="cursor" />)

  await waitFor(() =>
    expect(screen.getByTestId("session-url").textContent).toBe("https://example.com/home#cursor")
  )
  expect(opened.at(-1)).toBe("cursor")
  expect(opened.filter((each) => each === "cursor")).toHaveLength(1)
})

/** Sessions the harness handed out, and the ones the panel gave back, by name. */
const ledger = () => {
  const opened: Array<string> = []
  const disposed: Array<string> = []
  return {
    opened,
    disposed,
    session: (name: string, threadId: string, url: string): Session => {
      opened.push(name)
      return sessionOf(threadId, url, () => disposed.push(name))
    },
    /** Every session opened under `prefix` was given back, and no other one was. */
    settled: (prefix: string) => {
      const mine = opened.filter((name) => name.startsWith(prefix))
      return (
        mine.length > 0 &&
        [...disposed].sort().join() === [...mine].sort().join()
      )
    }
  }
}

test("changing the provider gives back every session it dropped, once each", async () => {
  const store = memoryThreads(() => "thread-one")
  const follow: Follow = () => () => undefined
  const book = ledger()
  let provider = "cursor"
  let opens = 0
  const open = async (threadId?: string): Promise<Session> => {
    opens += 1
    return book.session(
      `${provider}-${opens}`,
      threadId ?? "thread-one",
      `https://example.com/home#${provider}`
    )
  }

  function Harness({ current }: { readonly current: string }) {
    const value = useThreadSession(open, follow, store, current)
    return <output data-testid="session-url">{value.session?.url ?? "opening"}</output>
  }

  const view = render(<Harness current="cursor" />)
  await waitFor(() =>
    expect(screen.getByTestId("session-url").textContent).toBe("https://example.com/home#cursor")
  )

  provider = "openrouter"
  view.rerender(<Harness current="openrouter" />)
  await waitFor(() =>
    expect(screen.getByTestId("session-url").textContent).toBe("https://example.com/home#openrouter")
  )

  // No Cursor session is drawn any more, so none of them may still be running.
  await waitFor(() => expect(book.settled("cursor")).toBe(true))
})

test("a page change gives back every session of the page before", async () => {
  const store = memoryThreads(() => "thread-two")
  let move: (() => void) | undefined
  const follow: Follow = (onChange) => {
    move = onChange
    return () => {
      move = undefined
    }
  }
  const book = ledger()
  let page = "old"
  let opens = 0
  const open = async (threadId?: string): Promise<Session> => {
    opens += 1
    return book.session(`${page}-${opens}`, threadId ?? "thread-one", `https://example.com/${page}`)
  }

  function Harness() {
    const value = useThreadSession(open, follow, store)
    return (
      <>
        <output data-testid="session-url">{value.session?.url ?? "opening"}</output>
        <button type="button" onClick={() => void value.newThread()}>
          New
        </button>
      </>
    )
  }

  render(<Harness />)
  await waitFor(() => expect(screen.getByTestId("session-url").textContent).toBe("https://example.com/old"))
  fireEvent.click(screen.getByRole("button", { name: "New" }))
  await waitFor(() => expect(screen.getByTestId("session-url").textContent).toBe("https://example.com/old"))
  const beforeMove = [...book.opened]

  page = "new"
  act(() => {
    if (move === undefined) throw new Error("The page listener did not start.")
    move()
  })
  await waitFor(() => expect(screen.getByTestId("session-url").textContent).toBe("https://example.com/new"))

  // Every cached session was about the page before. None may keep a run alive.
  await waitFor(() => expect(book.settled("old")).toBe(true))
  expect(beforeMove.length).toBeGreaterThan(1)
})

test("a closed thread gives its session back", async () => {
  const store = memoryThreads(() => "thread-two")
  const follow: Follow = () => () => undefined
  const disposed: Array<string> = []
  const open = async (threadId?: string): Promise<Session> =>
    sessionOf(threadId ?? "thread-one", "https://example.com/home", () =>
      disposed.push(threadId ?? "thread-one")
    )

  function Harness() {
    const value = useThreadSession(open, follow, store)
    return (
      <>
        <output data-testid="session-url">{value.session?.url ?? "opening"}</output>
        <output data-testid="thread-id">{value.session?.threadId ?? "none"}</output>
        <button type="button" onClick={() => void value.closeThread("thread-one")}>
          Close
        </button>
      </>
    )
  }

  render(<Harness />)
  await waitFor(() => expect(screen.getByTestId("thread-id").textContent).toBe("thread-one"))

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Close" }))
  })

  await waitFor(() => expect(disposed).toEqual(["thread-one"]))
})
