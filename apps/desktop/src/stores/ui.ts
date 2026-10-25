import type { KeyedSearchProviderId } from '@shared/search'
import { create } from '../store'

export type SidebarView = 'explorer' | 'search' | 'git'
/** The sections of the Settings page; see components/settings/sections.ts. */
export type SettingsSection =
  | 'general'
  | 'personalization'
  | 'notifications'
  | 'appearance'
  | 'editor'
  | 'shortcuts'
  | 'models'
  | 'roles'
  | 'usage'
  | 'agent'
  | 'computer'
  | 'skills'
  | 'permissions'
  | 'mcp'
  | 'sandbox'
  | 'code'
  | 'archived'
/** What the session sidebar lists: projects and their sessions, sessions by state, or archived ones. */
export type SidebarMode = 'projects' | 'activity' | 'archived'

/** One request of a session, by the message that started it. */
export interface TurnReportTarget {
  sessionId: string
  turn: string
  text: string
}

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
export type ComposerMenu = 'model' | 'policy' | 'effort'

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
  /** The Settings page covers the sessions and the work area (they stay mounted under it). */
  settingsOpen: boolean
  settingsSection: SettingsSection
  /**
   * Where the page puts the focus, asked for each time something opens it: a setting chosen from its search (scrolled
   * to and marked), or with `setting` null the section's own start. `id` grows with each request.
   */
  settingsFocus: { setting: string | null; id: number } | null
  /** The "Connect a model" dialog, opened from the model menu; a first start opens it by itself. */
  connectOpen: boolean
  automationOpen: boolean
  quickOpenOpen: boolean
  /** What Go to file starts with: '@' for the file's symbols, '#' for the folder's, ':' for a line. */
  quickOpenQuery: string
  /** Grows with each request to open it, so a request while it is open starts it again. */
  quickOpenId: number
  /** The command palette (Ctrl+K). */
  paletteOpen: boolean
  aboutOpen: boolean
  /** The file a report of an editor issue is being made of (Help, Report editor issue), or null. */
  editorIssueFor: string | null
  /** The request a report is being made of (Report a problem with this request), or null. */
  turnReportFor: TurnReportTarget | null
  /**
   * A search provider whose key Settings > Agent > Web search is asked to take: that screen chooses it there, with its
   * key field ready, and takes the request away (ADR 0123).
   */
  searchKeyFor: KeyedSearchProviderId | null
  /** "Not now" on the offer of a free search key: it stays away until eNCode starts again. */
  searchOfferDismissed: boolean
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
  /** Opens the Settings page on a section, and on one of its settings when `setting` names one. */
  openSettings(section: SettingsSection, setting?: string): void
  /** Another section of the open page, from its list of sections. */
  setSettingsSection(section: SettingsSection): void
  /** Opens Settings on web search with that provider chosen and its key field ready. */
  addSearchKey(provider: KeyedSearchProviderId): void
  dismissSearchOffer(): void
  setConnectOpen(open: boolean): void
  setAutomationOpen(open: boolean): void
  setQuickOpenOpen(open: boolean, query?: string): void
  setPaletteOpen(open: boolean): void
  setAboutOpen(open: boolean): void
  setEditorIssueFor(path: string | null): void
  setTurnReportFor(target: TurnReportTarget | null): void
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
  settingsSection: 'general',
  settingsFocus: null,
  connectOpen: false,
  automationOpen: false,
  quickOpenOpen: false,
  quickOpenQuery: '',
  quickOpenId: 0,
  paletteOpen: false,
  aboutOpen: false,
  editorIssueFor: null,
  turnReportFor: null,
  searchKeyFor: null,
  searchOfferDismissed: false,
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
  setSettingsOpen: (open) =>
    set((state) => (open ? { settingsOpen: true, settingsFocus: { setting: null, id: (state.settingsFocus?.id ?? 0) + 1 } } : { settingsOpen: false })),
  openSettings: (section, setting) =>
    set((state) => ({ settingsSection: section, settingsOpen: true, settingsFocus: { setting: setting ?? null, id: (state.settingsFocus?.id ?? 0) + 1 } })),
  setSettingsSection: (section) => set({ settingsSection: section }),
  addSearchKey: (provider) => {
    set({ searchKeyFor: provider })
    get().openSettings('agent', 'agent.search')
  },
  dismissSearchOffer: () => set({ searchOfferDismissed: true }),
  setConnectOpen: (open) => set({ connectOpen: open }),
  setAutomationOpen: (open) => set({ automationOpen: open }),
  setQuickOpenOpen: (open, query = '') =>
    set((state) => (open ? { quickOpenOpen: true, quickOpenQuery: query, quickOpenId: state.quickOpenId + 1 } : { quickOpenOpen: false })),
  setPaletteOpen: (open) => set({ paletteOpen: open }),
  setAboutOpen: (open) => set({ aboutOpen: open }),
  setEditorIssueFor: (path) => set({ editorIssueFor: path }),
  setTurnReportFor: (target) => set({ turnReportFor: target }),
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
