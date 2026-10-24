import { create } from '../store'
import {
  activateBottom,
  activateSide,
  activateSideAt,
  closeBottom,
  closeSide,
  cycleLayout,
  defaultPanels,
  normalizePanels,
  openBottom,
  openSide,
  reopenSide,
  savedPanels,
  setLayout,
  showAgentSide,
  stepSide,
  toggleBottom,
  toggleFull,
  toggleHidden,
  visitSide,
  type PanelLayout,
  type PanelTabKind,
  type PanelsState,
} from '../panels/model'
import { useUi, type SidebarView } from './ui'

const KEY = 'eNCode.panels.v1'
const RECENT_KEY = 'eNCode.recentPages.v1'
const MAX_RECENT = 8

function load(): PanelsState {
  try {
    return normalizePanels(JSON.parse(localStorage.getItem(KEY) ?? 'null'))
  } catch {
    return defaultPanels()
  }
}

function loadRecent(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as unknown
    return Array.isArray(raw) ? raw.filter((url): url is string => typeof url === 'string').slice(0, MAX_RECENT) : []
  } catch {
    return []
  }
}

function save(state: PanelsState): void {
  try {
    const saved = savedPanels(state)
    localStorage.setItem(KEY, JSON.stringify({ side: { ...saved.side, closed: undefined }, bottom: saved.bottom }))
  } catch {
    /* storage may be unavailable */
  }
}

interface PanelsStore extends PanelsState {
  /** Pages you opened in a Browser tab, newest first, for the New tab page. */
  recentPages: string[]
  /** Opens an address in a Browser tab: the New tab page in front becomes one, else a new tab. */
  openPage(url: string): void
  /** A Browser tab went to an address: it keeps it, takes the site's name, and the page joins the recent ones. */
  visit(id: string, url: string, title: string): void
  /** Shows a chat's agent tab, opening it if it is not open. */
  showAgent(key: string): void
  /** Closes a chat's agent tab. */
  closeAgent(key: string): void
  /** Shows a tab of this kind in the side panel; for Files, which view (Explorer, Search or Source control) to show. */
  open(kind: PanelTabKind, options?: { view?: SidebarView }): void
  close(id: string): void
  reopen(): void
  activate(id: string): void
  activateAt(index: number): void
  step(direction: 1 | -1): void
  setLayout(layout: PanelLayout): void
  cycleLayout(): void
  toggleHidden(): void
  toggleFull(): void
  openBottom(kind: PanelTabKind): void
  toggleBottom(): void
  activateBottom(id: string): void
  closeBottom(id: string): void
  rememberPage(url: string): void
}

const newId = () => crypto.randomUUID()

/** The site of an address, for a tab's title. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

export const usePanels = create<PanelsStore>((set, get) => {
  const apply = (next: PanelsState) => {
    set(next)
    save(next)
  }
  const snapshot = (): PanelsState => ({ side: get().side, bottom: get().bottom })
  /** Sets the layout; a panel that comes back with no tab left gets a New tab page to choose from. */
  const showLayout = (layout: PanelLayout) => {
    const next = setLayout(snapshot(), layout)
    apply(layout !== 'hidden' && next.side.tabs.length === 0 ? openSide(next, 'new', newId()) : next)
  }

  return {
    ...load(),
    recentPages: loadRecent(),

    openPage: (url) => {
      const opened = openSide(snapshot(), 'browser', newId())
      const id = opened.side.activeId
      apply(id ? visitSide(opened, id, url, hostOf(url)) : opened)
      get().rememberPage(url)
    },
    visit: (id, url, title) => {
      apply(visitSide(snapshot(), id, url, title))
      // The agent's pages are not the person's recent pages.
      if (!get().side.tabs.find((tab) => tab.id === id)?.agent) get().rememberPage(url)
    },

    showAgent: (key) => apply(showAgentSide(snapshot(), key, newId())),
    closeAgent: (key) => {
      const tab = get().side.tabs.find((candidate) => candidate.agent === key)
      if (tab) apply(closeSide(snapshot(), tab.id))
    },

    open: (kind, options) => {
      if (kind === 'files' && options?.view) useUi.getState().setSidebarView(options.view)
      apply(openSide(snapshot(), kind, newId()))
    },
    close: (id) => apply(closeSide(snapshot(), id)),
    reopen: () => apply(reopenSide(snapshot(), newId())),
    activate: (id) => apply(activateSide(snapshot(), id)),
    activateAt: (index) => apply(activateSideAt(snapshot(), index)),
    step: (direction) => apply(stepSide(snapshot(), direction)),
    setLayout: (layout) => showLayout(layout),
    cycleLayout: () => showLayout(cycleLayout(get().side.layout)),
    toggleHidden: () => showLayout(toggleHidden(get().side.layout)),
    toggleFull: () => showLayout(toggleFull(get().side.layout)),
    openBottom: (kind) => apply(openBottom(snapshot(), kind, newId())),
    toggleBottom: () => apply(toggleBottom(snapshot(), newId())),
    activateBottom: (id) => apply(activateBottom(snapshot(), id)),
    closeBottom: (id) => apply(closeBottom(snapshot(), id)),
    rememberPage: (url) => {
      const recentPages = [url, ...get().recentPages.filter((item) => item !== url)].slice(0, MAX_RECENT)
      set({ recentPages })
      try {
        localStorage.setItem(RECENT_KEY, JSON.stringify(recentPages))
      } catch {
        /* storage may be unavailable */
      }
    },
  }
})
