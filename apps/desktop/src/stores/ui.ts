import { create } from '../store'

export type SidebarView = 'explorer' | 'search' | 'git'
export type SettingsTab = 'models' | 'roles' | 'agent' | 'permissions' | 'mcp' | 'sandbox' | 'appearance'
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

/** A menu in the message box that a shortcut or the palette asks to open: the model list or the permissions. */
export type ComposerMenu = 'model' | 'policy'

export interface ToastAction {
  label: string
  run: () => void
}

export interface Toast {
  id: number
  kind: 'info' | 'success' | 'error'
  text: string
  /** A button on the notice, such as "Open Settings". */
  action?: ToastAction
}

interface UiStore {
  /** The files pane's view in the side panel. */
  sidebarView: SidebarView
  /** The session sidebar, which Ctrl+B shows and hides. */
  sidebarVisible: boolean
  sidebarMode: SidebarMode
  collapsedProjects: string[]
  settingsOpen: boolean
  settingsTab: SettingsTab
  /** The "Connect a model" dialog, opened from the model menu; a first start opens it by itself. */
  connectOpen: boolean
  pluginsOpen: boolean
  automationOpen: boolean
  quickOpenOpen: boolean
  /** The command palette (Ctrl+K). */
  paletteOpen: boolean
  shortcutsOpen: boolean
  aboutOpen: boolean
  /** The session's status: model, permissions, context and tokens (/status). */
  statusOpen: boolean
  /** The latest request to open a menu of the message box; `id` grows with each request. */
  menuRequest: { menu: ComposerMenu; id: number } | null
  /** Esc was pressed once while the agent works: a second press stops it. */
  stopArmed: boolean
  prompt: PromptRequest | null
  confirm: ConfirmRequest | null
  toast: Toast | null
  setSidebarView(view: SidebarView): void
  toggleSidebar(): void
  setSidebarMode(mode: SidebarMode): void
  /** Folds or unfolds a project in the sidebar; `key` is rootKey(folder). */
  toggleProject(key: string): void
  setSettingsOpen(open: boolean): void
  openSettings(tab: SettingsTab): void
  setConnectOpen(open: boolean): void
  setPluginsOpen(open: boolean): void
  setAutomationOpen(open: boolean): void
  setQuickOpenOpen(open: boolean): void
  setPaletteOpen(open: boolean): void
  setShortcutsOpen(open: boolean): void
  setAboutOpen(open: boolean): void
  setStatusOpen(open: boolean): void
  requestMenu(menu: ComposerMenu): void
  setStopArmed(armed: boolean): void
  askText(title: string, placeholder?: string, value?: string): Promise<string | null>
  resolvePrompt(value: string | null): void
  askConfirm(options: { title: string; body: string; confirmLabel?: string; danger?: boolean }): Promise<boolean>
  resolveConfirm(confirmed: boolean): void
  notify(kind: Toast['kind'], text: string, action?: ToastAction): void
  dismissToast(): void
}

let promptCounter = 0

/** Which panels were open, kept between runs. */
const LAYOUT_KEY = 'eNCode.layout.v1'

interface Layout {
  sidebarVisible: boolean
  /** Projects folded in the sidebar, as folder keys (see rootKey). */
  collapsedProjects: string[]
}

function savedLayout(): Layout {
  try {
    const raw = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? '{}') as Record<string, unknown>
    return {
      sidebarVisible: raw.sidebarVisible !== false,
      collapsedProjects: Array.isArray(raw.collapsedProjects) ? raw.collapsedProjects.filter((key): key is string => typeof key === 'string') : [],
    }
  } catch {
    return { sidebarVisible: true, collapsedProjects: [] }
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
  return { sidebarVisible: state.sidebarVisible, collapsedProjects: state.collapsedProjects }
}

export const useUi = create<UiStore>((set, get) => ({
  sidebarView: 'explorer',
  ...savedLayout(),
  sidebarMode: 'projects',
  settingsOpen: false,
  settingsTab: 'models',
  connectOpen: false,
  pluginsOpen: false,
  automationOpen: false,
  quickOpenOpen: false,
  paletteOpen: false,
  shortcutsOpen: false,
  aboutOpen: false,
  statusOpen: false,
  menuRequest: null,
  stopArmed: false,
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
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  openSettings: (tab) => set({ settingsTab: tab, settingsOpen: true }),
  setConnectOpen: (open) => set({ connectOpen: open }),
  setPluginsOpen: (open) => set({ pluginsOpen: open }),
  setAutomationOpen: (open) => set({ automationOpen: open }),
  setQuickOpenOpen: (open) => set({ quickOpenOpen: open }),
  setPaletteOpen: (open) => set({ paletteOpen: open }),
  setShortcutsOpen: (open) => set({ shortcutsOpen: open }),
  setAboutOpen: (open) => set({ aboutOpen: open }),
  setStatusOpen: (open) => set({ statusOpen: open }),
  requestMenu: (menu) => set((state) => ({ menuRequest: { menu, id: (state.menuRequest?.id ?? 0) + 1 } })),
  setStopArmed: (armed) => set({ stopArmed: armed }),

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
  notify: (kind, text, action) => set({ toast: { id: Date.now() + Math.random(), kind, text, ...(action ? { action } : {}) } }),

  dismissToast: () => set({ toast: null }),
}))
