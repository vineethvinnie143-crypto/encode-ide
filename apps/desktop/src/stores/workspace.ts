import { create } from '../store'
import type { FileEntry, OpenWorkspace } from '@shared/types'
import { api } from '../api'
import { SWITCH_BLOCKED, canSwitchProject } from './sidebar-model'
import { useStatus } from './status'
import { useUi } from './ui'

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
      useUi.getState().notify('error', `Could not restore workspace: ${(error as Error).message}`)
    }
  },

  openDialog: async () => {
    // The folder to be chosen is not known yet, so any running session blocks the dialog.
    if (useStatus.getState().anyBusy()) {
      useUi.getState().notify('info', SWITCH_BLOCKED)
      return
    }
    try {
      const workspace = await api.workspace.openDialog()
      if (!workspace) return
      set({ workspace, children: {}, expanded: {}, selected: null })
      await get().loadDir('')
    } catch (error) {
      useUi.getState().notify('error', (error as Error).message)
    }
  },

  openPath: async (path: string) => {
    // The agent works in the open folder: opening another one under a running session would redirect it.
    const check = canSwitchProject(path, get().workspace?.root ?? null, useStatus.getState().statusById)
    if (!check.ok) {
      useUi.getState().notify('info', check.reason ?? SWITCH_BLOCKED)
      return
    }
    try {
      const workspace = await api.workspace.openPath(path)
      set({ workspace, children: {}, expanded: {}, selected: null })
      await get().loadDir('')
    } catch (error) {
      useUi.getState().notify('error', (error as Error).message)
    }
  },

  close: async () => {
    try {
      await api.workspace.close()
    } catch {
      /* ignore */
    }
    set({ workspace: null, children: {}, expanded: {}, selected: null })
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
      useUi.getState().notify('error', `Could not read ${rel || 'folder'}: ${(error as Error).message}`)
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
      useUi.getState().notify('error', (error as Error).message)
    }
  },

  createDir: async (parentRel, name) => {
    try {
      await api.workspace.createDir(parentRel, name)
      set((state) => ({ expanded: { ...state.expanded, [parentRel]: true } }))
      await get().loadDir(parentRel)
      useUi.getState().notify('success', `Created ${name}/`)
    } catch (error) {
      useUi.getState().notify('error', (error as Error).message)
    }
  },

  rename: async (rel, newName) => {
    try {
      await api.workspace.rename(rel, newName)
      await get().refreshAll()
      useUi.getState().notify('success', `Renamed to ${newName}`)
    } catch (error) {
      useUi.getState().notify('error', (error as Error).message)
    }
  },

  remove: async (rel) => {
    const name = rel.split('/').pop() ?? rel
    try {
      await api.workspace.delete(rel)
      await get().refreshAll()
      useUi.getState().notify('info', `Moved ${name} to the trash`)
    } catch (error) {
      useUi.getState().notify('error', (error as Error).message)
    }
  },
}))
