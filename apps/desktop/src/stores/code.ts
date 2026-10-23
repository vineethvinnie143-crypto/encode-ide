import { create } from '../store'
import type { LanguageServersReport } from '@shared/types'
import { api } from '../api'
import { errorText } from '../ipc-error'

interface CodeStore {
  /** The open folder's language servers as last read; null when no folder is open or nothing was read yet. */
  report: LanguageServersReport | null
  /** Why the last read failed, if it did; the report is then the last good one. */
  error: string | null
  loading: boolean
  /** Reads the report again. An answer that arrives after a newer request was made is dropped. */
  refresh(): Promise<void>
}

/** Counts requests, so a slow old answer cannot replace a newer one. */
let generation = 0

export const useCode = create<CodeStore>((set) => ({
  report: null,
  error: null,
  loading: false,

  refresh: async () => {
    const mine = ++generation
    set({ loading: true })
    try {
      const report = await api.code.report()
      if (mine === generation) set({ report, error: null, loading: false })
    } catch (error) {
      if (mine === generation) set({ error: errorText(error), loading: false })
    }
  },
}))
