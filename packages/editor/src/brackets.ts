import type { Text } from '@encode/text'
import type { Language } from './language'

/** Brackets further apart than this are not matched (keeps a keystroke cheap in a huge file). */
const MAX_SCAN = 20_000

/**
 * The offset of the bracket that closes (dir 1) or opens (dir -1) the
 * bracket pair at depth zero, scanning from `pos`; -1 when there is none
 * within the scan limit. `skip` can exclude offsets, such as brackets in
 * strings and comments.
 */
export function findMatching(
  doc: Text,
  pos: number,
  open: string,
  close: string,
  dir: 1 | -1,
  skip?: (offset: number) => boolean,
  maxScan = MAX_SCAN,
): number {
  let depth = 0
  let scanned = 0
  let line = doc.lineAt(pos)
  let index = pos - line.from
  for (;;) {
    if (dir > 0) {
      for (; index < line.text.length; index++) {
        if (++scanned > maxScan) return -1
        const char = line.text[index]
        if (char !== open && char !== close) continue
        if (skip?.(line.from + index)) continue
        if (char === open) depth++
        else if (depth === 0) return line.from + index
        else depth--
      }
      if (line.number === doc.lineCount) return -1
      line = doc.line(line.number + 1)
      index = 0
    } else {
      for (index--; index >= 0; index--) {
        if (++scanned > maxScan) return -1
        const char = line.text[index]
        if (char !== open && char !== close) continue
        if (skip?.(line.from + index)) continue
        if (char === close) depth++
        else if (depth === 0) return line.from + index
        else depth--
      }
      if (line.number === 1) return -1
      line = doc.line(line.number - 1)
      index = line.text.length
    }
  }
}

export interface BracketPair {
  /** The bracket next to the cursor. */
  at: number
  /** Its partner, or -1 when it has none. */
  match: number
}

/**
 * The bracket touching `pos` (after it first, then before it) and its
 * partner, for highlighting; null when no bracket touches the cursor.
 */
export function bracketAt(doc: Text, pos: number, language: Language, skip?: (offset: number) => boolean): BracketPair | null {
  const line = doc.lineAt(pos)
  for (const offset of [pos, pos - 1]) {
    if (offset < line.from || offset >= line.to) continue
    const char = line.text[offset - line.from]
    for (const [open, close] of language.brackets) {
      if (char !== open && char !== close) continue
      if (skip?.(offset)) continue
      const match =
        char === open ? findMatching(doc, offset + 1, open, close, 1, skip) : findMatching(doc, offset, open, close, -1, skip)
      return { at: offset, match }
    }
  }
  return null
}
