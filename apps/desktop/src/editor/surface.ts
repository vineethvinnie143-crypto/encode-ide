/**
 * The editor as the rest of the app sees it (ADR 0088): it opens a file, shows its text, reports its edits and shows
 * its problems. The stores, the panels, the palette, the Review tab and the agent's way to the language servers go
 * through this module and surface-view.ts only, never into the editor's own modules (src/editor, CodeEditor.tsx,
 * components/code) or its packages (@encode/editor, @encode/editor-view, @encode/text). Another engine takes the
 * editor's place by keeping what this module exports, and nothing outside it changes; surface.test.ts holds the list
 * of exports and refuses an import that goes around them.
 *
 * Places are in the language servers' counting: zero-based lines, UTF-16 columns.
 */
import { EditorSelection, MAX_TOKENIZED_LINE, SelectionRange, TOKEN_NAMES, languageForPath } from '@encode/editor'
import type { EditorView } from '@encode/editor-view'
import type { CodeRange } from '@shared/types'
import { activeEditor, hasActiveEditor, runEditorCommand as runCommand } from './active'
import { FORMAT_ON_SAVE_MS, formatDoc } from './assist/format'
import { applyExternal, closeDoc, closeDocsUnder, docState, hasDoc, hostOf, isDirty, markSaved as markDocSaved, matchesSaved as docMatchesSaved, openDoc, renameDocs, snapshotForSave as docSnapshot, type Snapshot } from './docs'
import { positionOf } from './marks'

// ---- Files: what the editor holds open, as the tabs' store asks ----

/** What a save writes and then marks as saved; only the editor reads inside it. */
export type SaveSnapshot = Snapshot

/** Opens `content` as the file at `path` (or keeps the one open); answers the language the editor reads it as. */
export function openFile(path: string, content: string): { language: string } {
  return { language: openDoc(path, content).config.language.id }
}

/** Lets go of a file, unsaved text and all. */
export const closeFile = (path: string): void => closeDoc(path)

/** Lets go of the file or folder at `path` that is gone, and of every file under it. */
export const closeFilesUnder = (path: string): void => closeDocsUnder(path)

/** A file or folder was renamed or moved: the text, cursor and record of edits of each file in it follow. */
export const renameFile = (from: string, to: string): void => renameDocs(from, to)

export const isOpen = (path: string): boolean => hasDoc(path)

/** Whether the text differs from what is on disk. */
export const isUnsaved = (path: string): boolean => isDirty(path)

/** Whether `content` is what the editor last read or wrote for `path`. */
export const matchesSaved = (path: string, content: string): boolean => docMatchesSaved(path, content)

/** The language the open file is read as ("typescript"), or null when it is not open. */
export const languageOf = (path: string): string | null => docState(path)?.config.language.id ?? null

/** Another program wrote the file: the editor takes the new text as one change that can be undone, cursor kept. */
export const takeExternal = (path: string, content: string): boolean => applyExternal(path, content)

/** The text to write for a save, with the file's own line ends; null when the file is not open. */
export const snapshotForSave = (path: string): SaveSnapshot | null => docSnapshot(path)

/** The snapshot was written: that text is now the saved one. */
export const markSaved = (path: string, snapshot: SaveSnapshot): void => markDocSaved(path, snapshot)

/** Formats the file with its language server before a save, waiting a short while at most; never fails the save. */
export async function formatBeforeSave(path: string): Promise<void> {
  await formatDoc(path, undefined, { waitMs: FORMAT_ON_SAVE_MS }).catch(() => undefined)
}

/** The text of an open file, read without copying all of it. */
export interface FileText {
  readonly lines: number
  /** The text of a line, 1-based, without its line end. */
  line(n: number): string
}

export function fileText(path: string): FileText | null {
  const doc = docState(path)?.doc
  if (!doc) return null
  return { lines: doc.lineCount, line: (n) => doc.lineTexts(n, n)[0] }
}

// ---- The editor on screen ----

/** Whether an editor is on screen showing a file. */
export const hasShownEditor = (): boolean => hasActiveEditor()

/** The view on screen when it shows `path`. */
function shownView(path: string | null): EditorView | null {
  const view = activeEditor()
  return view && path && hasActiveEditor() && hostOf(path) === view ? view : null
}

