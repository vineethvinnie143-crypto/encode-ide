import { create } from '../store'
import type { OutlineSort } from '../editor/symbols'

const KEY = 'eNCode.editorLayout.v1'

/** How the editor pane is laid out around the text: the breadcrumbs above it, the outline beside it, what the text shows. */
export interface EditorLayout {
  breadcrumbs: boolean
  outline: boolean
  /** Blocks fold, with chevrons in the gutter. */
  folding: boolean
  /** The first lines of the blocks the top of the view is in stay pinned above the text. */
  stickyScroll: boolean
  /** Brackets are coloured by how deeply they nest. */
  bracketColors: boolean
  /** A small picture of the file beside the text. */
  minimap: boolean
  /** The language server's hints among the text: the types it worked out, the names of the parameters arguments go to. */
  inlayHints: boolean
  /** Names coloured as the language server knows them (a type, a parameter, a deprecated function), over the lexer's colours. */
  semanticHighlighting: boolean
  /** Long lines wrap onto rows below instead of running off to the right (Alt+Z). */
  wordWrap: boolean
  /** Where they wrap: at the window's edge, at `wrapColumn`, or at whichever of the two comes first. */
  wrapAt: WrapAt
  wrapColumn: number
  /** Rows after a line's first start as far in as the line does. */
  wrapIndent: boolean
  /** Every space and tab is shown (the View menu); otherwise those `whitespace` names. */
  showWhitespace: boolean
  whitespace: WhitespaceShown
  /** The outline's width in pixels, as the person dragged it. */
  outlineWidth: number
  outlineSort: OutlineSort
  /** The outline shows the symbol the cursor is in, opening the symbols it is under. */
  outlineFollow: boolean
  /** The editor works with a screen reader: when one is running (Auto), always, or never. */
  screenReader: ScreenReaderMode
  /** Tab and Shift+Tab move the focus out of the editor instead of indenting (Ctrl+M). */
  tabMovesFocus: boolean
  /** Right-to-left text in strings, comments and prose reads in its own order; code stays in stored order. */
  bidi: boolean
}

export type WrapAt = 'edge' | 'column' | 'bounded'
/** The spaces and tabs shown: none, those at a word's edge or in a run, those in the selection, those at a line's end, or all. */
export type WhitespaceShown = 'none' | 'boundary' | 'selection' | 'trailing' | 'all'
export type ScreenReaderMode = 'auto' | 'on' | 'off'

export const OUTLINE_MIN = 180
export const OUTLINE_MAX = 480
export const WRAP_COLUMN_MIN = 20
export const WRAP_COLUMN_MAX = 400
/** The parts of the editor a menu turns on and off. */
export type EditorPart =
  | 'breadcrumbs'
  | 'outline'
  | 'folding'
  | 'stickyScroll'
  | 'bracketColors'
  | 'minimap'
  | 'inlayHints'
  | 'semanticHighlighting'
  | 'wordWrap'
  | 'wrapIndent'
  | 'showWhitespace'
  | 'tabMovesFocus'

const WRAP_AT: readonly WrapAt[] = ['edge', 'column', 'bounded']
const WHITESPACE: readonly WhitespaceShown[] = ['none', 'boundary', 'selection', 'trailing', 'all']
const SCREEN_READER: readonly ScreenReaderMode[] = ['auto', 'on', 'off']

const DEFAULTS: EditorLayout = {
  breadcrumbs: true,
  outline: false,
  folding: true,
  stickyScroll: true,
  bracketColors: true,
  minimap: true,
  inlayHints: true,
  semanticHighlighting: true,
  wordWrap: false,
  wrapAt: 'edge',
  wrapColumn: 80,
  wrapIndent: true,
  showWhitespace: false,
  whitespace: 'selection',
  outlineWidth: 248,
  outlineSort: 'position',
  outlineFollow: true,
  screenReader: 'auto',
  tabMovesFocus: false,
  bidi: false,
}

