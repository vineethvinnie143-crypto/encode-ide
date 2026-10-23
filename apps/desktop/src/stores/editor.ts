import { create } from '../store'
import { api } from '../api'
import { applyExternal, closeDoc, closeDocsUnder, docState, hasDoc, isDirty, markSaved, matchesSaved, openDoc, renameDocs, snapshotForSave } from '../editor/docs'
import { useUi } from './ui'
import { errorText } from '../ipc-error'
import type { CodeRange } from '@shared/types'

export interface Tab {
  path: string
  name: string
  /** The id of the file's language, as the footer and the status bar show it. */
  language: string
  /** Unsaved changes. The text itself lives in `editor/docs`, not in this store. */
  dirty: boolean
}

/** What the status bar shows about the active document besides the cursor. */
export interface DocInfo {
  indent: string
  eol: 'LF' | 'CRLF'
}

interface EditorStore {
  tabs: Tab[]
  activePath: string | null
  cursor: { line: number; column: number }
  info: DocInfo
  revealLine: number | null
  /** A place to show and select, as the language servers count (zero-based lines and UTF-16 columns). */
  revealRange: CodeRange | null
  openFile(path: string, line?: number): Promise<void>
  /** Opens a file and selects `range` in it: where Go to definition lands. */
  openAt(path: string, range: CodeRange): Promise<void>
  closeTab(path: string): Promise<void>
  closeOthers(path: string): Promise<void>
  closeAll(): Promise<void>
  /** Asks before unsaved changes in any tab are thrown away; true when there are none or the user agrees. */
  confirmDiscardAll(): Promise<boolean>
  /** Closes every tab without asking, for when the project changes under them: their paths belong to the old one. */
  dropAll(): void
  closeTabsUnder(prefix: string): void
  /** A file or folder was renamed: its tabs follow it. */
  renamePath(from: string, to: string): void
  setActive(path: string): void
  /** The editor reports whether the document differs from the file. */
  setDirty(path: string, dirty: boolean): void
  /** The file changed on disk: an open document without unsaved changes takes the new text. */
  applyExternalContent(path: string, content: string): void
  saveActive(): Promise<void>
  saveAll(): Promise<void>
  setCursor(line: number, column: number): void
  setInfo(info: DocInfo): void
  consumeRevealLine(): void
  consumeRevealRange(): void
}

type Reveal = { revealLine: number | null; revealRange: CodeRange | null }

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
  info: { indent: 'Spaces: 2', eol: 'LF' },
  revealLine: null,
  revealRange: null,

  openFile: (path, line) => open(path, { revealLine: line ?? null, revealRange: null }),

  openAt: (path, range) => open(path, { revealLine: null, revealRange: range }),

  closeTab: async (path) => {
    const tab = get().tabs.find((item) => item.path === path)
    if (!tab) return
    if (!(await confirmDiscard(tab.dirty ? [tab] : []))) return
    closeDoc(path)
    set((state) => ({
      tabs: state.tabs.filter((item) => item.path !== path),
      activePath: state.activePath === path ? neighbour(state.tabs, path) : state.activePath,
      revealLine: null,
      revealRange: null,
    }))
  },

  closeOthers: async (path) => {
    const keep = get().tabs.find((tab) => tab.path === path)
    if (!keep) return
    const others = get().tabs.filter((tab) => tab.path !== path)
    if (!(await confirmDiscard(others.filter((tab) => tab.dirty)))) return
    for (const tab of others) closeDoc(tab.path)
    set({ tabs: [keep], activePath: keep.path, revealLine: null, revealRange: null })
  },

  closeAll: async () => {
    if (await get().confirmDiscardAll()) get().dropAll()
  },

  confirmDiscardAll: () => confirmDiscard(get().tabs.filter((tab) => tab.dirty)),

  dropAll: () => {
    for (const tab of get().tabs) closeDoc(tab.path)
    set({ tabs: [], activePath: null, revealLine: null, revealRange: null })
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

  renamePath: (from, to) => {
    renameDocs(from, to)
    const moved = (path: string) => (path === from ? to : path.startsWith(`${from}/`) ? to + path.slice(from.length) : path)
    set((state) => ({
      tabs: state.tabs.map((tab) => {
        const path = moved(tab.path)
        if (path === tab.path) return tab
        return { ...tab, path, name: nameOf(path), language: docState(path)?.config.language.id ?? tab.language }
      }),
      activePath: state.activePath === null ? null : moved(state.activePath),
    }))
  },

  setActive: (path) => set({ activePath: path, revealLine: null, revealRange: null }),

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

  setInfo: (info) => {
    const current = get().info
    if (current.indent !== info.indent || current.eol !== info.eol) set({ info })
  },

  consumeRevealLine: () => set({ revealLine: null }),
  consumeRevealRange: () => set({ revealRange: null }),
}))

/** Shows a file, opening it first when it is not open, and what in it to reveal. */
async function open(path: string, reveal: Reveal): Promise<void> {
  if (useEditor.getState().tabs.some((tab) => tab.path === path)) {
    useEditor.setState({ activePath: path, ...reveal })
    return
  }
  try {
    const file = await api.workspace.read(path)
    if (file.binary) {
      useUi.getState().notify('error', `${path} is a binary file and cannot be opened as text.`)
      return
    }
    const state = openDoc(path, file.content)
    useEditor.setState((current) => ({
      tabs: current.tabs.some((tab) => tab.path === path)
        ? current.tabs
        : [...current.tabs, { path, name: nameOf(path), language: state.config.language.id, dirty: false }],
      activePath: path,
      ...reveal,
    }))
  } catch (error) {
    useUi.getState().notify('error', errorText(error))
  }
}

/**
 * A file that someone else changed since eNCode read it (the agent, a formatter, git) is
 * not overwritten unasked. A file that is gone or cannot be read is written as before.
 * The check and the write are two steps, so a change in between still wins.
 */
async function confirmOverwrite(tab: Tab): Promise<boolean> {
  let content: string
  try {
    const file = await api.workspace.read(tab.path)
    if (!file.binary && matchesSaved(tab.path, file.content)) return true
    content = file.binary ? '' : file.content
  } catch {
    return true
  }
  return useUi.getState().askConfirm({
    title: `${tab.name} changed on disk`,
    body: content
      ? 'Saving replaces the version on disk with yours. Cancel keeps your changes unsaved, so you can copy them out or compare first.'
      : 'The file on disk is no longer text. Saving replaces it with yours.',
    confirmLabel: 'Overwrite',
    danger: true,
  })
}

async function save(tab: Tab): Promise<void> {
  if (!isDirty(tab.path)) return
  const snapshot = snapshotForSave(tab.path)
  if (!snapshot) return
  try {
    if (!(await confirmOverwrite(tab))) return
    await api.workspace.write(tab.path, snapshot.text)
    markSaved(tab.path, snapshot)
    // Typing may have gone on while the file was written.
    useEditor.getState().setDirty(tab.path, isDirty(tab.path))
    useUi.getState().notify('success', `Saved ${tab.name}`)
  } catch (error) {
    useUi.getState().notify('error', `Save failed: ${errorText(error)}`)
  }
}
