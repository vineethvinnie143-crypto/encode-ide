import { create } from '../store'
import type { RemoteOpenFailure, RemoteState } from '@shared/types'
import { remoteParts } from '@shared/remote'
import { api } from '../api'
import { errorText } from '../ipc-error'
import { useEditor } from './editor'
import { SWITCH_BLOCKED } from './sidebar-model'
import { useStatus } from './status'
import { useWorkspace } from './workspace'

/** The Open dialog for a folder on another machine (ADR 0111). */
export interface RemoteDialogState {
  host: string
  folder: string
  phase: 'edit' | 'connecting' | 'installing'
  failure?: RemoteOpenFailure
}

interface RemoteStore {
  /** The connection the dialog last heard from, for its step line. */
  state: RemoteState | null
  /**
   * Each machine's connection, by its label. A machine that failed to open, or one the folder is leaving, reports
   * too; the folder's own badge reads only its machine's.
   */
  machines: Record<string, RemoteState>
  /** The host names of ~/.ssh/config. */
  hosts: string[]
  dialog: RemoteDialogState | null
  init(): () => void
  show(prefill?: { host?: string; folder?: string }): void
  hide(): void
  edit(patch: { host?: string; folder?: string }): void
  connect(): Promise<void>
  /** Puts eNCode's own Node.js on the machine, then connects again. */
  install(): Promise<void>
  /** A recent folder on another machine: the dialog opens on it and connects at once. */
  openRecent(uri: string): Promise<void>
}

const LAST_KEY = 'eNCode.remote.last'

function lastTyped(): { host: string; folder: string } {
  try {
    const saved = JSON.parse(localStorage.getItem(LAST_KEY) ?? 'null') as { host?: unknown; folder?: unknown } | null
    return { host: typeof saved?.host === 'string' ? saved.host : '', folder: typeof saved?.folder === 'string' ? saved.folder : '' }
  } catch {
    return { host: '', folder: '' }
  }
}

export const useRemote = create<RemoteStore>((set, get) => ({
  state: null,
  machines: {},
  hosts: [],
  dialog: null,

  init: () => {
    const heard = (state: RemoteState) =>
      set((now) => {
        const machines = { ...now.machines }
        if (state.status === 'closed') delete machines[state.label]
        else machines[state.label] = state
        return { state: state.status === 'closed' ? (now.state?.label === state.label ? null : now.state) : state, machines }
      })
    void api.remote.state().then((state) => state && heard(state), () => undefined)
    return api.remote.onState(heard)
  },

  show: (prefill) => {
    const last = lastTyped()
    set({ dialog: { host: prefill?.host ?? last.host, folder: prefill?.folder ?? last.folder, phase: 'edit' } })
    void api.remote.hosts().then((hosts) => set({ hosts }), () => undefined)
  },

  hide: () => {
    // A start that is on its way finishes; the dialog only stops showing it.
    set({ dialog: null })
  },

  edit: (patch) => {
    const dialog = get().dialog
    if (dialog && dialog.phase === 'edit') set({ dialog: { ...dialog, ...patch, failure: undefined } })
  },

  connect: async () => {
    const dialog = get().dialog
    if (!dialog || dialog.phase !== 'edit') return
    const host = dialog.host.trim()
    const folder = dialog.folder.trim()
    if (!host || !folder) return
    // As for a folder on this PC: the agent works in the open folder, and open files belong to it.
    if (useStatus.getState().anyBusy()) {
      set({ dialog: { ...dialog, failure: { ok: false, kind: 'input', message: SWITCH_BLOCKED } } })
      return
    }
    if (!(await useEditor.getState().confirmDiscardAll())) return
    set({ dialog: { ...dialog, phase: 'connecting', failure: undefined } })
    const result = await api.remote.open(host, folder).catch((error: unknown): RemoteOpenFailure => ({ ok: false, kind: 'failed', message: errorText(error) }))
    if (result.ok) {
      try {
        localStorage.setItem(LAST_KEY, JSON.stringify({ host, folder }))
      } catch {
        /* storage unavailable */
      }
      if (get().dialog) set({ dialog: null })
      await useWorkspace.getState().adopt(result.workspace)
      return
    }
    const now = get().dialog
    if (now) set({ dialog: { ...now, phase: 'edit', failure: result } })
  },

  install: async () => {
    const dialog = get().dialog
    const platform = dialog?.failure?.install?.platform
    if (!dialog || dialog.phase !== 'edit' || !platform) return
    set({ dialog: { ...dialog, phase: 'installing' } })
    const result = await api.remote.installNode(dialog.host.trim(), platform).catch((error: unknown) => ({ ok: false as const, message: errorText(error), detail: undefined as string | undefined }))
    const now = get().dialog
    if (!now) return
    if (!result.ok) {
      set({ dialog: { ...now, phase: 'edit', failure: { ok: false, kind: 'failed', message: result.message, ...(result.detail ? { detail: result.detail } : {}) } } })
      return
    }
    set({ dialog: { ...now, phase: 'edit', failure: undefined } })
    await get().connect()
  },

  openRecent: async (uri) => {
    const parts = remoteParts(uri)
    if (!parts) return
    get().show({ host: parts.machine, folder: parts.folder })
    await get().connect()
  },
}))
