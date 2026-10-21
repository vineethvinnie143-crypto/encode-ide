import { create } from '../store'
import type { AgentEvent, SessionPatch, SessionSummary } from '@shared/types'
import { api } from '../api'
import { setActiveSessionId } from './active'
import { useChat } from './chat'
import { canGoBack, canGoForward, emptyHistory, forget, goBack, goForward, visit, type History } from './history'
import { sameRoot } from './sidebar-model'
import { useStatus } from './status'
import { useWorkspace } from './workspace'

interface SessionsStore {
  sessions: SessionSummary[]
  activeId: string
  ready: boolean
  /** The sessions you have opened, for Back and Forward. */
  history: History<string>
  init(): Promise<void>
  refresh(): Promise<void>
  /** A session in the open folder. */
  newSession(): Promise<void>
  /** Opens a session, switching the open folder to its project first. False when that was refused. */
  select(id: string, options?: { remember?: boolean }): Promise<boolean>
  fork(id: string): Promise<void>
  remove(id: string): Promise<void>
  rename(id: string, title: string): Promise<void>
  update(id: string, patch: SessionPatch): Promise<void>
  /** Gives the open folder to the open session when it is unused and has no project yet. */
  adoptProject(): Promise<void>
  back(): Promise<void>
  forward(): Promise<void>
  canGoBack(): boolean
  canGoForward(): boolean
  applyEvent(event: AgentEvent): void
}

const ACTIVE_KEY = 'eNCode.activeSession'

export const useSessions = create<SessionsStore>((set, get) => {
  const activate = async (id: string): Promise<void> => {
    setActiveSessionId(id)
    try {
      localStorage.setItem(ACTIVE_KEY, id)
    } catch {
      /* storage unavailable */
    }
    set({ activeId: id })
    await useChat.getState().load(id)
    await adoptProjectFor(id)
  }

  /** An unused session with no project belongs to the folder that is open. */
  const adoptProjectFor = async (id: string): Promise<void> => {
    const root = useWorkspace.getState().workspace?.root
    const session = get().sessions.find((item) => item.id === id)
    if (root && session && session.projectRoot === null && session.entryCount === 0) await get().update(id, { projectRoot: root })
  }

  /** Opens a session's folder when it differs from the open one; false when that failed or is not allowed now. */
  const openProjectOf = async (session: SessionSummary): Promise<boolean> => {
    const workspace = useWorkspace.getState()
    if (!session.projectRoot || sameRoot(session.projectRoot, workspace.workspace?.root)) return true
    // openPath refuses while a session runs, and reports a folder it cannot open.
    await workspace.openPath(session.projectRoot)
    // A session must not run in the wrong folder.
    return sameRoot(useWorkspace.getState().workspace?.root, session.projectRoot)
  }

  /** The session to open when the open one goes away: one in the open folder, so nothing switches project. */
  const fallbackFor = (goneId: string): SessionSummary | undefined => {
    const root = useWorkspace.getState().workspace?.root ?? null
    return get().sessions.find(
      (session) => session.id !== goneId && !session.archived && (session.projectRoot === null || sameRoot(session.projectRoot, root)),
    )
  }

  return {
    sessions: [],
    activeId: '',
    ready: false,
    history: emptyHistory<string>(),

    init: async () => {
      let sessions = await api.agent.sessions()
      if (!sessions.length) sessions = [await api.agent.createSession()]
      let stored = ''
      try {
        stored = localStorage.getItem(ACTIVE_KEY) ?? ''
      } catch {
        stored = ''
      }
      const open = sessions.filter((session) => !session.archived)
      const active = open.find((session) => session.id === stored)?.id ?? open[0]?.id ?? sessions[0].id
      set({ sessions, ready: true, history: visit(emptyHistory<string>(), active) })
      // A window that reopens while the agent works still shows who is running or waiting.
      useStatus.getState().replace(await api.agent.statuses().catch(() => ({})))
      await activate(active)
    },

    refresh: async () => {
      set({ sessions: await api.agent.sessions() })
    },

    newSession: async () => {
      const created = await api.agent.createSession()
      set((state) => ({ history: visit(state.history, created.id) }))
      set({ sessions: await api.agent.sessions() })
      await activate(created.id)
    },

    select: async (id, options) => {
      const session = get().sessions.find((item) => item.id === id)
      if (!session) return false
      if (id === get().activeId) return true
      if (!(await openProjectOf(session))) return false
      if (options?.remember !== false) set((state) => ({ history: visit(state.history, id) }))
      await activate(id)
      if (session.unread) await get().update(id, { unread: false })
      return true
    },

    fork: async (id) => {
      const forked = await api.agent.fork(id)
      set((state) => ({ history: visit(state.history, forked.id) }))
      set({ sessions: await api.agent.sessions() })
      await activate(forked.id)
    },

    remove: async (id) => {
      await api.agent.remove(id)
      let sessions = await api.agent.sessions()
      if (!sessions.length) sessions = [await api.agent.createSession()]
      useStatus.getState().forget(id)
      set((state) => ({ sessions, history: forget(state.history, (place) => place === id) }))
      if (get().activeId === id) {
        const next = fallbackFor(id)
        if (next) await activate(next.id)
        else await get().newSession()
      }
    },

    rename: async (id, title) => {
      const trimmed = title.trim()
      if (!trimmed) return
      await api.agent.rename(id, trimmed)
      set({ sessions: await api.agent.sessions() })
    },

    update: async (id, patch) => {
      // Show the change at once; the main process answers with the saved session.
      set((state) => ({ sessions: state.sessions.map((session) => (session.id === id ? { ...session, ...patch } : session)) }))
      const saved = await api.agent.update(id, patch)
      if (saved) set((state) => ({ sessions: state.sessions.map((session) => (session.id === id ? saved : session)) }))
      // Archiving the open session opens another one in the same folder.
      if (patch.archived === true && get().activeId === id) {
        const next = fallbackFor(id)
        if (next) await activate(next.id)
        else await get().newSession()
      }
    },

    adoptProject: async () => {
      await adoptProjectFor(get().activeId)
    },

    back: async () => {
      const previous = goBack(get().history)
      if (previous === get().history) return
      if (await get().select(previous.entries[previous.index], { remember: false })) set({ history: previous })
    },

    forward: async () => {
      const next = goForward(get().history)
      if (next === get().history) return
      if (await get().select(next.entries[next.index], { remember: false })) set({ history: next })
    },

    canGoBack: () => canGoBack(get().history),
    canGoForward: () => canGoForward(get().history),

    applyEvent: (event) => {
      const id = event.sessionId
      if (!id) return
      if (event.type === 'status') useStatus.getState().set(id, event.status)
      if (event.type === 'session-reset') useStatus.getState().set(id, 'idle')
      if (event.type === 'done' || event.type === 'error') {
        // A session that finishes while you are elsewhere is marked unread.
        if (id !== get().activeId && get().sessions.some((session) => session.id === id && !session.unread)) {
          void get().update(id, { unread: true })
        }
        void get().refresh()
      }
    },
  }
})