/** A saved layout, each field checked; what is missing or wrong takes its default. */
export function normalizeLayout(value: unknown): EditorLayout {
  if (typeof value !== 'object' || value === null) return { ...DEFAULTS }
  const raw = value as Record<string, unknown>
  const width = typeof raw.outlineWidth === 'number' && Number.isFinite(raw.outlineWidth) ? Math.round(raw.outlineWidth) : DEFAULTS.outlineWidth
  const column = typeof raw.wrapColumn === 'number' && Number.isFinite(raw.wrapColumn) ? Math.round(raw.wrapColumn) : DEFAULTS.wrapColumn
  const flag = (name: EditorPart): boolean => (typeof raw[name] === 'boolean' ? (raw[name] as boolean) : DEFAULTS[name])
  const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(value as T) ? (value as T) : fallback)
  return {
    breadcrumbs: flag('breadcrumbs'),
    outline: flag('outline'),
    folding: flag('folding'),
    stickyScroll: flag('stickyScroll'),
    bracketColors: flag('bracketColors'),
    minimap: flag('minimap'),
    inlayHints: flag('inlayHints'),
    semanticHighlighting: flag('semanticHighlighting'),
    wordWrap: flag('wordWrap'),
    wrapAt: oneOf(raw.wrapAt, WRAP_AT, DEFAULTS.wrapAt),
    wrapColumn: clampWrapColumn(column),
    wrapIndent: flag('wrapIndent'),
    showWhitespace: flag('showWhitespace'),
    whitespace: oneOf(raw.whitespace, WHITESPACE, DEFAULTS.whitespace),
    outlineWidth: Math.min(OUTLINE_MAX, Math.max(OUTLINE_MIN, width)),
    outlineSort: raw.outlineSort === 'name' || raw.outlineSort === 'kind' || raw.outlineSort === 'position' ? raw.outlineSort : DEFAULTS.outlineSort,
    outlineFollow: typeof raw.outlineFollow === 'boolean' ? raw.outlineFollow : DEFAULTS.outlineFollow,
    screenReader: oneOf(raw.screenReader, SCREEN_READER, DEFAULTS.screenReader),
    tabMovesFocus: flag('tabMovesFocus'),
    bidi: typeof raw.bidi === 'boolean' ? raw.bidi : DEFAULTS.bidi,
  }
}

/** A wrap column within what the editor takes. */
export function clampWrapColumn(column: number): number {
  return Math.min(WRAP_COLUMN_MAX, Math.max(WRAP_COLUMN_MIN, Math.round(column)))
}

/** What the editor's view is given for wrapping, spaces and right-to-left text, from the layout. */
export function textOptions(layout: EditorLayout): {
  wordWrap: 'off' | 'on' | 'column' | 'bounded'
  wrapColumn: number
  wrapIndent: boolean
  renderWhitespace: WhitespaceShown
  bidi: boolean
} {
  return {
    wordWrap: !layout.wordWrap ? 'off' : layout.wrapAt === 'edge' ? 'on' : layout.wrapAt,
    wrapColumn: layout.wrapColumn,
    wrapIndent: layout.wrapIndent,
    renderWhitespace: layout.showWhitespace ? 'all' : layout.whitespace,
    bidi: layout.bidi,
  }
}

/** What the editor's view is given for screen readers and the Tab key, from the layout and whether a screen reader runs. */
export function accessOptions(layout: EditorLayout, screenReaderRunning: boolean): { screenReader: boolean; tabMovesFocus: boolean } {
  return {
    screenReader: layout.screenReader === 'on' || (layout.screenReader === 'auto' && screenReaderRunning),
    tabMovesFocus: layout.tabMovesFocus,
  }
}

/** Whether Windows has a screen reader using eNCode now, as Electron says; kept up to date from the app's start. */
export const useScreenReaderRunning = create<{ running: boolean }>(() => ({ running: false }))

function load(): EditorLayout {
  try {
    return normalizeLayout(JSON.parse(localStorage.getItem(KEY) ?? 'null'))
  } catch {
    return { ...DEFAULTS }
  }
}

interface EditorLayoutStore extends EditorLayout {
  set(patch: Partial<EditorLayout>): void
}

/**
 * Ctrl+Shift+. asks the breadcrumbs for the keyboard: they open the list of their last part. An ask made while they
 * are hidden is taken up when they show.
 */
export const useBreadcrumbsAsk = create<{ asked: number; handled: number }>(() => ({ asked: 0, handled: 0 }))

export function focusBreadcrumbs(): void {
  useBreadcrumbsAsk.setState((state) => ({ asked: state.asked + 1 }))
}

export const useEditorLayout = create<EditorLayoutStore>((set, get) => ({
  ...load(),
  set(patch) {
    set(patch)
    const { set: _set, ...layout } = get()
    try {
      localStorage.setItem(KEY, JSON.stringify(normalizeLayout(layout)))
    } catch {
      /* storage may be unavailable */
    }
  },
}))
