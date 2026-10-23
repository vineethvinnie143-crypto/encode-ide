import { codePointWidth, type ChangeSet, type Line, type Text } from '@encode/text'

/**
 * Character-level helpers the commands share: grapheme clusters (so the
 * cursor never lands inside an emoji or between a letter and its accent),
 * word classes, and visual columns with tabs and wide characters.
 */

const segmenter =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null

/** No grapheme cluster is assumed to be longer than this. */
const WINDOW = 64

function isCombining(code: number): boolean {
  return (
    (code >= 0x300 && code <= 0x36f) ||
    (code >= 0x1ab0 && code <= 0x1aff) ||
    (code >= 0x1dc0 && code <= 0x1dff) ||
    (code >= 0x20d0 && code <= 0x20ff) ||
    (code >= 0xfe00 && code <= 0xfe0f) ||
    (code >= 0xfe20 && code <= 0xfe2f) ||
    code === 0x200d ||
    (code >= 0xdc00 && code <= 0xdfff)
  )
}

/** End of the grapheme cluster that starts at `index`. */
export function nextCluster(text: string, index: number): number {
  if (index >= text.length) return text.length
  const code = text.charCodeAt(index)
  const following = index + 1 < text.length ? text.charCodeAt(index + 1) : 0
  if (code < 0x80 && following < 0x300) return index + 1
  if (segmenter) {
    const first = segmenter.segment(text.slice(index, index + WINDOW))[Symbol.iterator]().next()
    if (!first.done) return index + first.value.segment.length
  }
  let end = index + 1
  while (end < text.length && isCombining(text.charCodeAt(end))) end++
  return end
}

/** Start of the grapheme cluster that ends at `index`. */
export function previousCluster(text: string, index: number): number {
  if (index <= 0) return 0
  const code = text.charCodeAt(index - 1)
  if (code < 0x80) return index - 1
  if (segmenter) {
    const start = Math.max(0, index - WINDOW)
    let last = start
    for (const piece of segmenter.segment(text.slice(start, index))) last = start + piece.index
    return last
  }
  let start = index - 1
  while (start > 0 && isCombining(text.charCodeAt(start))) start--
  return start
}

export const CharClass = { Space: 0, Word: 1, Other: 2 } as const
export type CharClass = (typeof CharClass)[keyof typeof CharClass]

const WORD_CHAR = /[\p{L}\p{N}_]/u

export function charClass(char: string, wordChars = ''): CharClass {
  if (char === ' ' || char === '\t') return CharClass.Space
  if (WORD_CHAR.test(char) || (wordChars && wordChars.includes(char))) return CharClass.Word
  return /\s/.test(char) ? CharClass.Space : CharClass.Other
}

/** Where Ctrl+Left lands from `index` within one line: before the previous word or run of punctuation. */
export function wordStartBefore(text: string, index: number, wordChars = ''): number {
  let pos = index
  while (pos > 0 && charClass(text[pos - 1], wordChars) === CharClass.Space) pos--
  if (pos === 0) return 0
  const kind = charClass(text[pos - 1], wordChars)
  while (pos > 0 && charClass(text[pos - 1], wordChars) === kind) pos--
  return pos
}

/** Where Ctrl+Right lands from `index` within one line: after the next word or run of punctuation. */
export function wordEndAfter(text: string, index: number, wordChars = ''): number {
  let pos = index
  while (pos < text.length && charClass(text[pos], wordChars) === CharClass.Space) pos++
  if (pos === text.length) return pos
  const kind = charClass(text[pos], wordChars)
  while (pos < text.length && charClass(text[pos], wordChars) === kind) pos++
  return pos
}

/** The word around `index` (touching it on either side), or null. */
export function wordAround(text: string, index: number, wordChars = ''): { from: number; to: number } | null {
  const isWord = (pos: number) => pos >= 0 && pos < text.length && charClass(text[pos], wordChars) === CharClass.Word
  if (!isWord(index) && !isWord(index - 1)) return null
  let from = index
  let to = index
  while (isWord(from - 1)) from--
  while (isWord(to)) to++
  return { from, to }
}

/** Characters below this many are counted one by one; past it, runs of plain characters are skipped natively. */
const RUN_FROM = 64
/** A run of characters that take one column each and start a cluster of their own: no tab, nothing past ASCII. */
const PLAIN_RUN = /[\x00-\x08\x0a-\x7e]+/y

/** How many plain characters start at `pos`, looking at no more than `limit` of them. */
function plainRun(text: string, pos: number, limit: number): number {
  const end = Math.min(text.length, pos + limit)
  const subject = end === text.length ? text : text.slice(0, end)
  PLAIN_RUN.lastIndex = pos
  return PLAIN_RUN.test(subject) ? PLAIN_RUN.lastIndex - pos : 0
}

