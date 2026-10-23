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
  /** The outline's width in pixels, as the person dragged it. */
  outlineWidth: number
  outlineSort: OutlineSort
  /** The outline shows the symbol the cursor is in, opening the symbols it is under. */
  outlineFollow: boolean
}

export const OUTLINE_MIN = 180
export const OUTLINE_MAX = 480
/** The parts of the editor a menu turns on and off. */
export type EditorPart = 'breadcrumbs' | 'outline' | 'folding' | 'stickyScroll' | 'bracketColors' | 'minimap'

const DEFAULTS: EditorLayout = {
  breadcrumbs: true,
  outline: false,
  folding: true,
  stickyScroll: true,
  bracketColors: true,
  minimap: true,
  outlineWidth: 248,
  outlineSort: 'position',
  outlineFollow: true,
}

/** A saved layout, each field checked; what is missing or wrong takes its default. */
export function normalizeLayout(value: unknown): EditorLayout {
  if (typeof value !== 'object' || value === null) return { ...DEFAULTS }
  const raw = value as Record<string, unknown>
  const width = typeof raw.outlineWidth === 'number' && Number.isFinite(raw.outlineWidth) ? Math.round(raw.outlineWidth) : DEFAULTS.outlineWidth
  const flag = (name: EditorPart): boolean => (typeof raw[name] === 'boolean' ? (raw[name] as boolean) : DEFAULTS[name])
  return {
    breadcrumbs: flag('breadcrumbs'),
    outline: flag('outline'),
    folding: flag('folding'),
    stickyScroll: flag('stickyScroll'),
    bracketColors: flag('bracketColors'),
    minimap: flag('minimap'),
    outlineWidth: Math.min(OUTLINE_MAX, Math.max(OUTLINE_MIN, width)),
    outlineSort: raw.outlineSort === 'name' || raw.outlineSort === 'kind' || raw.outlineSort === 'position' ? raw.outlineSort : DEFAULTS.outlineSort,
    outlineFollow: typeof raw.outlineFollow === 'boolean' ? raw.outlineFollow : DEFAULTS.outlineFollow,
  }
}

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
