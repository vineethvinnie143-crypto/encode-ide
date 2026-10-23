import { CharClass, charClass, fuzzyMatch, leadingWhitespace, type EditorState } from '@encode/editor'
import type { ChangeSet, ChangeSpec, Text } from '@encode/text'
import type { CodeRange, CodeTextEdit, CompletionEntry } from '@shared/types'
import { positionOf } from '../marks'

/**
 * The editor's side of completion, free of the DOM: which words the list keeps and in what order for what was
 * typed, and what accepting one changes in the document. A list answers the text as it was when asked; `Since`
 * follows it to the text as it is now.
 */

/** A list item as it ranks for what was typed, with the letters of its label that matched. */
export interface Ranked {
  entry: CompletionEntry
  score: number
  matches: number[]
}

/** The changes since a question was asked, to bring the positions of its answer to the text as it is now. */
export class Since {
  private changes: ChangeSet | null = null

  constructor(
    /** The document the question was asked of. */
    readonly doc: Text,
  ) {}

  /** A change made after the question. */
  add(changes: ChangeSet): void {
    this.changes = this.changes ? this.changes.compose(changes) : changes
  }

  /** A server's position in the asked-of document, where it is now. */
  pos(line: number, character: number, assoc: -1 | 1 = -1): number {
    const at = positionOf(this.doc, line, character)
    return this.changes ? this.changes.mapPos(at, assoc) : at
  }

  /** A position in the asked-of document, where it is now. */
  map(pos: number, assoc: -1 | 1 = -1): number {
    return this.changes ? this.changes.mapPos(pos, assoc) : pos
  }

  /** True when the text the question was asked of was changed inside `from`..`to` (in its own offsets). */
  touched(from: number, to: number): boolean {
    return Boolean(this.changes?.changes.some((change) => change.from < to && change.to > from))
  }
}

const isWord = (state: EditorState, char: string): boolean => charClass(char, state.config.language.wordChars) === CharClass.Word

/** True when `text` is one or more characters of a word, as the file's language counts them. */
export function isWordText(state: EditorState, text: string): boolean {
  if (!text) return false
  for (const char of text) if (!isWord(state, char)) return false
  return true
}

/** Where the word that ends at `pos` starts, on its line. */
export function wordStart(state: EditorState, pos: number): number {
  const line = state.doc.lineAt(pos)
  const text = line.text
  let index = pos - line.from
  while (index > 0 && isWord(state, text[index - 1])) index--
  return line.from + index
}

/** Where the word that starts at `pos` ends, on its line. */
export function wordEnd(state: EditorState, pos: number): number {
  const line = state.doc.lineAt(pos)
  const text = line.text
  let index = pos - line.from
  while (index < text.length && isWord(state, text[index])) index++
  return line.from + index
}

/** Where an item's text starts now: its own range's start, or the start of the word the list was asked for. */
export function itemStart(entry: CompletionEntry, since: Since, start: number): number {
  const range = entry.insert ?? entry.replace
  return range ? since.pos(range.start.line, range.start.character, -1) : start
}

/**
 * The items that match what was typed since each one's start, best first: by the match, then by the server's own
 * order (its sort text), then by label. With nothing typed every item stays, in the server's order.
 */