/** Whether the editor on screen shows `path`. */
export const isShowing = (path: string | null): boolean => shownView(path) !== null

/** Runs one of the editor's commands ("goToDefinition") with the keys in the editor; false when none is on screen. */
export const runEditorCommand = (name: string): boolean => runCommand(name)

/** Gives the keys to the editor when it shows `path`. */
export function focusEditor(path: string | null): void {
  shownView(path)?.focus()
}

/** The cursor and the scroll of the editor showing a file, kept to be put back; only the editor reads inside it. */
export interface KeptView {
  readonly path: string
}

const kept = new WeakMap<KeptView, { selection: EditorSelection; scroll: { top: number; left: number } }>()

/** Keeps where the cursor and the scroll are, when the editor on screen shows `path`. */
export function keepView(path: string): KeptView | null {
  const view = shownView(path)
  if (!view) return null
  const handle: KeptView = Object.freeze({ path })
  kept.set(handle, { selection: view.state.selection, scroll: view.saveScroll() })
  return handle
}

/** Puts the cursor and the scroll back as `keepView` kept them; false when the file is no longer on screen. */
export function putBackView(handle: KeptView): boolean {
  const view = shownView(handle.path)
  const spot = kept.get(handle)
  if (!view || !spot) return false
  view.dispatch({ selection: spot.selection, origin: 'select' })
  view.flush()
  view.scroller.scrollTop = spot.scroll.top
  view.scroller.scrollLeft = spot.scroll.left
  return true
}

/** Selects a range of the file on screen, the cursor at its start, scrolled into the middle; the keys stay where they are. */
export function showRange(path: string, range: CodeRange): boolean {
  const view = shownView(path)
  if (!view) return false
  const { doc } = view.state
  const from = positionOf(doc, range.start.line, range.start.character)
  const to = Math.max(from, positionOf(doc, range.end.line, range.end.character))
  view.dispatch({ selection: EditorSelection.create([new SelectionRange(to, from)]), origin: 'select' })
  view.scrollToPos(from, true)
  return true
}

/** Opens a file at a place of it, remembering the cursor's place for Back. */
export { goToPlace, type Place } from './assist/navigation'

// ---- Edits and problems: the language servers follow the editor's text, and their marks come back to it ----

/** Sends each open file's text to the language servers as it changes; returns the way to stop. */
export { startLanguageSync, tooLargeForServers, type DocumentSink } from './language'

/** What the servers found, drawn in the editor and counted per file for its footer. */
export { clearMarks, setMarks, useProblems, type ProblemCount } from './marks'

/** A question to the servers about the folder's files (its symbols, a place's definition). */
export { askServers } from './assist/ask'

/** The symbols of the file on screen, and finding among them. */
export { useOutline } from './assist/outline'
export { findSymbols, type OutlineSort } from './symbols'

/** Suggestions as you type: their state, and the footer's words for it. */
export { useGhost } from './assist/ghost'
export { ghostFooter } from './assist/ghost-text'

/** Whether a file can be reported as an editor issue: what is recorded of it is what is open. */
export const canReportIssue = (path: string | null): boolean => path !== null && hasDoc(path)

// ---- Colours for text the editor does not show (the Review tab) ----

/** Colours a file's lines one after another, each from the state the line before left. */
export interface LineColours {
  readonly start: string
  /** The line's tokens as [start, kind, start, kind, ...]; a line the tokenizer fails on is plain. */
  line(text: string, state: string): { tokens: readonly number[]; state: string }
}

/** The colours the editor gives a file by its name, for lines it does not show. */
export function lineColoursFor(path: string): LineColours {
  const { tokenizer } = languageForPath(path)
  return {
    start: tokenizer.start,
    line(text, state) {
      try {
        return tokenizer.line(text.length > MAX_TOKENIZED_LINE ? text.slice(0, MAX_TOKENIZED_LINE) : text, state)
      } catch {
        // A tokenizer that fails on a line leaves it plain, as the editor does.
        return { tokens: text ? [0, 0] : [], state }
      }
    },
  }
}

/** The class a token kind is drawn with ("tok-keyword"), or '' for plain text; the editor's stylesheet colours it. */
export function tokenClass(kind: number): string {
  const name = TOKEN_NAMES[kind] ?? 'plain'
  return name === 'plain' ? '' : `tok-${name}`
}