/** Columns from `pos` (at column `column`) to `end`, counted as `columnAt` counts them. */
function columnsFrom(text: string, pos: number, end: number, column: number, tabSize: number): number {
  for (; pos < end; pos++) {
    const code = text.charCodeAt(pos)
    if (code === 9) column += tabSize - (column % tabSize)
    else if (code < 0x7f) {
      if (end - pos <= RUN_FROM) column++
      else {
        const run = plainRun(text, pos, end - pos)
        column += run
        pos += run - 1
      }
    } else {
      const point = text.codePointAt(pos)!
      if (point > 0xffff) pos++
      column += codePointWidth(point)
    }
  }
  return column
}

/**
 * A long line's columns at points along it, so that a column is counted from the nearest point rather than from the
 * start. Each point is a cluster boundary (a character below U+0080 followed by one below U+0300, which
 * `nextCluster` never joins), so `indexAtColumn` can start from one too. A line with no such places gets none.
 */
interface ColumnIndex {
  readonly text: string
  readonly tabSize: number
  readonly offsets: Float64Array
  readonly columns: Float64Array
}

/** Lines and columns past this are counted through an index. */
const INDEX_FROM = 16_384
/** About this many characters between the points of an index. */
const INDEX_STEP = 1024
/** The indexes kept: the line being edited, and the version before. */
const INDEX_KEEP = 2
const indexes: ColumnIndex[] = []

/** Whether an index point can be at `pos`: see ColumnIndex. */
function isPoint(text: string, pos: number): boolean {
  return pos > 0 && pos < text.length && text.charCodeAt(pos - 1) < 0x80 && text.charCodeAt(pos) < 0x300
}

/** Appends points from `pos` (a point, at `column`) to before `limit`, about INDEX_STEP apart; returns the last. */
function addPoints(text: string, pos: number, column: number, limit: number, tabSize: number, offsets: number[], columns: number[]): { pos: number; column: number } {
  for (let target = pos + INDEX_STEP; target < limit; target += INDEX_STEP) {
    if (target <= pos) continue
    const stop = Math.min(limit, target + INDEX_STEP)
    let point = target
    while (point < stop && !isPoint(text, point)) point++
    if (point >= stop) continue
    column = columnsFrom(text, pos, point, column, tabSize)
    pos = point
    offsets.push(point)
    columns.push(column)
  }
  return { pos, column }
}

function keep(index: ColumnIndex): ColumnIndex {
  indexes.unshift(index)
  indexes.length = Math.min(indexes.length, INDEX_KEEP)
  return index
}

function columnIndex(text: string, tabSize: number): ColumnIndex {
  for (let at = 0; at < indexes.length; at++) {
    const index = indexes[at]
    if (index.tabSize === tabSize && index.text.length === text.length && index.text === text) {
      if (at > 0) indexes.unshift(...indexes.splice(at, 1))
      return index
    }
  }
  const offsets = [0]
  const columns = [0]
  addPoints(text, 0, 0, text.length, tabSize, offsets, columns)
  return keep({ text, tabSize, offsets: Float64Array.from(offsets), columns: Float64Array.from(columns) })
}

/**
 * The index of `before` made into one of `after`, which is `before` with [from, to) replaced by the text that ends at
 * `end` in it: points before the edit are kept, the edit is counted again, and the points after it move with it. A
 * tab after the edit can take up the shift (it reaches the same tab stop), so the columns after it are moved by
 * what they are at the first point past that tab, which is counted too.
 */
function carry(index: ColumnIndex, after: string, from: number, to: number, end: number): ColumnIndex {
  const { offsets, columns, tabSize } = index
  const delta = end - to
  // The points before the edit, the first (at 0) always.
  let kept = lastAtOrBelow(offsets, from - 1)
  if (offsets[kept] >= from) kept = 0
  const newOffsets = Array.from(offsets.subarray(0, kept + 1))
  const newColumns = Array.from(columns.subarray(0, kept + 1))
  const tab = after.indexOf('\t', end)
  const past = tab === -1 ? end : tab
  // The first old point past the edit, and past that tab, in the new text.
  let next = kept + 1
  while (next < offsets.length && (offsets[next] <= to || offsets[next] + delta <= past)) next++
  const limit = next < offsets.length ? offsets[next] + delta : after.length
  const last = addPoints(after, newOffsets[kept], newColumns[kept], limit, tabSize, newOffsets, newColumns)
  if (next < offsets.length) {
    const shift = columnsFrom(after, last.pos, limit, last.column, tabSize) - columns[next]
    for (; next < offsets.length; next++) {
      newOffsets.push(offsets[next] + delta)
      newColumns.push(columns[next] + shift)
    }
  }
  return { text: after, tabSize, offsets: Float64Array.from(newOffsets), columns: Float64Array.from(newColumns) }
}

