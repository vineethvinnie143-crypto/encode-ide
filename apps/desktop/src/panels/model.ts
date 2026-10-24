/**
 * The side panel and the bottom panel as data: which tabs are open, which is active, how the
 * side panel is laid out. Pure functions that return a new state, so the rules are unit tested;
 * stores/panels.ts keeps the state and saves it.
 */

export type PanelTabKind = 'new' | 'browser' | 'files' | 'editor' | 'review' | 'terminal' | 'trajectory' | 'jobs' | 'problems'
export type PanelLayout = 'split' | 'full' | 'hidden'

export interface PanelTab {
  id: string
  kind: PanelTabKind
  title: string
  /** The page a Browser tab shows, so it comes back after Reopen and after a restart. */
  url?: string
  /**
   * A chat's agent tab (ADR 0103): the key of its partition. It is the agent's while the window lives; it is not saved,
   * not reopened, and its page never moves to one of the person's tabs.
   */
  agent?: string
}

export interface Strip {
  tabs: PanelTab[]
  activeId: string | null
}

export interface PanelsState {
  side: Strip & { layout: PanelLayout; closed: PanelTab[] }
  bottom: Strip & { open: boolean }
}

export const SIDE_KINDS: readonly PanelTabKind[] = ['new', 'browser', 'files', 'editor', 'review', 'terminal', 'trajectory']
export const BOTTOM_KINDS: readonly PanelTabKind[] = ['terminal', 'jobs', 'problems']

/** Kinds that exist once: opening one again shows the one that is open. */
const SINGLE: readonly PanelTabKind[] = ['files', 'editor', 'review', 'trajectory', 'jobs', 'problems']

const TITLES: Record<PanelTabKind, string> = {
  new: 'New tab',
  browser: 'Browser',
  files: 'Files',
  editor: 'Editor',
  review: 'Review',
  terminal: 'Terminal',
  trajectory: 'Trajectory',
  jobs: 'Jobs',
  problems: 'Problems',
}

/** A web address a Browser tab can hold: http or https, not absurdly long. */
function isPageUrl(url: string): boolean {
  return url.length <= 2048 && /^https?:\/\//i.test(url)
}

export const MAX_CLOSED = 10
export const MAX_TABS = 20

/** The kind of the tab in front, or null when the strip has none. */
export function activeKind(strip: Strip): PanelTabKind | null {
  return strip.tabs.find((tab) => tab.id === strip.activeId)?.kind ?? null
}

export function defaultPanels(): PanelsState {
  return {
    side: { tabs: [{ id: 'files', kind: 'files', title: TITLES.files }], activeId: 'files', layout: 'split', closed: [] },
    bottom: { tabs: [], activeId: null, open: false },
  }
}

/** "Terminal", then "Terminal 2", "Terminal 3": the first number not in use. */
export function nextTitle(tabs: readonly PanelTab[], kind: PanelTabKind): string {
  const base = TITLES[kind]
  const used = new Set(tabs.filter((tab) => tab.kind === kind).map((tab) => tab.title))
  if (!used.has(base)) return base
  for (let n = 2; ; n++) if (!used.has(`${base} ${n}`)) return `${base} ${n}`
}

function neighbourAfterClose(tabs: readonly PanelTab[], closedIndex: number): string | null {
  const rest = tabs.filter((_, index) => index !== closedIndex)
  if (!rest.length) return null
  return rest[Math.min(closedIndex, rest.length - 1)].id
}

/** Adds a tab, or focuses the one that is already open for a kind that exists once. */
function openIn(strip: Strip, kind: PanelTabKind, id: string): Strip {
  if (SINGLE.includes(kind)) {
    const existing = strip.tabs.find((tab) => tab.kind === kind)
    if (existing) return { ...strip, activeId: existing.id }
  }
  if (strip.tabs.length >= MAX_TABS) return strip
  // Choosing something on a New tab page turns that page into the chosen tab.
  const active = strip.tabs.find((tab) => tab.id === strip.activeId)
  if (kind !== 'new' && active?.kind === 'new') {
    const tab: PanelTab = { id: active.id, kind, title: nextTitle(strip.tabs, kind) }
    return { tabs: strip.tabs.map((item) => (item.id === active.id ? tab : item)), activeId: tab.id }
  }
  const tab: PanelTab = { id, kind, title: nextTitle(strip.tabs, kind) }
  return { tabs: [...strip.tabs, tab], activeId: tab.id }
}

