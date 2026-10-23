import type { ChangeSet } from '@encode/text'
import type { EditorSelection } from './selection'

/** Typing pauses longer than this start a new undo step. */
export const GROUP_DELAY_MS = 500
/** Undo steps kept; the oldest fall off. */
export const MAX_DEPTH = 500

/**
 * One undo step. `changes` turns the document after the step back into the
 * one before it (or, on the redo stack, forwards again).
 */
export interface HistoryGroup {
  /** Unique across all states, so a saved point can be recognised after undo and redo. */
  readonly id: number
  readonly changes: ChangeSet
  /** Selection to restore when the step is undone. */
  readonly selectionBefore: EditorSelection
  /** Selection to restore when the step is redone. */
  readonly selectionAfter: EditorSelection
  readonly time: number
  readonly origin: string
}

let nextId = 1

let clock: () => number = Date.now

/** The time changes are recorded at: now, or while a trace is replayed, the time the trace says. */
export function historyNow(): number {
  return clock()
}

/**
 * Runs `run` with the history reading the time from `now`, so typing in a replayed trace groups into undo steps
 * exactly as it did when it was recorded. Synchronous, and the clock is put back however `run` ends.
 */
export function withHistoryClock<T>(now: () => number, run: () => T): T {
  const saved = clock
  clock = now
  try {
    return run()
  } finally {
    clock = saved
  }
}

/**
 * For a test that drives a mounted editor over time, as the browser tests' random use does: the history reads the
 * time from `now` until this is called again with null, so the same steps group into the same undo steps every run.
 */
export function setHistoryClock(now: (() => number) | null): void {
  clock = now ?? Date.now
}

/** Origins whose consecutive steps merge into one, and what they merge after. */
function merges(previous: string, next: string): boolean {
  if (next === 'input.type') return previous === 'input.type' || previous === 'input.newline'
  if (next === 'input.delete') return previous === 'input.delete'
  return false
}

/**
 * Undo and redo stacks. Every document change goes through here (also
 * reloads from disk and rejected review hunks), so each stored change set
 * always applies to the current document.
 */
export class History {
  static readonly empty = new History([], [])

  private constructor(
    readonly done: readonly HistoryGroup[],
    readonly undone: readonly HistoryGroup[],
  ) {}

  /** Identifies the document's place in history: equal points mean equal text. 0 is the start. */
  get point(): number {
    return this.done.length ? this.done[this.done.length - 1].id : 0
  }

  get canUndo(): boolean {
    return this.done.length > 0
  }

  get canRedo(): boolean {
    return this.undone.length > 0
  }

  /**
   * Records a change. `inverse` undoes it; typing and deleting in a row,
   * without moving the cursor in between, extend the previous step.
   */
  record(
    inverse: ChangeSet,
    selectionBefore: EditorSelection,
    selectionAfter: EditorSelection,
    origin: string,
    time: number,
  ): History {
    const last = this.done[this.done.length - 1]
    if (
      last &&
      merges(last.origin, origin) &&
      time - last.time < GROUP_DELAY_MS &&
      selectionBefore.eq(last.selectionAfter)
    ) {
      const group: HistoryGroup = {
        id: nextId++,
        changes: inverse.compose(last.changes),
        selectionBefore: last.selectionBefore,
        selectionAfter,
        time,
        origin,
      }
      return new History([...this.done.slice(0, -1), group], [])
    }
    const group: HistoryGroup = { id: nextId++, changes: inverse, selectionBefore, selectionAfter, time, origin }
    const done = this.done.length >= MAX_DEPTH ? this.done.slice(this.done.length - MAX_DEPTH + 1) : this.done
    return new History([...done, group], [])
  }

  /** Moves the newest step to the redo stack; `forward` redoes it. */
  popUndo(forward: ChangeSet): { group: HistoryGroup; history: History } | null {
    const group = this.done[this.done.length - 1]
    if (!group) return null
    const redo: HistoryGroup = { ...group, changes: forward }
    return { group, history: new History(this.done.slice(0, -1), [...this.undone, redo]) }
  }

  /** Moves the newest undone step back; `inverse` undoes it again. */
  popRedo(inverse: ChangeSet): { group: HistoryGroup; history: History } | null {
    const group = this.undone[this.undone.length - 1]
    if (!group) return null
    const done: HistoryGroup = { ...group, changes: inverse }
    return { group, history: new History([...this.done, done], this.undone.slice(0, -1)) }
  }

  /** A history whose next change starts a new step even if it would otherwise merge. */
  isolate(): History {
    const last = this.done[this.done.length - 1]
    if (!last || last.origin.endsWith('|isolated')) return this
    return new History([...this.done.slice(0, -1), { ...last, origin: `${last.origin}|isolated` }], this.undone)
  }
}
