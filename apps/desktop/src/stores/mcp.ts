import { create } from '../store'
import type { McpAction, McpOutcome, McpReport } from '@shared/types'
import { api } from '../api'

interface McpStore {
  /** The open folder's MCP servers as last read; null when no folder is open or nothing was read yet. */
  report: McpReport | null
  /** Why the last read failed, if it did; the report is then the last good one. */
  error: string | null
  loading: boolean
  /**
   * Reads the folder's servers again. `start: false` only looks (the banner does that), so that opening a folder does
   * not start its servers; the MCP screen asks for the servers to be started, as a chat does. An answer that arrives
   * after a newer request was made is dropped.
   */
  refresh(options?: { start?: boolean }): Promise<void>
  /** Does something to one server; the report becomes the servers as they stand afterwards. Null when the call itself failed. */
  act(action: McpAction): Promise<McpOutcome | null>
}

/** Counts requests, so a slow old answer cannot replace a newer one. */
let generation = 0

export const useMcp = create<McpStore>((set) => ({
  report: null,
  error: null,
  loading: false,

  refresh: async (options) => {
    const mine = ++generation
    set({ loading: true })
    try {
      const report = await api.mcp.report(options)
      if (mine === generation) set({ report, error: null, loading: false })
    } catch (error) {
      if (mine === generation) set({ error: (error as Error).message, loading: false })
    }
  },

  act: async (action) => {
    const mine = ++generation
    try {
      const outcome = await api.mcp.act(action)
      if (mine === generation) set({ report: outcome.report, error: null, loading: false })
      return outcome
    } catch (error) {
      if (mine === generation) set({ error: (error as Error).message, loading: false })
      return null
    }
  },
}))
