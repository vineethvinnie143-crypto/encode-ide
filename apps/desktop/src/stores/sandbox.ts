import { create } from '../store'
import type { SandboxAction, SandboxOutcome, SandboxReport } from '@shared/types'
import { api } from '../api'
import { errorText } from '../ipc-error'

interface SandboxStore {
  /** The sandbox in the open folder as last read; null when no folder is open or nothing was read yet. */
  report: SandboxReport | null
  /** Why the last read failed, if it did; the report is then the last good one. */
  error: string | null
  loading: boolean
  /** Reads the sandbox again. An answer that arrives after a newer request was made is dropped. */
  refresh(): Promise<void>
  /** Does something; the report becomes the sandbox as it stands afterwards. Null when the call itself failed. */
  act(action: SandboxAction): Promise<SandboxOutcome | null>
}

/** Counts requests, so a slow old answer cannot replace a newer one. */
let generation = 0

export const useSandbox = create<SandboxStore>((set) => ({
  report: null,
  error: null,
  loading: false,

  refresh: async () => {
    const mine = ++generation
    set({ loading: true })
    try {
      const report = await api.sandbox.report()
      if (mine === generation) set({ report, error: null, loading: false })
    } catch (error) {
      if (mine === generation) set({ error: errorText(error), loading: false })
    }
  },

  act: async (action) => {
    const mine = ++generation
    try {
      const outcome = await api.sandbox.act(action)
      if (mine === generation) set({ report: outcome.report, error: null, loading: false })
      return outcome
    } catch (error) {
      if (mine === generation) set({ error: errorText(error), loading: false })
      return null
    }
  },
}))
