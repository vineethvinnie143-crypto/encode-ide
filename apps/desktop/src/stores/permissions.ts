import { create } from '../store'
import type { PermissionsAction, PermissionsOutcome, PermissionsReport } from '@shared/types'
import { api } from '../api'

interface PermissionsStore {
  /** The open folder's settings, trust and rules as last read; null when no folder is open or nothing was read yet. */
  report: PermissionsReport | null
  /** Why the last read failed, if it did; the report is then the last good one. */
  error: string | null
  loading: boolean
  /** Reads the folder again. An answer that arrives after a newer request was made is dropped. */
  refresh(): Promise<void>
  /** Does something to the folder's settings; the report becomes the folder as it stands afterwards. Null when the call itself failed. */
  act(action: PermissionsAction): Promise<PermissionsOutcome | null>
}

/** Counts requests, so a slow old answer cannot replace a newer one. */
let generation = 0

export const usePermissions = create<PermissionsStore>((set) => ({
  report: null,
  error: null,
  loading: false,

  refresh: async () => {
    const mine = ++generation
    set({ loading: true })
    try {
      const report = await api.permissions.report()
      if (mine === generation) set({ report, error: null, loading: false })
    } catch (error) {
      if (mine === generation) set({ error: (error as Error).message, loading: false })
    }
  },

  act: async (action) => {
    const mine = ++generation
    try {
      const outcome = await api.permissions.act(action)
      if (mine === generation) set({ report: outcome.report, error: null, loading: false })
      return outcome
    } catch (error) {
      if (mine === generation) set({ error: (error as Error).message, loading: false })
      return null
    }
  },
}))
