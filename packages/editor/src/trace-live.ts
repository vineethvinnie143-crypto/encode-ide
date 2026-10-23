/**
 * Writing down what happens in a live editor, for a bug report (ADR 0088): every transaction becomes the steps that
 * lead to its exact state when replayed (see trace.ts). Changes are kept as changes, with the origin that made them
 * ("input.type", "undo", "server"), not as the keys that made them: a replay then reaches the very documents and
 * selections the person saw, whatever the undo history did, and the origins still say what happened.
 */
import type { EditorState, Transaction } from './state'
import { TraceRecorder, type EditorTrace, type TraceAction } from './trace'

export interface EditRecordLimits {
  /** A longer trace starts again from where it is: a report carries the newest steps. */
  steps: number
  /** The most characters the steps may carry (insertions and reloads), likewise. */
  chars: number
  /** A document longer than this is not recorded. */
  doc: number
}

export const EDIT_RECORD_LIMITS: EditRecordLimits = { steps: 20_000, chars: 4_000_000, doc: 2_000_000 }

/** Why a document has no trace to give. */
export type NoTrace = 'too large' | 'nothing yet'

/**
 * Records one document's transactions from a state. A transaction that does not start where the last one ended (a
 * change the recorder did not see) starts the trace again from it, as does one that changes the configuration (a
 * new language, another indentation), which a trace cannot say.
 */
export class EditRecorder {
  private recorder: TraceRecorder | null = null
  private last: EditorState
  private steps = 0
  private chars = 0
  /** When the trace being kept started, by `now`. */
  private since = 0
  /** How many times it started again because it was long: the report says it holds only the newest steps. */
  private restarts = 0

  constructor(
    start: EditorState,
    private readonly now: () => number = Date.now,
    private readonly limits: EditRecordLimits = EDIT_RECORD_LIMITS,
  ) {
    this.last = start
    this.begin(start)
  }

  /** Takes in a transaction the editor made. */
  record(tr: Transaction): void {
    const start = tr.startState
    if (start !== this.last && !(start.doc === this.last.doc && start.selection.eq(this.last.selection) && start.config === this.last.config)) this.begin(start)
    this.last = tr.state
    if (tr.state.config !== start.config) {
      this.begin(tr.state)
      return
    }
    if (!this.recorder) {
      // A document that was too large may have become small enough.
      if (tr.state.doc.length <= this.limits.doc) this.begin(tr.state)
      return
    }
    for (const action of actionsOf(tr)) {
      this.recorder.record(action)
      this.steps++
      this.chars += charsOf(action)
    }
    if (this.steps > this.limits.steps || this.chars > this.limits.chars) {
      this.restarts++
      this.begin(tr.state)
    }
  }

  /** The trace so far, ending with what the document is now; why there is none otherwise. */
  trace(name?: string): EditorTrace | NoTrace {
    if (!this.recorder) return 'too large'
    const trace = this.recorder.trace(this.last)
    if (trace.steps.length <= 1) return 'nothing yet'
    return name ? { ...trace, name } : trace
  }

  /** How much is kept: its steps, when it started, and whether older steps were let go. */
  get extent(): { steps: number; since: number; trimmed: boolean } {
    return { steps: this.steps, since: this.since, trimmed: this.restarts > 0 }
  }

  private begin(state: EditorState): void {
    this.last = state
    this.steps = 0
    this.chars = 0
    this.since = this.now()
    this.recorder = state.doc.length <= this.limits.doc ? new TraceRecorder(state, this.now) : null
  }
}

/** The steps that take a replay from a transaction's start to its end. */
export function actionsOf(tr: Transaction): TraceAction[] {
  const actions: TraceAction[] = []
  const { startState: start, state } = tr
  let expected = start.selection
  if (tr.docChanged) {
    if (start.config.readOnly) {
      // A replay leaves the text of a read-only document alone, except for a reload from disk.
      actions.push({ reload: state.doc.toString() })
      return [...actions, selectOf(state)]
    }
    const changes: [number, number, string][] = []
    tr.changes.forEach((fromA, toA, _fromB, _toB, insert) => changes.push([fromA, toA, insert]))
    actions.push({ changes, ...(tr.origin ? { origin: tr.origin } : {}) })
    expected = start.selection.map(tr.changes).clamp(state.doc.length)
  }
  if (!state.selection.eq(expected)) actions.push(selectOf(state))
  return actions
}

function selectOf(state: EditorState): TraceAction {
  const { ranges, mainIndex } = state.selection
  return { select: ranges.map((range) => [range.anchor, range.head] as const), ...(mainIndex ? { main: mainIndex } : {}) }
}

function charsOf(action: TraceAction): number {
  if ('changes' in action) return action.changes.reduce((sum, [, , insert]) => sum + insert.length + 8, 0)
  if ('reload' in action) return action.reload.length
  if ('select' in action) return action.select.length * 8
  return 8
}
