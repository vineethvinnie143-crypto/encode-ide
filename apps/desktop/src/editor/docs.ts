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

/** Told when a document opens, changes, is saved or closes, so the language servers can follow the editor's text. */
export interface DocWatcher {
  opened(path: string, state: EditorState, dirty: boolean): void
  /** The text changed, or the file was written or read again (`dirty` false). */
  changed(path: string, state: EditorState, dirty: boolean): void
  closed(path: string): void
}

let watcher: DocWatcher | null = null

/** Sets the one watcher of the documents (null: none). */
export function watchDocs(next: DocWatcher | null): void {
  watcher = next
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
  watcher?.opened(path, state, false)
  return state
}

/** How the status bar names a document's indentation: "Spaces: 4" or "Tab Size: 4". */
export function indentLabel(state: EditorState): string {
  const { indentUnit, tabSize } = state.config
  return indentUnit === '\t' ? `Tab Size: ${tabSize}` : `Spaces: ${indentUnit.length}`
}

export function hasDoc(path: string): boolean {
  return docs.has(path)
}

export function docState(path: string): EditorState | undefined {
  return docs.get(path)?.state
}

export function closeDoc(path: string): void {
  if (docs.delete(path)) watcher?.closed(path)
}

/** A file or folder was renamed: its open documents follow it, and take the language of their new names. */
export function renameDocs(from: string, to: string): void {
  for (const [path, entry] of [...docs]) {
    if (path !== from && !path.startsWith(`${from}/`)) continue
    const next = to + path.slice(from.length)
    docs.delete(path)
    docs.set(next, entry)
    watcher?.closed(path)
    const current = entry.host?.state ?? entry.state
    const language = languageForPath(next)
    if (language.id !== current.config.language.id) {
      const tr = current.update({ config: { language } })
      entry.state = tr.state
      entry.host?.dispatch(tr)
    }
    watcher?.opened(next, entry.host?.state ?? entry.state, differs(entry))
  }
}

export function closeDocsUnder(prefix: string): void {
  for (const path of [...docs.keys()]) if (path === prefix || path.startsWith(`${prefix}/`)) closeDoc(path)
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
  const changed = entry.state.doc !== state.doc
  entry.state = state
  const dirty = differs(entry)
  if (changed) watcher?.changed(path, state, dirty)
  return dirty
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

/** Whether `content`, as read from disk just now, is what the document last read or wrote there: nobody else has changed the file since. */
export function matchesSaved(path: string, content: string): boolean {
  const entry = docs.get(path)
  return entry ? Text.of(normalize(content)).eq(entry.saved) : true
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
  return { text: state.serialize(), doc: state.doc, point: state.history.point }
}

/** The file now holds what the snapshot held. */
export function markSaved(path: string, snapshot: Snapshot): void {
  const entry = docs.get(path)
  if (!entry) return
  entry.saved = snapshot.doc
  entry.savedPoint = snapshot.point
  watcher?.changed(path, entry.host?.state ?? entry.state, differs(entry))
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
    watcher?.changed(path, current, false)
    return false
  }
  entry.state = tr.state
  entry.saved = tr.state.doc
  entry.savedPoint = tr.state.history.point
  host?.dispatch(tr)
  watcher?.changed(path, tr.state, false)
  return true
}
