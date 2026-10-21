import { create } from '../store'
import type { GitStatus } from '@shared/types'
import { api } from '../api'

interface GitStore {
  status: GitStatus
  refresh(): Promise<void>
}

export const useGit = create<GitStore>((set) => ({
  status: { isRepo: false, changes: [] },
  refresh: async () => {
    try {
      const status = await api.git.status()
      set({ status })
    } catch {
      /* not a git repo / git missing */
    }
  },
}))
