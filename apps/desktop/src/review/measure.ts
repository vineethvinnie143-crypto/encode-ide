/**
 * How wide a line of code is drawn, in columns of the monospace font: tabs go to the next stop and wide characters
 * (CJK, emoji) take two. The Review tab sizes its rows from this rather than by measuring each one, so a review of
 * any length scrolls without reflowing.
 */

export const TAB_SIZE = 4

/** Code points drawn two columns wide, as [first, last]. Kept as numbers so the source holds no such characters. */
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd],
]

function isWide(code: number): boolean {
  if (code < 0x1100) return false
  for (const [first, last] of WIDE_RANGES) if (code >= first && code <= last) return true
  return false
}

/** The columns a line takes. */
export function columnsOf(text: string): number {
  let column = 0
  for (const char of text) {
    if (char === '\t') column += TAB_SIZE - (column % TAB_SIZE)
    else column += isWide(char.codePointAt(0)!) ? 2 : 1
  }
  return column
}

/** Text with its tabs turned into spaces up to the next stop, starting at `column`; returns the column after it too. */
export function expandTabs(text: string, column: number): { text: string; column: number } {
  if (!text.includes('\t')) return { text, column: column + columnsOf(text) }
  let out = ''
  let at = column
  for (const char of text) {
    if (char === '\t') {
      const width = TAB_SIZE - (at % TAB_SIZE)
      out += ' '.repeat(width)
      at += width
    } else {
      out += char
      at += isWide(char.codePointAt(0)!) ? 2 : 1
    }
  }
  return { text: out, column: at }
}

/** Visual lines a line wraps to in `columns` columns; at least one. */
export function wrappedLines(width: number, columns: number): number {
  if (columns <= 0 || width <= columns) return 1
  return Math.ceil(width / columns)
}
