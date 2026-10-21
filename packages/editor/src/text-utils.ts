import { codePointWidth } from '@encode/text'

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
  if (char === ' ' || char === '\t' || char === ' ' || char === '　') return CharClass.Space
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

/** Visual column of `index` in a line, with tabs at multiples of `tabSize` and wide characters as two. */
export function columnAt(text: string, index: number, tabSize: number): number {
  let column = 0
  for (let pos = 0; pos < index && pos < text.length; pos++) {
    const code = text.charCodeAt(pos)
    if (code === 9) column += tabSize - (column % tabSize)
    else if (code < 0x7f) column++
    else {
      const point = text.codePointAt(pos)!
      if (point > 0xffff) pos++
      column += codePointWidth(point)
    }
  }
  return column
}

/** The offset in a line nearest to visual `column`, on a cluster boundary. */
export function indexAtColumn(text: string, column: number, tabSize: number): number {
  let current = 0
  let pos = 0
  while (pos < text.length) {
    const next = nextCluster(text, pos)
    const code = text.charCodeAt(pos)
    const width = code === 9 ? tabSize - (current % tabSize) : columnAt(text.slice(pos, next), next - pos, tabSize)
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
