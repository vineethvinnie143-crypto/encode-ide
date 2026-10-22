import { create } from '../store'
import { foldQuery } from '../find/text'

/** How long typing pauses before the thread is searched, so a long session is not searched at every key. */
export const SETTLE_MS = 120

export interface FindState {
  open: boolean
  /** What is typed in the find bar. It stays when the bar closes, as a browser's does. */
  query: string
  /** The query as the thread is searched for it (see foldQuery), once typing settles; empty while the bar is closed. */
  needle: string
  /** Bumped by each Ctrl+F, so the bar takes the focus again and selects its text. */
  focusId: number
  /** Bumped each time the bar opens, so what was done during one search (a fold closed by hand) does not outlive it. */
  openId: number
  /** The latest request to move to the next or the previous match. */
  step: { direction: 1 | -1; id: number } | null
  /** The match in view, from 0, and how many there are; `capped` past the most find marks. */
  index: number
  total: number
  capped: boolean
  /** Opens the bar, on `seed` when given (the words selected in the thread). */
  show(seed?: string): void
  close(): void
  setQuery(query: string): void
  /**
   * Moves to the next or the previous match. While typing has not settled it searches at once instead, landing on
   * the first match, which a step would skip.
   */
  move(direction: 1 | -1): void
  setCount(index: number, total: number, capped: boolean): void
}

let settle: ReturnType<typeof setTimeout> | undefined

export const useFind = create<FindState>((set, get) => ({
  open: false,
  query: '',
  needle: '',
  focusId: 0,
  openId: 0,
  step: null,
  index: -1,
  total: 0,
  capped: false,

  show: (seed) => {
    clearTimeout(settle)
    settle = undefined
    const query = seed ?? get().query
    set((state) => ({ open: true, query, needle: foldQuery(query), focusId: state.focusId + 1, openId: state.open ? state.openId : state.openId + 1 }))
  },

  close: () => {
    clearTimeout(settle)
    settle = undefined
    set({ open: false, needle: '', step: null, index: -1, total: 0, capped: false })
  },

  setQuery: (query) => {
    clearTimeout(settle)
    settle = undefined
    const needle = foldQuery(query)
    // Clearing the field clears the marks at once; words wait for typing to settle.
    if (!needle) set({ query, needle: '', index: -1, total: 0, capped: false })
    else if (needle === get().needle) set({ query })
    else {
      set({ query })
      settle = setTimeout(() => {
        settle = undefined
        if (get().open) set({ needle })
      }, SETTLE_MS)
    }
  },

  move: (direction) => {
    if (settle !== undefined) {
      clearTimeout(settle)
      settle = undefined
      const needle = foldQuery(get().query)
      if (needle !== get().needle) {
        set({ needle })
        return
      }
    }
    set((state) => ({ step: { direction, id: (state.step?.id ?? 0) + 1 } }))
  },

  setCount: (index, total, capped) => {
    const state = get()
    if (state.index !== index || state.total !== total || state.capped !== capped) set({ index, total, capped })
  },
}))