export function openSide(state: PanelsState, kind: PanelTabKind, id: string): PanelsState {
  if (!SIDE_KINDS.includes(kind)) return state
  const side = openIn(state.side, kind, id)
  return { ...state, side: { ...state.side, ...side, layout: state.side.layout === 'hidden' ? 'split' : state.side.layout } }
}

export function activateSide(state: PanelsState, id: string): PanelsState {
  return state.side.tabs.some((tab) => tab.id === id) ? { ...state, side: { ...state.side, activeId: id } } : state
}

/** Tab number `index` (from 0); a number beyond the last does nothing. */
export function activateSideAt(state: PanelsState, index: number): PanelsState {
  const tab = state.side.tabs[index]
  return tab ? activateSide(state, tab.id) : state
}

/** The next or previous tab, wrapping around. */
export function stepSide(state: PanelsState, direction: 1 | -1): PanelsState {
  const { tabs, activeId } = state.side
  if (tabs.length < 2) return state
  const index = tabs.findIndex((tab) => tab.id === activeId)
  const next = tabs[(index + direction + tabs.length) % tabs.length]
  return { ...state, side: { ...state.side, activeId: next.id } }
}

/** A Browser tab went to a page: it keeps the address and takes the site's name as its title. */
export function visitSide(state: PanelsState, id: string, url: string, title: string): PanelsState {
  if (!isPageUrl(url)) return state
  const clean = title.trim().slice(0, 60)
  const tabs = state.side.tabs.map((tab) => (tab.id === id && tab.kind === 'browser' ? { ...tab, url, title: clean || tab.title } : tab))
  return { ...state, side: { ...state.side, tabs } }
}

/**
 * Shows a chat's agent tab: the one open for `key`, or a new one beside the others (never in place of a New tab page,
 * which is the person's). The panel comes back if it was hidden. A strip that is full stays as it is.
 */
export function showAgentSide(state: PanelsState, key: string, id: string): PanelsState {
  const existing = state.side.tabs.find((tab) => tab.agent === key)
  const layout = state.side.layout === 'hidden' ? 'split' : state.side.layout
  if (existing) return { ...state, side: { ...state.side, activeId: existing.id, layout } }
  if (state.side.tabs.length >= MAX_TABS) return state
  const tab: PanelTab = { id, kind: 'browser', title: 'Agent', agent: key }
  return { ...state, side: { ...state.side, tabs: [...state.side.tabs, tab], activeId: id, layout } }
}

/** The tabs as they are saved: without the agent tabs, which belong to this run of the window. */
export function savedPanels(state: PanelsState): PanelsState {
  const keep = (tabs: PanelTab[]) => tabs.filter((tab) => !tab.agent)
  const tabs = keep(state.side.tabs)
  const activeId = tabs.some((tab) => tab.id === state.side.activeId) ? state.side.activeId : (tabs[0]?.id ?? null)
  return { ...state, side: { ...state.side, tabs, activeId, closed: keep(state.side.closed) } }
}

/** Closes a tab and remembers it for Reopen. Closing the last tab hides the panel. */
export function closeSide(state: PanelsState, id: string): PanelsState {
  const index = state.side.tabs.findIndex((tab) => tab.id === id)
  if (index < 0) return state
  const closed = state.side.tabs[index]
  const tabs = state.side.tabs.filter((tab) => tab.id !== id)
  const activeId = state.side.activeId === id ? neighbourAfterClose(state.side.tabs, index) : state.side.activeId
  // A New tab page is not worth reopening, and an agent tab is the agent's.
  const remembered = closed.kind === 'new' || closed.agent ? state.side.closed : [closed, ...state.side.closed].slice(0, MAX_CLOSED)
  return {
    ...state,
    side: { ...state.side, tabs, activeId, closed: remembered, layout: tabs.length ? state.side.layout : 'hidden' },
  }
}

/** Brings back the tab closed last. */
export function reopenSide(state: PanelsState, id: string): PanelsState {
  const [last, ...closed] = state.side.closed
  if (!last) return state
  // A tab that exists once may already be open again; then it is only focused.
  const opened = openSide({ ...state, side: { ...state.side, closed } }, last.kind, id)
  // A Browser tab comes back on its page.
  return last.kind === 'browser' && last.url && opened.side.activeId ? visitSide(opened, opened.side.activeId, last.url, last.title) : opened
}

export function setLayout(state: PanelsState, layout: PanelLayout): PanelsState {
  return { ...state, side: { ...state.side, layout } }
}

/** Split, then full width, then hidden. */
export function cycleLayout(layout: PanelLayout): PanelLayout {
  return layout === 'split' ? 'full' : layout === 'full' ? 'hidden' : 'split'
}

