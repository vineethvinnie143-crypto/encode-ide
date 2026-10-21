import { create } from '../store'
import { api } from '../api'
import { useUi } from './ui'

const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  rb: 'ruby',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  ps1: 'powershell',
  bat: 'bat',
  cmd: 'bat',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  xml: 'xml',
  svg: 'xml',
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql',
  vue: 'html',
  svelte: 'html',
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  txt: 'plaintext',
}

export function languageFor(filePath: string): string {
  const name = filePath.split('/').pop()?.toLowerCase() ?? filePath
  if (name === 'dockerfile') return 'dockerfile'
  if (name === 'makefile') return 'makefile'
  const ext = name.includes('.') ? name.split('.').pop() ?? '' : ''
  return LANGUAGE_BY_EXT[ext] ?? 'plaintext'
}

export interface Tab {
  path: string
  name: string
  language: string
  content: string
  savedContent: string
  dirty: boolean
  /** Preserve the file's original line endings on save. */
  eol: '\n' | '\r\n'
}

interface EditorStore {
  tabs: Tab[]
  activePath: string | null
  cursor: { line: number; column: number }
  revealLine: number | null
  openFile(path: string, line?: number): Promise<void>
  closeTab(path: string): void
  closeOthers(path: string): void
  closeAll(): void
  closeTabsUnder(prefix: string): void
  setActive(path: string): void
  updateContent(path: string, content: string): void
  applyExternalContent(path: string, content: string): void
  saveActive(): Promise<void>
  saveAll(): Promise<void>
  setCursor(line: number, column: number): void
  consumeRevealLine(): void
}

export const useEditor = create<EditorStore>((set, get) => ({
  tabs: [],
  activePath: null,
  cursor: { line: 1, column: 1 },
  revealLine: null,

  openFile: async (path, line) => {
    const existing = get().tabs.find((tab) => tab.path === path)
    if (existing) {
      set({ activePath: path, revealLine: line ?? null })
      return
    }
    try {
      const file = await api.workspace.read(path)
      if (file.binary) {
        useUi.getState().notify('error', `${path} is a binary file and cannot be opened as text.`)
        return
      }
      const name = path.split('/').pop() ?? path
      const eol: '\n' | '\r\n' = file.content.includes('\r\n') ? '\r\n' : '\n'
      const content = eol === '\r\n' ? file.content.replace(/\r\n/g, '\n') : file.content
      const tab: Tab = {
        path,
        name,
        language: languageFor(path),
        content,
        savedContent: content,
        dirty: false,
        eol,
      }
      set((state) => ({ tabs: [...state.tabs, tab], activePath: path, revealLine: line ?? null }))
    } catch (error) {
      useUi.getState().notify('error', (error as Error).message)
    }
  },

  closeTab: (path) => {
    const tab = get().tabs.find((item) => item.path === path)
    if (!tab) return
    if (tab.dirty && !window.confirm(`Discard unsaved changes to ${tab.name}?`)) return
    set((state) => {
      const index = state.tabs.findIndex((item) => item.path === path)
      const tabs = state.tabs.filter((item) => item.path !== path)
      let activePath = state.activePath
      if (activePath === path) {
        activePath = tabs[Math.min(index, tabs.length - 1)]?.path ?? null
      }
      return { tabs, activePath, revealLine: null }
    })
  },

  closeOthers: (path) => {
    const keep = get().tabs.find((tab) => tab.path === path)
    if (!keep) return
    set({ tabs: [keep], activePath: keep.path })
  },

  closeAll: () => {
    const dirty = get().tabs.filter((tab) => tab.dirty)
    if (dirty.length && !window.confirm(`Discard unsaved changes in ${dirty.length} file(s)?`)) return
    set({ tabs: [], activePath: null, revealLine: null })
  },

  closeTabsUnder: (prefix) => {
    set((state) => {
      const tabs = state.tabs.filter(
        (tab) => tab.path !== prefix && !tab.path.startsWith(`${prefix}/`),
      )
      const activePath = tabs.some((tab) => tab.path === state.activePath)
        ? state.activePath
        : tabs[tabs.length - 1]?.path ?? null
      return { tabs, activePath }
    })
  },

  setActive: (path) => set({ activePath: path, revealLine: null }),

  updateContent: (path, content) => {
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.path === path ? { ...tab, content, dirty: content !== tab.savedContent } : tab,
      ),
    }))
  },

  applyExternalContent: (path, content) => {
    set((state) => ({
      tabs: state.tabs.map((tab) => {
        if (tab.path !== path) return tab
        const eol = content.includes('\r\n') ? '\r\n' : tab.eol
        const normalized = eol === '\r\n' ? content.replace(/\r\n/g, '\n') : content
        return { ...tab, content: normalized, savedContent: normalized, dirty: false, eol }
      }),
    }))
  },

  saveActive: async () => {
    const { activePath, tabs } = get()
    const tab = tabs.find((item) => item.path === activePath)
    if (!tab || !tab.dirty) return
    try {
      const data = tab.eol === '\r\n' ? tab.content.replace(/\n/g, '\r\n') : tab.content
      await api.workspace.write(tab.path, data)
      set((state) => ({
        tabs: state.tabs.map((item) =>
          item.path === tab.path ? { ...item, savedContent: item.content, dirty: false } : item,
        ),
      }))
      useUi.getState().notify('success', `Saved ${tab.name}`)
    } catch (error) {
      useUi.getState().notify('error', `Save failed: ${(error as Error).message}`)
    }
  },

  saveAll: async () => {
    for (const tab of get().tabs) {
      if (!tab.dirty) continue
      set((state) => ({ activePath: tab.path }))
      await get().saveActive()
    }
  },

  setCursor: (line, column) => set({ cursor: { line, column } }),

  consumeRevealLine: () => set({ revealLine: null }),
}))
