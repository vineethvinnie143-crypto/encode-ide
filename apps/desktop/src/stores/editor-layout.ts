import { create } from '../store'
import type { OutlineSort } from '../editor/symbols'

const KEY = 'eNCode.editorLayout.v1'

/** How the editor pane is laid out around the text: the breadcrumbs above it, the outline beside it. */
export interface EditorLayout {
  breadcrumbs: boolean
  outline: boolean
  /** The outline's width in pixels, as the person dragged it. */
  outlineWidth: number
  outlineSort: OutlineSort
  /** The outline shows the symbol the cursor is in, opening the symbols it is under. */
  outlineFollow: boolean
}

export const OUTLINE_MIN = 180
export const OUTLINE_MAX = 480
const DEFAULTS: EditorLayout = { breadcrumbs: true, outline: false, outlineWidth: 248, outlineSort: 'position', outlineFollow: true }

/** A saved layout, each field checked; what is missing or wrong takes its default. */
export function normalizeLayout(value: unknown): EditorLayout {
  if (typeof value !== 'object' || value === null) return { ...DEFAULTS }
  const raw = value as Record<string, unknown>
  const width = typeof raw.outlineWidth === 'number' && Number.isFinite(raw.outlineWidth) ? Math.round(raw.outlineWidth) : DEFAULTS.outlineWidth
  return {
    breadcrumbs: typeof raw.breadcrumbs === 'boolean' ? raw.breadcrumbs : DEFAULTS.breadcrumbs,
    outline: typeof raw.outline === 'boolean' ? raw.outline : DEFAULTS.outline,
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
