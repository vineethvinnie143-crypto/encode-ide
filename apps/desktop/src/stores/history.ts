/**
 * Back and forward over the places you visit, like a browser: visiting from
 * the middle of the history drops what was ahead. Pure, for unit tests.
 */

export interface History<T> {
  entries: T[]
  index: number
}

export const MAX_HISTORY = 50

export function emptyHistory<T>(): History<T> {
  return { entries: [], index: -1 }
}

/** Records a visit. Visiting the place you are already at changes nothing. */
export function visit<T>(history: History<T>, place: T, same: (a: T, b: T) => boolean = Object.is): History<T> {
  const current = history.entries[history.index]
  if (current !== undefined && same(current, place)) return history
  const entries = [...history.entries.slice(0, history.index + 1), place].slice(-MAX_HISTORY)
  return { entries, index: entries.length - 1 }
}

export function canGoBack<T>(history: History<T>): boolean {
  return history.index > 0
}

export function canGoForward<T>(history: History<T>): boolean {
  return history.index < history.entries.length - 1
}

export function goBack<T>(history: History<T>): History<T> {
  return canGoBack(history) ? { ...history, index: history.index - 1 } : history
}

export function goForward<T>(history: History<T>): History<T> {
  return canGoForward(history) ? { ...history, index: history.index + 1 } : history
}

/** Drops a place that no longer exists (a deleted session), keeping your position. */
export function forget<T>(history: History<T>, gone: (place: T) => boolean): History<T> {
  const entries: T[] = []
  let index = -1
  history.entries.forEach((place, position) => {
    if (gone(place)) return
    // Two neighbours that become equal after a removal stay as two; harmless.
    entries.push(place)
    if (position <= history.index) index = entries.length - 1
  })
  return { entries, index: entries.length ? Math.max(0, index) : -1 }
}
