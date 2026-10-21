import { create } from '../store'

export type SidebarView = 'explorer' | 'search' | 'git'
export type RightPanel = 'browse' | 'workspace'
export type WorkspaceTab = 'files' | 'editor' | 'shell'
export type MainView = 'chat' | 'trajectory'
export type SettingsTab = 'models' | 'agent' | 'appearance'

export interface PromptRequest {
  id: number
  title: string
  placeholder: string
  value: string
  resolve: (value: string | null) => void
}

export interface Toast {
  id: number
  kind: 'info' | 'success' | 'error'
  text: string
}

interface UiStore {
  sidebarView: SidebarView
  sidebarVisible: boolean
  chatVisible: boolean
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
  prompt: PromptRequest | null
  toast: Toast | null
  setSidebarView(view: SidebarView): void
  toggleSidebar(): void
  toggleChat(): void
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
  askText(title: string, placeholder?: string, value?: string): Promise<string | null>
  resolvePrompt(value: string | null): void
  notify(kind: Toast['kind'], text: string): void
  dismissToast(): void
}

let promptCounter = 0

export const useUi = create<UiStore>((set, get) => ({
  sidebarView: 'explorer',
  sidebarVisible: true,
  chatVisible: true,
  panelVisible: false,
  rightVisible: true,
  rightPanel: 'browse',
  workspaceTab: 'files',
  mainView: 'chat',
  settingsOpen: false,
  settingsTab: 'models',
  pluginsOpen: false,
  automationOpen: false,
  quickOpenOpen: false,
  prompt: null,
  toast: null,

  setSidebarView: (view) => set({ sidebarView: view, sidebarVisible: true }),
  toggleSidebar: () => set((state) => ({ sidebarVisible: !state.sidebarVisible })),
  toggleChat: () => set((state) => ({ chatVisible: !state.chatVisible })),
  togglePanel: () => set((state) => ({ panelVisible: !state.panelVisible })),
  toggleRight: () => set((state) => ({ rightVisible: !state.rightVisible })),
  setRightVisible: (visible) => set({ rightVisible: visible }),
  setRightPanel: (panel) => set({ rightPanel: panel, rightVisible: true }),
  setWorkspaceTab: (tab) => set({ workspaceTab: tab, rightPanel: 'workspace', rightVisible: true }),
  setMainView: (view) => set({ mainView: view }),
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  openSettings: (tab) => set({ settingsTab: tab, settingsOpen: true }),
  setPluginsOpen: (open) => set({ pluginsOpen: open }),
  setAutomationOpen: (open) => set({ automationOpen: open }),
  setQuickOpenOpen: (open) => set({ quickOpenOpen: open }),

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

  // Toasts.tsx closes it after 5 s, pausing while the pointer is on it.
  notify: (kind, text) => set({ toast: { id: Date.now() + Math.random(), kind, text } }),

  dismissToast: () => set({ toast: null }),
}))
