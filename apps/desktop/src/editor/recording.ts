import { EditRecorder, type EditorState, type EditorTrace, type NoTrace, type Transaction } from '@encode/editor'

/**
 * What happened in each open document since it opened, kept for a report of an editor issue (ADR 0088): its
 * transactions, from the view and from outside it (a reload from disk, a server's edit), as a replayable trace. It
 * stays in memory and goes nowhere unless the person saves a report. The newest steps are kept when a session is long.
 */
const recorders = new Map<string, EditRecorder>()

/** A document opened: its trace starts from the state it opened with. */
export function startRecording(path: string, state: EditorState): void {
  recorders.set(path, new EditRecorder(state))
}

/** A transaction the document took. A document not opened through docs.ts is not recorded. */
export function recordEdit(path: string, tr: Transaction): void {
  recorders.get(path)?.record(tr)
}

export function stopRecording(path: string): void {
  recorders.delete(path)
}

/** A document took another name: its trace goes with it. */
export function moveRecording(from: string, to: string): void {
  const recorder = recorders.get(from)
  if (!recorder) return
  recorders.delete(from)
  recorders.set(to, recorder)
}

export interface Recording {
  trace: EditorTrace
  steps: number
  /** Minutes the trace covers, to now. */
  minutes: number
  /** Older steps were let go to keep it small. */
  trimmed: boolean
}

/** What was recorded of a document, or why nothing was. */
export function recordingOf(path: string, now = Date.now()): Recording | NoTrace | 'not open' {
  const recorder = recorders.get(path)
  if (!recorder) return 'not open'
  const trace = recorder.trace()
  if (typeof trace === 'string') return trace
  const { steps, since, trimmed } = recorder.extent
  return { trace, steps, minutes: Math.max(0, (now - since) / 60_000), trimmed }
}
