import type { ChangeSet, Text } from '@encode/text'
import { indentWidth, leadingWhitespace } from './text-utils'

/**
 * A part of a document that can be folded: `start` stays shown, the lines after it up to `end` (1-based, inclusive)
 * are hidden. A closing bracket on a line of its own after the block is not part of it, so it stays in sight.
 */
export interface FoldRange {
  readonly start: number
  readonly end: number
  /** What a language server said the range is; regions also come from `#region` markers. */
  readonly kind?: 'comment' | 'imports' | 'region'
}

/** Lines a range found by indentation is followed for; past it the block is taken as ending there. */
const MAX_BLOCK_LINES = 200_000
/** Lines looked back over for the blocks a line is in. */
const MAX_LOOK_BACK = 10_000
/** The most ranges a whole document is read into. */
export const MAX_FOLD_RANGES = 10_000

// "#region", "// #region", "<!-- #region -->", "-- #region", "/* #region */", "# region" and the like, with "endregion"
// to close. A marker needs a comment (or C#'s directive) in front, so `region = 5` in Python is no marker.
const REGION_START = /^\s*(?:(?:\/\/|--|<!--|\/\*|;|')\s*#?|#\s*(?:pragma\s+)?)region\b/
const REGION_END = /^\s*(?:(?:\/\/|--|<!--|\/\*|;|')\s*#?|#\s*(?:pragma\s+)?)end\s?region\b/

export function isRegionStart(text: string): boolean {
  return REGION_START.test(text)
}

export function isRegionEnd(text: string): boolean {
  return REGION_END.test(text)
}

/** A line's indentation in columns, or -1 for a line with nothing but whitespace. */
export function lineIndent(text: string, tabSize: number): number {
  const lead = leadingWhitespace(text)
  return lead.length === text.length ? -1 : indentWidth(lead, tabSize)
}

/**
 * The range that starts on `line`, found from the text alone: a region marker's region, or the block of lines more
 * indented than it. Only the lines after it are read, so this is cheap for the lines on screen.
 */
export function foldRangeAt(doc: Text, line: number, tabSize: number): FoldRange | null {
  if (line < 1 || line >= doc.lineCount) return null
  const text = doc.line(line).text
  if (isRegionStart(text)) {
    let depth = 0
    const last = Math.min(doc.lineCount, line + MAX_BLOCK_LINES)
    for (let number = line + 1; number <= last; number++) {
      const next = doc.line(number).text
      if (isRegionStart(next)) depth++
      else if (isRegionEnd(next)) {
        if (depth === 0) return { start: line, end: number, kind: 'region' }
        depth--
      }
    }
    // A region left open is folded by its indentation, as any other line.
  }
  const indent = lineIndent(text, tabSize)
  if (indent < 0) return null
  const last = Math.min(doc.lineCount, line + MAX_BLOCK_LINES)
  let end = -1
  for (let number = line + 1; number <= last; number++) {
    const width = lineIndent(doc.line(number).text, tabSize)
    if (width < 0) continue
    if (width <= indent) break
    end = number
  }
  return end > line ? { start: line, end } : null
}

/**
 * Every range of the document by indentation and region markers, ordered by start, at most `limit`. One pass with a
 * stack each, for folding everything, a level, or every region at once.
 */
export function allFoldRanges(doc: Text, tabSize: number, limit = MAX_FOLD_RANGES): FoldRange[] {
  const out: FoldRange[] = []
  // Lines whose block is still open, with their indentation, innermost last.
  const open: { line: number; indent: number }[] = []
  const regions: number[] = []
  let lastText = 0
  const close = (until: number) => {
    // Every open block at or deeper than `until` ends on the last line with text before this one.
    while (open.length && open[open.length - 1].indent >= until) {
      const block = open.pop()!
      if (lastText > block.line) out.push({ start: block.line, end: lastText })
    }
  }
  let number = 0
  for (const text of doc.lineTexts()) {
    number++
    if (isRegionStart(text)) regions.push(number)
    else if (isRegionEnd(text) && regions.length) {
      const start = regions.pop()!
      if (number > start) out.push({ start, end: number, kind: 'region' })
    }
    const indent = lineIndent(text, tabSize)
    if (indent < 0) continue
    close(indent)
    open.push({ line: number, indent })
    lastText = number
  }
  close(-1)
  out.sort((a, b) => a.start - b.start || b.end - a.end)
  // An indentation block that is also a region is listed once, as the region.
  const unique: FoldRange[] = []
  for (const range of out) {
    const previous = unique[unique.length - 1]
    if (previous && previous.start === range.start) {
      if (range.kind === 'region' && !previous.kind) unique[unique.length - 1] = range
      continue
    }
    unique.push(range)
    if (unique.length >= limit) break
  }
  return unique
}

/**
 * The ranges found by indentation that `line` is in, outermost first, each starting above it: what sticky scroll pins
 * at the top. A blank line counts as part of the block of the next line with text.
 */
export function enclosingIndentRanges(doc: Text, line: number, tabSize: number, max = 8): FoldRange[] {
  if (line < 1 || line > doc.lineCount) return []
  let reference = line
  let indent = lineIndent(doc.line(line).text, tabSize)
  while (indent < 0 && reference < doc.lineCount) indent = lineIndent(doc.line(++reference).text, tabSize)
  if (indent <= 0) return []
  const headers: number[] = []
  const first = Math.max(1, line - MAX_LOOK_BACK)
  for (let number = line - 1; number >= first && indent > 0; number--) {
    const width = lineIndent(doc.line(number).text, tabSize)
    if (width < 0 || width >= indent) continue
    headers.push(number)
    indent = width
  }
  const out: FoldRange[] = []
  for (const header of headers.reverse()) {
    const range = foldRangeAt(doc, header, tabSize)
    if (range && range.end >= line) out.push(range)
  }
  return out.slice(-max)
}

/** Ranges a language server gave (0-based lines), as fold ranges: in the document, ending below their start, sorted. */
export function normalizeFoldRanges(
  doc: Text,
  ranges: readonly { startLine: number; endLine: number; endCharacter?: number; kind?: string }[],
  limit = MAX_FOLD_RANGES,
): FoldRange[] {
  const out: FoldRange[] = []
  for (const range of ranges) {
    if (!Number.isInteger(range.startLine) || !Number.isInteger(range.endLine)) continue
    const start = range.startLine + 1
    let end = Math.min(doc.lineCount, range.endLine + 1)
    if (start < 1 || start > doc.lineCount) continue
    // A range that ends just past a closing bracket at the start of its last line leaves that line out, so the
    // bracket stays in sight below the folded block (servers that fold whole lines already do this themselves).
    if (range.endCharacter !== undefined && end > start && end <= doc.lineCount) {
      const before = doc.line(end).text.slice(0, range.endCharacter)
      if (/^\s*[)\]}]+;?$/.test(before)) end--
    }
    if (end <= start) continue
    const kind = range.kind === 'comment' || range.kind === 'imports' || range.kind === 'region' ? range.kind : undefined
    out.push(kind ? { start, end, kind } : { start, end })
  }
  out.sort((a, b) => a.start - b.start || b.end - a.end)
  const unique: FoldRange[] = []
  for (const range of out) {
    // One range per start line: the widest, which is the one a person means when folding there.
    if (unique.length && unique[unique.length - 1].start === range.start) continue
    unique.push(range)
    if (unique.length >= limit) break
  }
  return unique
}

/** The ranges, from a sorted list, that `line` is in or starts, outermost first. */
export function rangesContaining(ranges: readonly FoldRange[], line: number): FoldRange[] {
  const out: FoldRange[] = []
  // Ranges start in order; those starting after the line cannot hold it.
  let high = ranges.length
  let low = 0
  while (low < high) {
    const mid = (low + high) >>> 1
    if (ranges[mid].start <= line) low = mid + 1
    else high = mid
  }
  for (let index = 0; index < low; index++) if (ranges[index].end >= line) out.push(ranges[index])
  return out
}

/** The range that starts on `line` in a sorted list, or null. */
export function rangeStartingAt(ranges: readonly FoldRange[], line: number): FoldRange | null {
  let low = 0
  let high = ranges.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (ranges[mid].start < line) low = mid + 1
    else high = mid
  }
  return low < ranges.length && ranges[low].start === line ? ranges[low] : null
}

