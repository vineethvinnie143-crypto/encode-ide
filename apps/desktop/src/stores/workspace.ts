import { create } from '../store'
import type { FileEntry, OpenWorkspace } from '@shared/types'
import { api } from '../api'
import { useEditor } from './editor'
import { SWITCH_BLOCKED, canSwitchProject, sameRoot } from './sidebar-model'
import { useStatus } from './status'
import { useUi } from './ui'
import { errorText } from '../ipc-error'
import { remoteParts } from '@shared/remote'

/** Where a folder is: this PC, or the machine of a folder elsewhere (ADR 0111). */
const placeOf = (workspace: OpenWorkspace | null): string => (workspace?.remote ? (remoteParts(workspace.remote.uri)?.machine ?? 'remote') : 'local')

/** What follows the open folder to another machine and back: the agent there has its own sessions (stores/sessions.ts). */
let placeChanged: (() => Promise<void>) | null = null
export function whenPlaceChanges(run: () => Promise<void>): void {
  placeChanged = run
}

interface WorkspaceStore {
  workspace: OpenWorkspace | null
  children: Record<string, FileEntry[]>
  expanded: Record<string, boolean>
  loadingDirs: Record<string, boolean>
  selected: string | null
  initializing: boolean
  init(): Promise<void>
  openDialog(): Promise<void>
  openPath(path: string): Promise<void>
  /** A folder the main process opened (one on another machine, from the Open dialog): it is shown, as openPath would. */
  adopt(workspace: OpenWorkspace): Promise<void>
  close(): Promise<void>
  loadDir(rel: string): Promise<void>
  toggleDir(rel: string): Promise<void>
  select(rel: string | null): void
  refreshAll(): Promise<void>
  createFile(parentRel: string, name: string): Promise<void>
  createDir(parentRel: string, name: string): Promise<void>
  rename(rel: string, newName: string): Promise<void>
  remove(rel: string): Promise<void>
}

export const useWorkspace = create<WorkspaceStore>((set, get) => ({
  workspace: null,
  children: {},
  expanded: {},
  loadingDirs: {},
  selected: null,
  initializing: true,

  init: async () => {
    try {
      const workspace = await api.workspace.get()
      if (workspace) {
        set({ workspace, initializing: false })
        await get().loadDir('')
      } else {
        set({ workspace: null, initializing: false })
      }
    } catch (error) {
      set({ initializing: false })
      useUi.getState().notify('error', `Could not restore workspace: ${errorText(error)}`)
    }
  },

  openDialog: async () => {
    // The folder to be chosen is not known yet, so any running session blocks the dialog.
    if (useStatus.getState().anyBusy()) {
      useUi.getState().notify('info', SWITCH_BLOCKED)
      return
    }
    // Open files are paths in this folder: they cannot outlive it, so unsaved changes are settled first.
    if (!(await useEditor.getState().confirmDiscardAll())) return
    try {
      const workspace = await api.workspace.openDialog()
      if (!workspace) return
      await get().adopt(workspace)
    } catch (error) {
      useUi.getState().notify('error', errorText(error))
    }
  },

  openPath: async (path: string) => {
    // The agent works in the open folder: opening another one under a running session would redirect it.
    const check = canSwitchProject(path, get().workspace?.root ?? null, useStatus.getState().statusById)
    if (!check.ok) {
      useUi.getState().notify('info', check.reason ?? SWITCH_BLOCKED)
      return
    }
    const switching = !sameRoot(path, get().workspace?.root)
    if (switching && !(await useEditor.getState().confirmDiscardAll())) return
    try {
      await get().adopt(await api.workspace.openPath(path))
    } catch (error) {
      useUi.getState().notify('error', errorText(error))
    }
  },

  adopt: async (workspace) => {
    const before = get().workspace
    if (!sameRoot(workspace.root, before?.root) || placeOf(workspace) !== placeOf(before)) useEditor.getState().dropAll()
    set({ workspace, children: {}, expanded: {}, selected: null })
    if (placeOf(workspace) !== placeOf(before)) await placeChanged?.()
    await get().loadDir('')
  },

  close: async () => {
    if (!(await useEditor.getState().confirmDiscardAll())) return
    try {
      await api.workspace.close()
    } catch {
      /* ignore */
    }
    useEditor.getState().dropAll()
    const before = get().workspace
    set({ workspace: null, children: {}, expanded: {}, selected: null })
    // Closing a folder elsewhere brings the agent back to this PC.
    if (placeOf(before) !== 'local') await placeChanged?.()
  },

  loadDir: async (rel: string) => {
    const { workspace } = get()
    if (!workspace) return
    set((state) => ({ loadingDirs: { ...state.loadingDirs, [rel]: true } }))
    try {
      const entries = await api.workspace.list(rel)
      set((state) => ({
        children: { ...state.children, [rel]: entries },
        loadingDirs: { ...state.loadingDirs, [rel]: false },
      }))
    } catch (error) {
      set((state) => ({ loadingDirs: { ...state.loadingDirs, [rel]: false } }))
      useUi.getState().notify('error', `Could not read ${rel || 'folder'}: ${errorText(error)}`)
    }
  },

  toggleDir: async (rel: string) => {
    const expanded = get().expanded[rel]
    if (expanded) {
      set((state) => ({ expanded: { ...state.expanded, [rel]: false } }))
      return
    }
    set((state) => ({ expanded: { ...state.expanded, [rel]: true } }))
    if (!get().children[rel]) await get().loadDir(rel)
  },

  select: (rel) => set({ selected: rel }),

  refreshAll: async () => {
    const { workspace, expanded, children } = get()
    if (!workspace) return
    const dirs = new Set<string>([''])
    for (const [rel, isOpen] of Object.entries(expanded)) if (isOpen) dirs.add(rel)
    for (const rel of Object.keys(children)) if (expanded[rel]) dirs.add(rel)
    await Promise.all([...dirs].map((rel) => get().loadDir(rel)))
  },

  createFile: async (parentRel, name) => {
    try {
      await api.workspace.createFile(parentRel, name)
      set((state) => ({ expanded: { ...state.expanded, [parentRel]: true } }))
      await get().loadDir(parentRel)
      useUi.getState().notify('success', `Created ${name}`)
    } catch (error) {
      useUi.getState().notify('error', errorText(error))
    }
  },

  createDir: async (parentRel, name) => {
    try {
      await api.workspace.createDir(parentRel, name)
      set((state) => ({ expanded: { ...state.expanded, [parentRel]: true } }))
      await get().loadDir(parentRel)
      useUi.getState().notify('success', `Created ${name}/`)
    } catch (error) {
      useUi.getState().notify('error', errorText(error))
    }
  },

  rename: async (rel, newName) => {
    try {
      const renamed = await api.workspace.rename(rel, newName)
      useEditor.getState().renamePath(rel, renamed.path)
      await get().refreshAll()
      useUi.getState().notify('success', `Renamed to ${newName}`)
    } catch (error) {
      useUi.getState().notify('error', errorText(error))
    }
  },

  remove: async (rel) => {
    const name = rel.split('/').pop() ?? rel
    try {
      await api.workspace.delete(rel)
      await get().refreshAll()
      useUi.getState().notify('info', `Moved ${name} to the trash`)
    } catch (error) {
      useUi.getState().notify('error', errorText(error))
    }
  },
}))
