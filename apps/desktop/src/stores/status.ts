import { create } from '../store'
import type { AgentStatus } from '@shared/types'
import { isBusy } from './sidebar-model'

interface StatusStore {
  /** The live state of every session, from the agent's events. Missing means idle. */
  statusById: Record<string, AgentStatus>
  set(sessionId: string, status: AgentStatus): void
  /** Replaces everything: the state of the sessions that are running or waiting, when the app starts. */
  replace(statusById: Record<string, AgentStatus>): void
  forget(sessionId: string): void
  /** True while any session is running or waiting: the agent is acting on the open folder. */
  anyBusy(): boolean
}

/** Kept apart from the sessions store so the workspace store can check it without importing sessions. */
export const useStatus = create<StatusStore>((set, get) => ({
  statusById: {},
  set: (sessionId, status) => set((state) => ({ statusById: { ...state.statusById, [sessionId]: status } })),
  replace: (statusById) => set({ statusById: { ...statusById } }),
  forget: (sessionId) =>
    set((state) => {
      const statusById = { ...state.statusById }
      delete statusById[sessionId]
      return { statusById }
    }),
  anyBusy: () => Object.values(get().statusById).some(isBusy),
}))
