import { create } from '../store'
import type { SessionSummary } from '@shared/types'
import { api } from '../api'
import { setActiveSessionId } from './active'
import { useChat } from './chat'

interface SessionsStore {
  sessions: SessionSummary[]
  activeId: string
  ready: boolean
  init(): Promise<void>
  refresh(): Promise<void>
  newSession(): Promise<void>
  select(id: string): Promise<void>
  fork(id: string): Promise<void>
  remove(id: string): Promise<void>
  rename(id: string, title: string): Promise<void>
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
  }

  return {
    sessions: [],
    activeId: '',
    ready: false,

    init: async () => {
      let sessions = await api.agent.sessions()
      if (!sessions.length) sessions = [await api.agent.createSession()]
      let stored = ''
      try {
        stored = localStorage.getItem(ACTIVE_KEY) ?? ''
      } catch {
        stored = ''
      }
      const active = sessions.find((session) => session.id === stored)?.id ?? sessions[0].id
      set({ sessions, ready: true })
      await activate(active)
    },

    refresh: async () => {
      set({ sessions: await api.agent.sessions() })
    },

    newSession: async () => {
      const created = await api.agent.createSession()
      set({ sessions: await api.agent.sessions() })
      await activate(created.id)
    },

    select: async (id) => {
      if (id === get().activeId) return
      await activate(id)
    },

    fork: async (id) => {
      const forked = await api.agent.fork(id)
      set({ sessions: await api.agent.sessions() })
      await activate(forked.id)
    },

    remove: async (id) => {
      await api.agent.remove(id)
      let sessions = await api.agent.sessions()
      if (!sessions.length) sessions = [await api.agent.createSession()]
      set({ sessions })
      if (get().activeId === id) await activate(sessions[0].id)
    },

    rename: async (id, title) => {
      const trimmed = title.trim()
      if (!trimmed) return
      await api.agent.rename(id, trimmed)
      set({ sessions: await api.agent.sessions() })
    },
  }
})