/** Ctrl+Alt+B: hide the panel, or bring it back. */
export function toggleHidden(layout: PanelLayout): PanelLayout {
  return layout === 'hidden' ? 'split' : 'hidden'
}

/** Ctrl+Alt+F: full width, or back to split. From hidden it opens full. */
export function toggleFull(layout: PanelLayout): PanelLayout {
  return layout === 'full' ? 'split' : 'full'
}

/** Shows the bottom panel with a tab of this kind in front: the one in front already, else the first, else a new one. */
export function openBottom(state: PanelsState, kind: PanelTabKind, id: string): PanelsState {
  if (!BOTTOM_KINDS.includes(kind)) return state
  const active = state.bottom.tabs.find((tab) => tab.id === state.bottom.activeId)
  const existing = active?.kind === kind ? active : state.bottom.tabs.find((tab) => tab.kind === kind)
  if (existing) return { ...state, bottom: { ...state.bottom, open: true, activeId: existing.id } }
  const strip = openIn(state.bottom, kind, id)
  return { ...state, bottom: { ...state.bottom, ...strip, open: true } }
}

/** Ctrl+J: shows the bottom panel (with a terminal if it has none), or hides it. */
export function toggleBottom(state: PanelsState, id: string): PanelsState {
  if (state.bottom.open) return { ...state, bottom: { ...state.bottom, open: false } }
  return state.bottom.tabs.length ? { ...state, bottom: { ...state.bottom, open: true } } : openBottom(state, 'terminal', id)
}

export function activateBottom(state: PanelsState, id: string): PanelsState {
  return state.bottom.tabs.some((tab) => tab.id === id) ? { ...state, bottom: { ...state.bottom, activeId: id } } : state
}

/** Closes a bottom tab; closing the last one hides the panel. */
export function closeBottom(state: PanelsState, id: string): PanelsState {
  const index = state.bottom.tabs.findIndex((tab) => tab.id === id)
  if (index < 0) return state
  const tabs = state.bottom.tabs.filter((tab) => tab.id !== id)
  const activeId = state.bottom.activeId === id ? neighbourAfterClose(state.bottom.tabs, index) : state.bottom.activeId
  return { ...state, bottom: { tabs, activeId, open: tabs.length > 0 && state.bottom.open } }
}

function cleanStrip(raw: unknown, allowed: readonly PanelTabKind[]): Strip {
  const input = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const seen = new Set<string>()
  const tabs: PanelTab[] = []
  for (const item of Array.isArray(input.tabs) ? input.tabs : []) {
    if (!item || typeof item !== 'object') continue
    const tab = item as Record<string, unknown>
    if (typeof tab.id !== 'string' || !tab.id || seen.has(tab.id)) continue
    if (!allowed.includes(tab.kind as PanelTabKind)) continue
    if (SINGLE.includes(tab.kind as PanelTabKind) && tabs.some((other) => other.kind === tab.kind)) continue
    seen.add(tab.id)
    const clean: PanelTab = {
      id: tab.id,
      kind: tab.kind as PanelTabKind,
      title: typeof tab.title === 'string' && tab.title.trim() ? tab.title.slice(0, 60) : TITLES[tab.kind as PanelTabKind],
    }
    if (clean.kind === 'browser' && typeof tab.url === 'string' && isPageUrl(tab.url)) clean.url = tab.url
    tabs.push(clean)
    if (tabs.length >= MAX_TABS) break
  }
  const activeId = typeof input.activeId === 'string' && tabs.some((tab) => tab.id === input.activeId) ? input.activeId : (tabs[0]?.id ?? null)
  return { tabs, activeId }
}

/** A valid state from whatever was saved: unknown tab kinds, repeats and a missing active tab are repaired. */
export function normalizePanels(raw: unknown): PanelsState {
  const input = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const side = cleanStrip(input.side, SIDE_KINDS)
  const bottom = cleanStrip(input.bottom, BOTTOM_KINDS)
  const sideRaw = (input.side && typeof input.side === 'object' ? input.side : {}) as Record<string, unknown>
  const bottomRaw = (input.bottom && typeof input.bottom === 'object' ? input.bottom : {}) as Record<string, unknown>
  const layout: PanelLayout = sideRaw.layout === 'full' || sideRaw.layout === 'hidden' ? sideRaw.layout : 'split'
  if (!side.tabs.length && !input.side) return defaultPanels()
  return {
    side: { ...side, layout: side.tabs.length ? layout : 'hidden', closed: [] },
    bottom: { ...bottom, open: bottomRaw.open === true && bottom.tabs.length > 0 },
  }
}
