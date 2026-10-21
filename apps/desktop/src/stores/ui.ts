import { create } from '../store'

export type SidebarView = 'explorer' | 'search' | 'git'
export type RightPanel = 'browse' | 'workspace'
export type WorkspaceTab = 'files' | 'editor' | 'shell'
export type MainView = 'chat' | 'trajectory'
export type SettingsTab = 'models' | 'agent' | 'appearance'
/** What the session sidebar lists: projects and their sessions, sessions by state, or archived ones. */
export type SidebarMode = 'projects' | 'activity' | 'archived'

export interface PromptRequest {
  id: number
  title: string
  placeholder: string
  value: string
  resolve: (value: string | null) => void
}

export interface ConfirmRequest {
  id: number
  title: string
  body: string
  confirmLabel: string
  /** Styles the confirm button as destructive. */
  danger: boolean
  resolve: (confirmed: boolean) => void
}

export interface Toast {
  id: number
  kind: 'info' | 'success' | 'error'
  text: string
}

interface UiStore {
  /** The files pane's view in the side panel. */
  sidebarView: SidebarView
  /** The session sidebar, which Ctrl+B shows and hides. */
  sidebarVisible: boolean
  sidebarMode: SidebarMode
  collapsedProjects: string[]
  panelVisible: boolean
  rightVisible: boolean
  rightPanel: RightPanel
  workspaceTab: WorkspaceTab
  mainView: MainView
  settingsOpen: boolean
  settingsTab: SettingsTab
  pluginsOpen: boolean
  automationOpen: boolean
  quickOpenOpen: boolean
  shortcutsOpen: boolean
  aboutOpen: boolean
  prompt: PromptRequest | null
  confirm: ConfirmRequest | null
  toast: Toast | null
  setSidebarView(view: SidebarView): void
  toggleSidebar(): void
  setSidebarMode(mode: SidebarMode): void
  /** Folds or unfolds a project in the sidebar; `key` is rootKey(folder). */
  toggleProject(key: string): void
  togglePanel(): void
  toggleRight(): void
  setRightVisible(visible: boolean): void
  setRightPanel(panel: RightPanel): void
  setWorkspaceTab(tab: WorkspaceTab): void
  setMainView(view: MainView): void
  setSettingsOpen(open: boolean): void
  openSettings(tab: SettingsTab): void
  setPluginsOpen(open: boolean): void
  setAutomationOpen(open: boolean): void
  setQuickOpenOpen(open: boolean): void
  setShortcutsOpen(open: boolean): void
  setAboutOpen(open: boolean): void
  askText(title: string, placeholder?: string, value?: string): Promise<string | null>
  resolvePrompt(value: string | null): void
  askConfirm(options: { title: string; body: string; confirmLabel?: string; danger?: boolean }): Promise<boolean>
  resolveConfirm(confirmed: boolean): void
  notify(kind: Toast['kind'], text: string): void
  dismissToast(): void
}

let promptCounter = 0

/** Which panels were open, kept between runs. */
const LAYOUT_KEY = 'eNCode.layout.v1'

interface Layout {
  sidebarVisible: boolean
  rightVisible: boolean
  /** Projects folded in the sidebar, as folder keys (see rootKey). */
  collapsedProjects: string[]
}

function savedLayout(): Layout {
  try {
    const raw = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? '{}') as Record<string, unknown>
    return {
      sidebarVisible: raw.sidebarVisible !== false,
      rightVisible: raw.rightVisible !== false,
      collapsedProjects: Array.isArray(raw.collapsedProjects) ? raw.collapsedProjects.filter((key): key is string => typeof key === 'string') : [],
    }
  } catch {
    return { sidebarVisible: true, rightVisible: true, collapsedProjects: [] }
  }
}

function saveLayout(layout: Layout): void {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout))
  } catch {
    /* storage may be unavailable */
  }
}

function layoutOf(state: Layout): Layout {
  return { sidebarVisible: state.sidebarVisible, rightVisible: state.rightVisible, collapsedProjects: state.collapsedProjects }
}

export const useUi = create<UiStore>((set, get) => ({
  sidebarView: 'explorer',
  ...savedLayout(),
  sidebarMode: 'projects',
  panelVisible: false,
  rightPanel: 'browse',
  workspaceTab: 'files',
  mainView: 'chat',
  settingsOpen: false,
  settingsTab: 'models',
  pluginsOpen: false,
  automationOpen: false,
  quickOpenOpen: false,
  shortcutsOpen: false,
  aboutOpen: false,
  prompt: null,
  confirm: null,
  toast: null,

  setSidebarView: (view) => set({ sidebarView: view }),
  toggleSidebar: () => {
    set((state) => ({ sidebarVisible: !state.sidebarVisible }))
    saveLayout(layoutOf(get()))
  },
  setSidebarMode: (mode) => set({ sidebarMode: mode, sidebarVisible: true }),
  toggleProject: (key) => {
    const folded = get().collapsedProjects
    set({ collapsedProjects: folded.includes(key) ? folded.filter((item) => item !== key) : [...folded, key] })
    saveLayout(layoutOf(get()))
  },
  togglePanel: () => set((state) => ({ panelVisible: !state.panelVisible })),
  toggleRight: () => {
    set((state) => ({ rightVisible: !state.rightVisible }))
    saveLayout(layoutOf(get()))
  },
  setRightVisible: (visible) => {
    set({ rightVisible: visible })
    saveLayout({ ...layoutOf(get()), rightVisible: visible })
  },
  setRightPanel: (panel) => set({ rightPanel: panel, rightVisible: true }),
  setWorkspaceTab: (tab) => set({ workspaceTab: tab, rightPanel: 'workspace', rightVisible: true }),
  setMainView: (view) => set({ mainView: view }),
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  openSettings: (tab) => set({ settingsTab: tab, settingsOpen: true }),
  setPluginsOpen: (open) => set({ pluginsOpen: open }),
  setAutomationOpen: (open) => set({ automationOpen: open }),
  setQuickOpenOpen: (open) => set({ quickOpenOpen: open }),
  setShortcutsOpen: (open) => set({ shortcutsOpen: open }),
  setAboutOpen: (open) => set({ aboutOpen: open }),

  askText: (title, placeholder = '', value = '') =>
    new Promise<string | null>((resolve) => {
      set({ prompt: { id: ++promptCounter, title, placeholder, value, resolve } })
    }),

  resolvePrompt: (value) => {
    const prompt = get().prompt
    if (!prompt) return
    prompt.resolve(value)
    set({ prompt: null })
  },

  askConfirm: ({ title, body, confirmLabel = 'Confirm', danger = false }) =>
    new Promise<boolean>((resolve) => {
      get().confirm?.resolve(false)
      set({ confirm: { id: ++promptCounter, title, body, confirmLabel, danger, resolve } })
    }),

  resolveConfirm: (confirmed) => {
    const confirm = get().confirm
    if (!confirm) return
    confirm.resolve(confirmed)
    set({ confirm: null })
  },

  // Toasts.tsx closes it after 5 s, pausing while the pointer is on it.
  notify: (kind, text) => set({ toast: { id: Date.now() + Math.random(), kind, text } }),

  dismissToast: () => set({ toast: null }),
}))
