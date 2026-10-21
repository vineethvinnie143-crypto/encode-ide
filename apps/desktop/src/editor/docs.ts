import { EditorState, detectIndent, languageForPath, reload, type Transaction } from '@encode/editor'
import { Text } from '@encode/text'

export type Eol = '\n' | '\r\n'

export interface Scroll {
  top: number
  left: number
}

/** What an editor shows a document through: the view, or anything with a state that takes transactions. */
export interface DocHost {
  readonly state: EditorState
  dispatch(transaction: Transaction): unknown
}

interface Entry {
  state: EditorState
  /** The file as eNCode last read or wrote it. */
  saved: Text
  savedPoint: number
  scroll: Scroll | null
  host: DocHost | null
}

/**
 * The open documents, outside the UI store: an edit changes a document on
 * every keystroke, and nothing that only lists tabs should render for it.
 * The editor's state per file lives here, together with what is on disk, so
 * "unsaved" is a question about the text and not a flag that can go stale.
 */
const docs = new Map<string, Entry>()

/** The text a file holds in memory always uses "\n"; this is the separator it is written back with. */
export function eolOf(content: string): Eol {
  return content.includes('\r\n') ? '\r\n' : '\n'
}

function normalize(content: string): string {
  return content.includes('\r') ? content.replace(/\r\n?/g, '\n') : content
}

/** Opens a document from the text read from disk, or returns the one already open. */
export function openDoc(path: string, content: string): EditorState {
  const existing = docs.get(path)
  if (existing) return existing.state
  const eol = eolOf(content)
  const text = normalize(content)
  const doc = Text.of(text)
  const indent = detectIndent(doc)
  const state = EditorState.create({
    doc,
    language: languageForPath(path),
    indentUnit: indent.indentUnit,
    tabSize: indent.tabSize,
    lineSeparator: eol,
  })
  docs.set(path, { state, saved: doc, savedPoint: state.history.point, scroll: null, host: null })
  return state
}

export function hasDoc(path: string): boolean {
  return docs.has(path)
}

export function docState(path: string): EditorState | undefined {
  return docs.get(path)?.state
}

export function closeDoc(path: string): void {
  docs.delete(path)
}

export function closeDocsUnder(prefix: string): void {
  for (const path of [...docs.keys()]) if (path === prefix || path.startsWith(`${prefix}/`)) docs.delete(path)
}

export function eolFor(path: string): Eol {
  return docs.get(path)?.state.config.lineSeparator ?? '\n'
}

/**
 * Records the state a view reached for `path`. Returns whether the document
 * has unsaved changes. Equal history points mean equal text, so the usual
 * answer costs nothing; the text is only compared when the points differ
 * but the lengths agree (typed and deleted again).
 */
export function recordState(path: string, state: EditorState): boolean {
  const entry = docs.get(path)
  if (!entry) return false
  entry.state = state
  return differs(entry)
}

function differs(entry: Entry): boolean {
  if (entry.state.history.point === entry.savedPoint) return false
  const { doc } = entry.state
  if (doc.length !== entry.saved.length || doc.lineCount !== entry.saved.lineCount) return true
  return !doc.eq(entry.saved)
}

export function isDirty(path: string): boolean {
  const entry = docs.get(path)
  return entry ? differs(entry) : false
}

/** The document as one save reads it: the text to write, and what "saved" will mean once the write has succeeded. */
export interface Snapshot {
  text: string
  doc: Text
  point: number
}

/** Typing may go on while the file is being written, so a save keeps the document and history point it wrote. */
export function snapshotForSave(path: string): Snapshot | null {
  const entry = docs.get(path)
  if (!entry) return null
  const { state } = entry
  const text = state.doc.toString()
  return {
    text: state.config.lineSeparator === '\r\n' ? text.replace(/\n/g, '\r\n') : text,
    doc: state.doc,
    point: state.history.point,
  }
}

/** The file now holds what the snapshot held. */
export function markSaved(path: string, snapshot: Snapshot): void {
  const entry = docs.get(path)
  if (!entry) return
  entry.saved = snapshot.doc
  entry.savedPoint = snapshot.point
}

export function saveScroll(path: string, scroll: Scroll): void {
  const entry = docs.get(path)
  if (entry) entry.scroll = scroll
}

export function scrollOf(path: string): Scroll | null {
  return docs.get(path)?.scroll ?? null
}

/** The view that shows `path` right now: external changes to it go through the view, so its cursor and scroll position stay. */
export function attach(path: string, host: DocHost | null): void {
  const entry = docs.get(path)
  if (entry) entry.host = host
}

/**
 * The file changed on disk (the agent wrote it, another program did). The
 * open document takes the new text as a small change: the cursor stays, and
 * the reload can be undone. The new text is what is saved now, so the
 * document is not "unsaved" because of it; that is settled before the view
 * hears about the change, or it would report the document as edited.
 */
export function applyExternal(path: string, content: string): boolean {
  const entry = docs.get(path)
  if (!entry) return false
  const host = entry.host
  const tr = reload(host?.state ?? entry.state, normalize(content))
  if (!tr) {
    const current = host?.state ?? entry.state
    entry.saved = current.doc
    entry.savedPoint = current.history.point
    return false
  }
  entry.state = tr.state
  entry.saved = tr.state.doc
  entry.savedPoint = tr.state.history.point
  host?.dispatch(tr)
  return true
}