export function rankEntries(entries: readonly CompletionEntry[], typed: (entry: CompletionEntry) => string): Ranked[] {
  const out: Ranked[] = []
  for (const entry of entries) {
    const prefix = typed(entry)
    if (!prefix) {
      out.push({ entry, score: 0, matches: [] })
      continue
    }
    const found = fuzzyMatch(prefix, entry.filterText)
    if (!found) continue
    const matches = entry.filterText === entry.label ? found.matches : (fuzzyMatch(prefix, entry.label)?.matches ?? [])
    out.push({ entry, score: found.score, matches })
  }
  return out.sort((a, b) => b.score - a.score || compare(a.entry.sortText, b.entry.sortText) || compare(a.entry.label, b.entry.label))
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** The item to select first: the one the server asked for when nothing is typed yet, else the best. */
export function firstSelected(ranked: readonly Ranked[], typedNothing: boolean): number {
  if (typedNothing) {
    const preselected = ranked.findIndex((item) => item.entry.preselect)
    if (preselected >= 0) return preselected
  }
  return 0
}

/** What accepting an item changes: its text at each place, and the edits elsewhere it brings. */
export interface CompletionPlan {
  /** Where the item's text goes: at the main cursor first, then at the other cursors that have the same text before them. */
  ranges: { from: number; to: number }[]
  text: string
  snippet: boolean
  /** Edits elsewhere in the document, such as an import, in its offsets now. */
  changes: ChangeSpec[]
}

/**
 * Accepting `entry`: `insert` puts its text in place of what was typed of the word, `replace` in place of the whole
 * word under the cursor. Its range is the server's when it gave one, else the word's.
 */
export function planCompletion(state: EditorState, entry: CompletionEntry, since: Since, start: number, mode: 'insert' | 'replace' = 'insert'): CompletionPlan {
  const { doc, selection } = state
  const cursor = selection.main.head
  const range = mode === 'replace' ? (entry.replace ?? entry.insert) : (entry.insert ?? entry.replace)
  const from = Math.min(cursor, range ? since.pos(range.start.line, range.start.character, -1) : start)
  let to: number
  if (mode === 'insert') to = Math.max(cursor, range ? since.pos(range.end.line, range.end.character, -1) : cursor)
  else to = Math.max(cursor, range ? since.pos(range.end.line, range.end.character, 1) : wordEnd(state, cursor))
  // Not past the end of the line: a server's range never spans lines here.
  to = Math.min(to, doc.lineAt(cursor).to)
  const before = cursor - from
  const after = to - cursor
  const typed = doc.sliceString(from, cursor)
  const ranges = [{ from, to }]
  for (const other of selection.ranges) {
    if (other === selection.main || !other.empty) continue
    const head = other.head
    const otherLine = doc.lineAt(head)
    if (head - before < otherLine.from || head + after > otherLine.to) continue
    if (doc.sliceString(head - before, head) !== typed) continue
    ranges.push({ from: head - before, to: head + after })
  }
  return { ranges, text: entry.insertText.replace(/\r\n?/g, '\n'), snippet: entry.snippet, changes: editsElsewhere(entry.additionalEdits ?? [], since, ranges) }
}

/** An item's edits elsewhere (an import) in the document now; one that overlaps `avoid` (where the item goes) is left out. */
export function editsElsewhere(edits: readonly CodeTextEdit[], since: Since, avoid: readonly { from: number; to: number }[]): ChangeSpec[] {
  const changes: ChangeSpec[] = []
  for (const edit of edits) {
    const from = since.pos(edit.range.start.line, edit.range.start.character, -1)
    const to = Math.max(from, since.pos(edit.range.end.line, edit.range.end.character, 1))
    if (avoid.some((item) => from < item.to && to > item.from)) continue
    if (changes.some((item) => from < (item.to ?? item.from) && to > item.from)) continue
    changes.push({ from, to, insert: edit.newText.replace(/\r\n?/g, '\n') })
  }
  return changes
}

/** Plain text of several lines as it goes on a line: each line after the first starts with that line's indentation. */
export function indentText(text: string, indent: string): string {
  return indent && text.includes('\n') ? text.replace(/\n/g, `\n${indent}`) : text
}

/** The indentation of the line `pos` is on. */
export function indentAt(state: EditorState, pos: number): string {
  return leadingWhitespace(state.doc.lineAt(pos).text)
}

/** A server range as editor offsets now, the start before text typed there and the end after it. */
export function rangeNow(since: Since, range: CodeRange): { from: number; to: number } {
  const from = since.pos(range.start.line, range.start.character, -1)
  return { from, to: Math.max(from, since.pos(range.end.line, range.end.character, 1)) }
}

/** The characters that accept an item and are then typed: the item's own, else the server's for every item. */
export function commitCharactersOf(entry: CompletionEntry, serverWide: readonly string[]): readonly string[] {
  return entry.commitCharacters ?? serverWide
}