/** How deep each range is nested (1 for the outermost), in the order given; the list is sorted by start. */
export function foldDepths(ranges: readonly FoldRange[]): number[] {
  const depths: number[] = []
  const stack: number[] = []
  for (const range of ranges) {
    while (stack.length && stack[stack.length - 1] < range.start) stack.pop()
    stack.push(range.end)
    depths.push(stack.length)
  }
  return depths
}

/**
 * Folded blocks of `before`, moved through an edit to `doc`. A block whose hidden lines the edit touched is dropped (it
 * opens), as is one the edit emptied; typing at the very end of its first line leaves it folded.
 */
export function mapFolded(folded: readonly FoldRange[], changes: ChangeSet, before: Text, doc: Text): FoldRange[] {
  const out: FoldRange[] = []
  for (const fold of folded) {
    if (fold.start < 1 || fold.end <= fold.start || fold.end > before.lineCount) continue
    const startPos = before.line(fold.start).to
    const endPos = before.line(fold.end).to
    let touched = false
    changes.forEach((fromA, toA) => {
      if (toA > startPos && fromA <= endPos && !(fromA === toA && fromA === startPos)) touched = true
    })
    if (touched) continue
    const start = doc.lineAt(changes.mapPos(startPos, -1)).number
    const end = doc.lineAt(changes.mapPos(endPos, 1)).number
    if (end > start) out.push({ start, end })
  }
  return out
}

/** Foldable ranges (a language server's) moved through an edit until new ones come; a range the edit emptied is dropped. */
export function mapFoldRanges(ranges: readonly FoldRange[], changes: ChangeSet, before: Text, doc: Text): FoldRange[] {
  const out: FoldRange[] = []
  for (const range of ranges) {
    if (range.end > before.lineCount) continue
    const start = doc.lineAt(changes.mapPos(before.line(range.start).to, -1)).number
    const end = doc.lineAt(changes.mapPos(before.line(range.end).to, 1)).number
    if (end > start) out.push(range.kind ? { start, end, kind: range.kind } : { start, end })
  }
  out.sort((a, b) => a.start - b.start || b.end - a.end)
  return out
}
