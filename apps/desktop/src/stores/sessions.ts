import { create } from '../store'
import type { AgentEvent, SessionPatch, SessionSummary } from '@shared/types'
import { api } from '../api'
import { setActiveSessionId } from './active'
import { useChat } from './chat'
import { canGoBack, canGoForward, emptyHistory, forget, goBack, goForward, visit, type History } from './history'
import { useSettings } from './settings'
import { isChat, sameRoot } from './sidebar-model'
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
  /** A chat: a session that belongs to no project and works in the chats folder, which opens for it (File > New chat). */
  newChat(): Promise<void>
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
    // The chats folder is made again if it was removed since.
    if (isChat(session, useSettings.getState().settings?.chatsFolder)) await api.agent.chatsFolder().catch(() => undefined)
    // openPath refuses while a session runs, and reports a folder it cannot open.
    await workspace.openPath(session.projectRoot)
    // A session must not run in the wrong folder.
    return sameRoot(useWorkspace.getState().workspace?.root, session.projectRoot)
  }

  /**
   * Opens the session the history points at. The history moves first: opening takes a moment (the
   * folder, the transcript), and a second Back or Forward in that time, from a held key or a fast
   * hand, must continue from here instead of repeating the step or being lost. If the session cannot
   * be opened the history goes back, unless something else moved it meanwhile.
   */
  const stepTo = async (target: History<string>, before: History<string>): Promise<void> => {
    set({ history: target })
    const opened = await get().select(target.entries[target.index], { remember: false })
    if (!opened && get().history === target) set({ history: before })
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

    newChat: async () => {
      const folder = await api.agent.chatsFolder()
      // The folder opens first, as for a session in another project, so nothing is made when that is refused (while
      // an agent works) or put off (an unsaved file).
      if (!sameRoot(folder, useWorkspace.getState().workspace?.root)) {
        await useWorkspace.getState().openPath(folder)
        if (!sameRoot(useWorkspace.getState().workspace?.root, folder)) return
      }
      const created = await api.agent.createChat()
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
      const before = get().history
      const previous = goBack(before)
      if (previous !== before) await stepTo(previous, before)
    },

    forward: async () => {
      const before = get().history
      const next = goForward(before)
      if (next !== before) await stepTo(next, before)
    },

    canGoBack: () => canGoBack(get().history),
    canGoForward: () => canGoForward(get().history),

    applyEvent: (event) => {
      const id = event.sessionId
      if (!id) return
      if (event.type === 'status') useStatus.getState().set(id, event.status)
      if (event.type === 'session-reset') useStatus.getState().set(id, 'idle')
      // A session was named, by the model or by you: the sidebar and the window title follow at once.
      if (event.type === 'title') {
        set((state) => ({ sessions: state.sessions.map((session) => (session.id === id ? { ...session, title: event.title } : session)) }))
      }
      // The agent entered or left a worktree: the header says where it works.
      if (event.type === 'worktree') {
        const name = event.worktree?.name
        set((state) => ({
          sessions: state.sessions.map((session) => {
            if (session.id !== id || session.worktree === name) return session
            const { worktree: _left, ...rest } = session
            return name ? { ...rest, worktree: name } : rest
          }),
        }))
      }
      // Messages handed to the request: those it took leave the list, and what it left goes to the front of the queue.
      useChat.getState().followSteers(event)
      // The agent is free again: the next message you queued goes out.
      if (event.type === 'done') useChat.getState().drainQueue(id)
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
