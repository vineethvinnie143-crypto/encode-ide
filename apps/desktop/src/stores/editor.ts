import { create } from '../store'
import { api } from '../api'
import { applyExternal, closeDoc, closeDocsUnder, hasDoc, isDirty, markSaved, openDoc, snapshotForSave } from '../editor/docs'
import { useUi } from './ui'

export interface Tab {
  path: string
  name: string
  /** The id of the file's language, as the footer and the status bar show it. */
  language: string
  /** Unsaved changes. The text itself lives in `editor/docs`, not in this store. */
  dirty: boolean
}

interface EditorStore {
  tabs: Tab[]
  activePath: string | null
  cursor: { line: number; column: number }
  revealLine: number | null
  openFile(path: string, line?: number): Promise<void>
  closeTab(path: string): Promise<void>
  closeOthers(path: string): Promise<void>
  closeAll(): Promise<void>
  closeTabsUnder(prefix: string): void
  setActive(path: string): void
  /** The editor reports whether the document differs from the file. */
  setDirty(path: string, dirty: boolean): void
  /** The file changed on disk: an open document without unsaved changes takes the new text. */
  applyExternalContent(path: string, content: string): void
  saveActive(): Promise<void>
  saveAll(): Promise<void>
  setCursor(line: number, column: number): void
  consumeRevealLine(): void
}

const nameOf = (path: string): string => path.split('/').pop() ?? path

/** Asks before unsaved changes are thrown away; true when there is nothing to lose or the user agrees. */
async function confirmDiscard(dirty: readonly Tab[]): Promise<boolean> {
  if (!dirty.length) return true
  const [first] = dirty
  return useUi.getState().askConfirm({
    title: dirty.length === 1 ? `Discard changes to ${first.name}?` : `Discard changes to ${dirty.length} files?`,
    body: dirty.length === 1 ? 'Your unsaved changes will be lost.' : dirty.map((tab) => tab.name).join(', '),
    confirmLabel: 'Discard',
    danger: true,
  })
}

/** The tab to show once `path` is gone, as the neighbour that takes its place. */
function neighbour(tabs: readonly Tab[], path: string): string | null {
  const index = tabs.findIndex((tab) => tab.path === path)
  const rest = tabs.filter((tab) => tab.path !== path)
  return rest[Math.min(index, rest.length - 1)]?.path ?? null
}

export const useEditor = create<EditorStore>((set, get) => ({
  tabs: [],
  activePath: null,
  cursor: { line: 1, column: 1 },
  revealLine: null,

  openFile: async (path, line) => {
    if (get().tabs.some((tab) => tab.path === path)) {
      set({ activePath: path, revealLine: line ?? null })
      return
    }
    try {
      const file = await api.workspace.read(path)
      if (file.binary) {
        useUi.getState().notify('error', `${path} is a binary file and cannot be opened as text.`)
        return
      }
      const state = openDoc(path, file.content)
      set((current) => ({
        tabs: current.tabs.some((tab) => tab.path === path)
          ? current.tabs
          : [...current.tabs, { path, name: nameOf(path), language: state.config.language.id, dirty: false }],
        activePath: path,
        revealLine: line ?? null,
      }))
    } catch (error) {
      useUi.getState().notify('error', (error as Error).message)
    }
  },

  closeTab: async (path) => {
    const tab = get().tabs.find((item) => item.path === path)
    if (!tab) return
    if (!(await confirmDiscard(tab.dirty ? [tab] : []))) return
    closeDoc(path)
    set((state) => ({
      tabs: state.tabs.filter((item) => item.path !== path),
      activePath: state.activePath === path ? neighbour(state.tabs, path) : state.activePath,
      revealLine: null,
    }))
  },

  closeOthers: async (path) => {
    const keep = get().tabs.find((tab) => tab.path === path)
    if (!keep) return
    const others = get().tabs.filter((tab) => tab.path !== path)
    if (!(await confirmDiscard(others.filter((tab) => tab.dirty)))) return
    for (const tab of others) closeDoc(tab.path)
    set({ tabs: [keep], activePath: keep.path, revealLine: null })
  },

  closeAll: async () => {
    const tabs = get().tabs
    if (!(await confirmDiscard(tabs.filter((tab) => tab.dirty)))) return
    for (const tab of tabs) closeDoc(tab.path)
    set({ tabs: [], activePath: null, revealLine: null })
  },

  closeTabsUnder: (prefix) => {
    closeDocsUnder(prefix)
    set((state) => {
      const tabs = state.tabs.filter((tab) => hasDoc(tab.path))
      const activePath = tabs.some((tab) => tab.path === state.activePath)
        ? state.activePath
        : tabs[tabs.length - 1]?.path ?? null
      return { tabs, activePath }
    })
  },

  setActive: (path) => set({ activePath: path, revealLine: null }),

  setDirty: (path, dirty) => {
    if (get().tabs.some((tab) => tab.path === path && tab.dirty !== dirty)) {
      set((state) => ({ tabs: state.tabs.map((tab) => (tab.path === path ? { ...tab, dirty } : tab)) }))
    }
  },

  applyExternalContent: (path, content) => {
    // Typing since the file was read wins; the next save is the user's call.
    if (!hasDoc(path) || isDirty(path)) return
    applyExternal(path, content)
  },

  saveActive: async () => {
    const { activePath, tabs } = get()
    const tab = tabs.find((item) => item.path === activePath)
    if (tab) await save(tab)
  },

  saveAll: async () => {
    for (const tab of get().tabs) await save(tab)
  },

  setCursor: (line, column) => {
    const { cursor } = get()
    if (cursor.line !== line || cursor.column !== column) set({ cursor: { line, column } })
  },

  consumeRevealLine: () => set({ revealLine: null }),
}))

async function save(tab: Tab): Promise<void> {
  if (!isDirty(tab.path)) return
  const snapshot = snapshotForSave(tab.path)
  if (!snapshot) return
  try {
    await api.workspace.write(tab.path, snapshot.text)
    markSaved(tab.path, snapshot)
    // Typing may have gone on while the file was written.
    useEditor.getState().setDirty(tab.path, isDirty(tab.path))
    useUi.getState().notify('success', `Saved ${tab.name}`)
  } catch (error) {
    useUi.getState().notify('error', `Save failed: ${(error as Error).message}`)
  }
}
