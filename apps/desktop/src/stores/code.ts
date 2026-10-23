import { create } from '../store'
import type { LanguageServersReport, ServerInstallResult } from '@shared/types'
import { api } from '../api'
import { errorText } from '../ipc-error'
import { useUi } from './ui'

interface CodeStore {
  /** The open folder's language servers as last read; null when no folder is open or nothing was read yet. */
  report: LanguageServersReport | null
  /** Why the last read failed, if it did; the report is then the last good one. */
  error: string | null
  loading: boolean
  /** Reads the report again. An answer that arrives after a newer request was made is dropped. */
  refresh(): Promise<void>
  /** The server whose install dialog is open, by id. */
  installFor: string | null
  offerInstall(id: string): void
  closeInstall(): void
  /** Servers the editor stopped offering to install ("Not now"), kept on this computer. */
  declined: string[]
  decline(id: string): void
  /**
   * Installs a server the person said yes to. It goes on when the dialog is closed: a toast says how it ended, unless
   * the dialog for it is open and says so itself.
   */
  install(id: string): Promise<ServerInstallResult>
  /** Removes a server eNCode installed, once the person confirmed. */
  remove(id: string): Promise<void>
}

function labelOf(id: string): string {
  return useCode.getState().report?.servers.find((server) => server.id === id)?.label ?? id
}

const DECLINED_KEY = 'encode.code.declinedInstalls'

function readDeclined(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(DECLINED_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string').slice(0, 100) : []
  } catch {
    return []
  }
}

/** Counts requests, so a slow old answer cannot replace a newer one. */
let generation = 0

export const useCode = create<CodeStore>((set, get) => ({
  report: null,
  error: null,
  loading: false,
  installFor: null,
  declined: readDeclined(),

  offerInstall: (id) => set({ installFor: id }),
  closeInstall: () => set({ installFor: null }),
  decline: (id) => {
    const declined = [...new Set([...get().declined, id])]
    set({ declined })
    try {
      localStorage.setItem(DECLINED_KEY, JSON.stringify(declined))
    } catch {
      // Not kept: the offer comes back next time.
    }
  },

  install: async (id) => {
    const label = labelOf(id)
    let result: ServerInstallResult
    try {
      result = await api.code.install(id)
    } catch (error) {
      result = { ok: false, reason: errorText(error) }
    }
    void get().refresh()
    const notify = useUi.getState().notify
    if (result.ok) notify('success', `${label}'s language server is installed. It starts when a file of its language is opened.`)
    else if (get().installFor !== id) notify('error', `${label}'s language server was not installed. ${result.reason}`)
    return result
  },

  remove: async (id) => {
    const label = labelOf(id)
    const ui = useUi.getState()
    const yes = await ui.askConfirm({
      title: `Remove ${label}'s language server?`,
      body: `eNCode deletes the copy it installed. ${label} files lose errors as you type until a server is installed again; one on the PATH or in the project is still found.`,
      confirmLabel: 'Remove',
      danger: true,
    })
    if (!yes) return
    let result: ServerInstallResult
    try {
      result = await api.code.uninstall(id)
    } catch (error) {
      result = { ok: false, reason: errorText(error) }
    }
    void get().refresh()
    if (result.ok) ui.notify('success', `${label}'s language server is removed.`)
    else ui.notify('error', result.reason)
  },

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