/**
 * Carries the indexes kept for long lines across an edit, so that typing in a line of millions of characters does not
 * count it again from the start. Lines edited in more than one place, or split or joined, are counted again when
 * they are next asked about.
 */
export function carryColumnIndexes(changes: ChangeSet, before: Text, after: Text): void {
  if (!indexes.length) return
  const edits = new Map<number, { line: Line; from: number; to: number; insertFrom: number; end: number } | null>()
  changes.forEach((fromA, toA, fromB, toB, insert) => {
    const line = before.lineAt(fromA)
    if (line.text.length < INDEX_FROM) return
    const single = toA <= line.to && !insert.includes('\n')
    edits.set(line.number, single && !edits.has(line.number) ? { line, from: fromA, to: toA, insertFrom: fromB, end: toB } : null)
  })
  for (const edit of edits.values()) {
    if (!edit) continue
    const { line } = edit
    const now = after.lineAt(edit.insertFrom)
    for (let at = 0; at < indexes.length; at++) {
      const index = indexes[at]
      if (index.text !== line.text) continue
      keep(carry(index, now.text, edit.from - line.from, edit.to - line.from, edit.end - now.from))
      break
    }
  }
}

/** Lets go of the long lines kept for counting columns, as an editor that closes does. */
export function forgetColumnIndexes(): void {
  indexes.length = 0
}

/** The last entry of an ascending array at or below `value`; the array starts at or below every value asked for. */
function lastAtOrBelow(values: Float64Array, value: number): number {
  let low = 0
  let high = values.length - 1
  while (low < high) {
    const mid = (low + high + 1) >>> 1
    if (values[mid] <= value) low = mid
    else high = mid - 1
  }
  return low
}

/**
 * Visual column of `index` in a line, with tabs at multiples of `tabSize` and wide characters as two. In a long line
 * (a minified file) runs of plain characters are counted at once, and counting starts from an indexed point near
 * `index`.
 */
export function columnAt(text: string, index: number, tabSize: number): number {
  const end = Math.min(index, text.length)
  if (end < INDEX_FROM) return columnsFrom(text, 0, end, 0, tabSize)
  const { offsets, columns } = columnIndex(text, tabSize)
  const at = lastAtOrBelow(offsets, end)
  return columnsFrom(text, offsets[at], end, columns[at], tabSize)
}

/** The offset in a line nearest to visual `column`, on a cluster boundary. */
export function indexAtColumn(text: string, column: number, tabSize: number): number {
  let current = 0
  let pos = 0
  if (column >= INDEX_FROM && text.length >= INDEX_FROM) {
    // Every cluster before an indexed point ends at or before the point's column, so the walk below would reach it.
    const { offsets, columns } = columnIndex(text, tabSize)
    const at = lastAtOrBelow(columns, column)
    pos = offsets[at]
    current = columns[at]
  }
  while (pos < text.length) {
    if (column - current > RUN_FROM) {
      // All but the last of a run of plain characters are clusters of one column each (the last may take a mark).
      const skip = Math.min(plainRun(text, pos, column - current + 1) - 1, column - current)
      if (skip > 0) {
        pos += skip
        current += skip
        continue
      }
    }
    const next = nextCluster(text, pos)
    const code = text.charCodeAt(pos)
    const width = code === 9 ? tabSize - (current % tabSize) : columnsFrom(text, pos, next, 0, tabSize)
    if (current + width > column) return column - current <= current + width - column ? pos : next
    current += width
    pos = next
  }
  return text.length
}

export function leadingWhitespace(text: string): string {
  let end = 0
  while (end < text.length && (text[end] === ' ' || text[end] === '\t')) end++
  return text.slice(0, end)
}

/** Indentation of a whitespace string in columns. */
export function indentWidth(whitespace: string, tabSize: number): number {
  return columnAt(whitespace, whitespace.length, tabSize)
}

/** Whitespace for `width` columns, in tabs when the indent unit is a tab. */
export function makeIndent(width: number, indentUnit: string, tabSize: number): string {
  if (indentUnit === '\t') return '\t'.repeat(Math.floor(width / tabSize)) + ' '.repeat(width % tabSize)
  return ' '.repeat(Math.max(0, width))
}

/** Columns one indentation level takes. */
export function unitWidth(indentUnit: string, tabSize: number): number {
  return indentUnit === '\t' ? tabSize : indentUnit.length
}
