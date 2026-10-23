/**
 * Word wrap: where a line breaks into rows, and how many rows each line of a document takes. A row counts its columns
 * from its own start (a tab reaches the next tab stop of the row), so where a row ends depends only on the text from
 * where it starts; that is what lets an edit in a long line break again only the rows it reaches.
 */
import { columnAt, nextCluster } from '@encode/editor'
import type { ChangeSet, Text } from '@encode/text'

export interface WrapSpec {
  /** Columns in a row. */
  readonly width: number
  readonly tabSize: number
  /** Rows after the first are indented as the line is (unless that takes more than half the width). */
  readonly indent: boolean
}

export interface LineWrap {
  /** Offsets where the rows after the first start, ascending; empty when the line fits on one row. */
  readonly breaks: readonly number[]
  /** Columns the rows after the first are indented by. */
  readonly indent: number
}

const NONE: LineWrap = { breaks: [], indent: 0 }

/** The fewest columns a row is given, however narrow the editor. */
export const MIN_WRAP_WIDTH = 8

/** The row of a wrapped line that `offset` is in; at a break, the row before it when `assoc` is -1. */
export function rowOf(wrap: LineWrap, offset: number, assoc?: -1 | 1): number {
  const breaks = wrap.breaks
  let low = 0
  let high = breaks.length
  // The number of breaks at or before offset (before it, for the end of a row).
  while (low < high) {
    const mid = (low + high) >>> 1
    if (assoc === -1 ? breaks[mid] < offset : breaks[mid] <= offset) low = mid + 1
    else high = mid
  }
  return low
}

/** Where row `row` of a wrapped line starts. */
export function rowStart(wrap: LineWrap, row: number): number {
  return row <= 0 ? 0 : wrap.breaks[Math.min(row, wrap.breaks.length) - 1]
}

/** Where row `row` of a wrapped line of `length` ends: where the next row starts, or the line's end. */
export function rowEnd(wrap: LineWrap, row: number, length: number): number {
  return row < wrap.breaks.length ? wrap.breaks[row] : length
}

export function sameSpec(a: WrapSpec, b: WrapSpec): boolean {
  return a.width === b.width && a.tabSize === b.tabSize && a.indent === b.indent
}

/** Character classes below U+0080: a break may come after these, or before these. */
const AFTER = 1
const BEFORE = 2
const CLASSES = new Uint8Array(128)
for (const char of ' \t})]?|/&.,;:!%>-') CLASSES[char.charCodeAt(0)] |= AFTER
for (const char of '([{<+') CLASSES[char.charCodeAt(0)] |= BEFORE

function breaksAfter(code: number): boolean {
  return code < 128 && (CLASSES[code] & AFTER) !== 0
}

function breaksBefore(code: number): boolean {
  return code < 128 && (CLASSES[code] & BEFORE) !== 0
}

/** Leading spaces and tabs: where they end and the columns they take. */
function leadOf(text: string, tabSize: number): { end: number; columns: number } {
  let column = 0
  let pos = 0
  for (; pos < text.length; pos++) {
    const code = text.charCodeAt(pos)
    if (code === 32) column++
    else if (code === 9) column += tabSize - (column % tabSize)
    else break
  }
  return { end: pos, columns: column }
}

/** A character that is not printable ASCII (a tab, a control, anything past U+007E). */
const NOT_PLAIN = /[^\x20-\x7e]/g

/**
 * The first character at or after `from` that is not printable ASCII, or the line's length: before it, every character
 * is a cluster of one column.
 */
function plainUntil(text: string, from: number): number {
  NOT_PLAIN.lastIndex = from
  const found = NOT_PLAIN.exec(text)
  return found ? found.index : text.length
}

/**
 * Where `text` breaks into rows of `spec.width` columns. Rows break after a space or a mark that ends a word (a comma,
 * a closing bracket, a slash), before an opening bracket, or around a wide character; a word longer than a row is cut
 * between characters. Spaces at a row's end stay on it, so a row after a break starts with what was after them. Never
 * inside a cluster.
 */
export function wrapLine(text: string, spec: WrapSpec): LineWrap {
  const width = Math.max(MIN_WRAP_WIDTH, Math.floor(spec.width))
  // A line that cannot take more columns than it has characters times the widest a character gets fits at once.
  if (text.length * Math.max(2, spec.tabSize) <= width) return NONE
  const lead = leadOf(text, spec.tabSize)
  // So does plain text whose columns are its characters, after the indentation.
  const impure = plainUntil(text, 0)
  const tail = impure >= lead.end ? impure : plainUntil(text, lead.end)
  if (tail === text.length && lead.columns + text.length - lead.end <= width) return NONE
  const indent = spec.indent && lead.columns <= width / 2 ? lead.columns : 0
  const { breaks } = wrapFrom(text, 0, true, indent, spec, () => -1, impure)
  return breaks.length ? { breaks, indent } : NONE
}

/** Columns the rows after the first are indented by. */
function indentOf(text: string, spec: WrapSpec): number {
  if (!spec.indent) return 0
  const indent = leadOf(text, spec.tabSize).columns
  return indent > Math.max(MIN_WRAP_WIDTH, Math.floor(spec.width)) / 2 ? 0 : indent
}

/**
 * The breaks of `after`, which is `before` (broken as `wrap`) with [from, to) replaced by text ending at `end`: the
 * rows before the one ahead of the edit are kept, the rest are broken again until a row starts where one did before
 * (moved by the edit), and the rows after that are moved with it.
 */
export function rewrapLine(before: LineWrap, after: string, from: number, to: number, end: number, spec: WrapSpec): LineWrap {
  const old = before.breaks
  // A line of a few rows, or an edit to the indentation, is broken from the start.
  if (old.length < 4 || from <= leadOf(after, spec.tabSize).end || indentOf(after, spec) !== before.indent) return wrapLine(after, spec)
  // The row the edit is in, and the one before it (an edit can let a word move up a row).
  let row = 0
  while (row < old.length && old[row] <= from) row++
  const keep = Math.max(0, row - 2)
  const delta = end - to
  const start = keep === 0 ? 0 : old[keep - 1]
  const breaks = old.slice(0, keep)
  // Rows from here on are the old ones moved, once a row starts past the edit where an old one did.
  const tail = wrapFrom(after, start, keep === 0, before.indent, spec, (at) => (at <= end ? -1 : indexOf(old, at - delta)))
  breaks.push(...tail.breaks)
  if (tail.resumed >= 0) for (let index = tail.resumed + 1; index < old.length; index++) breaks.push(old[index] + delta)
  return breaks.length ? { breaks, indent: before.indent } : NONE
}

/** Index of `value` in ascending `values`, or -1. */
function indexOf(values: readonly number[], value: number): number {
  let low = 0
  let high = values.length - 1
  while (low <= high) {
    const mid = (low + high) >>> 1
    if (values[mid] === value) return mid
    if (values[mid] < value) low = mid + 1
    else high = mid - 1
  }
  return -1
}

/**
 * Breaks `text` from `start` (the start of the first row when `first`), as `wrapLine` would; `resume(at)` is asked at
 * each break and stops the walk when it gives an index of the old breaks to carry on from. `impure`, when known, is
 * `plainUntil(text, start)`.
 */
function wrapFrom(
  text: string,
  start: number,
  first: boolean,
  indent: number,
  spec: WrapSpec,
  resume: (at: number) => number,
  impure = -1,
): { breaks: number[]; resumed: number } {
  const width = Math.max(MIN_WRAP_WIDTH, Math.floor(spec.width))
  const rest = Math.max(MIN_WRAP_WIDTH, width - indent)
  const breaks: number[] = []
  let rowStart = start
  let rowWidth = first ? width : rest
  for (;;) {
    // A row of plain text is measured in one step; any other is walked a cluster at a time.
    if (impure < rowStart) impure = plainUntil(text, rowStart)
    const reach = Math.min(text.length, rowStart + rowWidth * 2 + 1)
    const at = impure >= reach ? plainBreak(text, rowStart, rowWidth) : nextBreak(text, rowStart, rowWidth, spec.tabSize)
    if (at < 0) return { breaks, resumed: -1 }
    breaks.push(at)
    const resumed = resume(at)
    if (resumed >= 0) return { breaks, resumed }
    rowStart = at
    rowWidth = rest
  }
}

/**
 * Where the row starting at `rowStart` ends, when every character up to twice its width past it is plain: the first
 * character that does not fit (spaces hang past the edge up to a second row's width), or the last place before it that
 * a break may come. -1 when the rest of the line fits.
 */
function plainBreak(text: string, rowStart: number, rowWidth: number): number {
  const hang = rowStart + rowWidth * 2
  let over = rowStart + rowWidth
  while (over < hang && over < text.length && text.charCodeAt(over) === 32) over++
  if (over >= text.length) return -1
  for (let at = over; at > rowStart; at--) {
    if (breaksBefore(text.charCodeAt(at)) || breaksAfter(text.charCodeAt(at - 1))) return at
  }
  return over
}

/** As `plainBreak`, for any text: a cluster at a time, a tab reaching the row's next tab stop. */
function nextBreak(text: string, rowStart: number, rowWidth: number, tabSize: number): number {
  let column = 0
  let opportunity = -1
  let pos = rowStart
  while (pos < text.length) {
    const code = text.charCodeAt(pos)
    const following = pos + 1 < text.length ? text.charCodeAt(pos + 1) : 0
    let next: number
    let cells: number
    if (code === 9) {
      next = pos + 1
      cells = tabSize - (column % tabSize)
    } else if (code < 0x7f && following < 0x300) {
      next = pos + 1
      cells = 1
    } else {
      next = nextCluster(text, pos)
      cells = columnAt(text.slice(pos, next), next - pos, tabSize)
    }
    const wide = cells > 1 && code !== 9
    if (pos > rowStart && (breaksBefore(code) || wide)) opportunity = pos
    const space = code === 32 || code === 9
    if (pos > rowStart && column + cells > rowWidth && (!space || column + cells > rowWidth * 2)) {
      return opportunity > rowStart ? opportunity : pos
    }
    column += cells
    if (breaksAfter(code) || wide) opportunity = next
    pos = next
  }
  return -1
}

/** Lines per chunk of a RowMap as it is built; a chunk is split once edits make it twice that. */
const CHUNK = 1024

/**
 * How many rows each line of a document takes, kept in chunks of lines with the lines and rows of each chunk summed, so
 * that the rows above a line are counted in a few steps however long the document, and lines can be replaced as the
 * text is edited without going over the rest.
 */
export class RowMap {
  private chunks: number[][] = []
  private rowSums: number[] = []
  /** Rows before each line of a chunk, counted when first needed after the chunk changed. */
  private prefixes: (Float64Array | null)[] = []
  /** Lines before each chunk, rebuilt after lines come or go; rows before each chunk, rebuilt after any change. */
  private lineStarts: Float64Array | null = null
  private rowStarts: Float64Array | null = null
  private count = 0
  /** Goes up with every change, so a layout made from the map knows when it is out of date. */
  version = 0

  /** `rows[i]` rows for line i + 1. */
  constructor(rows: ArrayLike<number> = [1]) {
    const all = Array.from(rows)
    for (let start = 0; start < all.length; start += CHUNK) this.chunks.push(all.slice(start, start + CHUNK))
    if (!this.chunks.length) this.chunks.push([1])
    this.rowSums = this.chunks.map(sum)
    this.prefixes = this.chunks.map(() => null)
    this.count = Math.max(1, all.length)
  }

  get lineCount(): number {
    return this.count
  }

  /** Rows of all the lines. */
  get total(): number {
    return this.rowIndex()[this.chunks.length]
  }

  /** Rows of line `line` (1-based). */
  rows(line: number): number {
    const chunk = this.chunkOf(line)
    return this.chunks[chunk][line - 1 - this.lineIndex()[chunk]]
  }

  /** Rows of the lines before line `line`; `lineCount + 1` gives all of them. */
  before(line: number): number {
    if (line <= 1) return 0
    if (line > this.count) return this.total
    const chunk = this.chunkOf(line)
    return this.rowIndex()[chunk] + this.prefix(chunk)[line - 1 - this.lineIndex()[chunk]]
  }

  /** The line holding row `row` (0-based, counted over all lines) and the row within it. */
  lineAtRow(row: number): { line: number; row: number } {
    const rowStarts = this.rowIndex()
    if (row <= 0) return { line: 1, row: 0 }
    if (row >= rowStarts[this.chunks.length]) return { line: this.count, row: this.rows(this.count) - 1 }
    const chunk = lastAtOrBelow(rowStarts, row, this.chunks.length - 1)
    const prefix = this.prefix(chunk)
    const within = row - rowStarts[chunk]
    const at = lastAtOrBelow(prefix, within, this.chunks[chunk].length - 1)
    return { line: this.lineIndex()[chunk] + at + 1, row: within - prefix[at] }
  }

  /** Sets the rows of line `line`: the lines stay where they are, so only the rows before each chunk are counted again. */
  set(line: number, rows: number): void {
    const chunk = this.chunkOf(line)
    const list = this.chunks[chunk]
    const at = line - 1 - this.lineIndex()[chunk]
    if (list[at] === rows) return
    this.rowSums[chunk] += rows - list[at]
    list[at] = rows
    this.prefixes[chunk] = null
    this.rowStarts = null
    this.version++
  }

  /** Replaces lines `from`..`to` (1-based, inclusive; `to = from - 1` inserts before `from`) with lines of these rows. */
  replace(from: number, to: number, rows: readonly number[]): void {
    const removed = to - from + 1
    if (removed === rows.length) {
      for (let index = 0; index < rows.length; index++) this.set(from + index, rows[index])
      return
    }
    // The chunks the lines are in are joined, spliced, and cut again into chunks of CHUNK lines.
    const first = this.chunkOf(Math.min(from, this.count))
    const last = removed > 0 ? this.chunkOf(to) : first
    const offset = this.lineIndex()[first]
    const joined: number[] = []
    for (let chunk = first; chunk <= last; chunk++) for (const value of this.chunks[chunk]) joined.push(value)
    joined.splice(from - 1 - offset, removed, ...rows)
    const pieces: number[][] = []
    const size = joined.length <= CHUNK * 2 ? Math.max(1, joined.length) : CHUNK
    for (let start = 0; start < joined.length; start += size) pieces.push(joined.slice(start, start + size))
    this.chunks.splice(first, last - first + 1, ...pieces)
    this.rowSums.splice(first, last - first + 1, ...pieces.map(sum))
    this.prefixes.splice(first, last - first + 1, ...pieces.map(() => null))
    if (!this.chunks.length) {
      this.chunks.push([1])
      this.rowSums.push(1)
      this.prefixes.push(null)
    }
    this.count += rows.length - removed
    this.lineStarts = null
    this.rowStarts = null
    this.version++
  }

  /** The chunk line `line` is in. */
  private chunkOf(line: number): number {
    return lastAtOrBelow(this.lineIndex(), line - 1, this.chunks.length - 1)
  }

  /** Rows before each line of chunk `chunk`, within it. */
  private prefix(chunk: number): Float64Array {
    let prefix = this.prefixes[chunk]
    if (!prefix) {
      const rows = this.chunks[chunk]
      prefix = new Float64Array(rows.length)
      for (let at = 1; at < rows.length; at++) prefix[at] = prefix[at - 1] + rows[at - 1]
      this.prefixes[chunk] = prefix
    }
    return prefix
  }

  private lineIndex(): Float64Array {
    let lines = this.lineStarts
    if (!lines) {
      lines = new Float64Array(this.chunks.length + 1)
      for (let chunk = 0; chunk < this.chunks.length; chunk++) lines[chunk + 1] = lines[chunk] + this.chunks[chunk].length
      this.lineStarts = lines
    }
    return lines
  }

  private rowIndex(): Float64Array {
    let rows = this.rowStarts
    if (!rows) {
      rows = new Float64Array(this.chunks.length + 1)
      for (let chunk = 0; chunk < this.chunks.length; chunk++) rows[chunk + 1] = rows[chunk] + this.rowSums[chunk]
      this.rowStarts = rows
    }
    return rows
  }
}

function sum(values: readonly number[]): number {
  let total = 0
  for (const value of values) total += value
  return total
}

/** The last index at or below `limit` whose value is at or below `value`; values ascend. */
function lastAtOrBelow(values: Float64Array, value: number, limit: number): number {
  let low = 0
  let high = limit
  while (low < high) {
    const mid = (low + high + 1) >>> 1
    if (values[mid] <= value) low = mid
    else high = mid - 1
  }
  return low
}

/** A document up to this many characters is broken into rows at once; a larger one is estimated and then settled. */
export const SYNC_WRAP_CHARS = 2_000_000
/** Lines read at a time when a document is broken into rows. */
const WINDOW = 16_384
/** The cache of lines' breaks is emptied past this many lines, or this many characters of them. */
const CACHE_LINES = 4096
const CACHE_CHARS = 32_000_000

/** Rows of a line guessed from its length: what a large document starts from until its lines are broken. */
function estimate(text: string, width: number): number {
  return text.length <= width ? 1 : Math.ceil(text.length / width)
}

/**
 * The rows of a document's lines for one wrap width, kept through edits. A document of up to SYNC_WRAP_CHARS is broken
 * into rows at once; a larger one starts from rows guessed by length, and its lines are broken a stretch at a time
 * (`settle`) in idle time, or when they are drawn (`settleLine`). Lines' breaks are cached by their text.
 */
export class WrapLayout {
  readonly rows: RowMap
  /** Lines before this one have their real rows; past it some may still be guessed. */
  private settled: number
  private readonly cache = new Map<string, LineWrap>()
  private cachedChars = 0

  private readonly syncChars: number
  private readonly stretch: number

  /**
   * @param options.syncChars A document up to this long is broken into rows at once; so are edits of up to this much text.
   * @param options.stretch Lines settled between looks at the clock.
   */
  constructor(readonly spec: WrapSpec, doc: Text, options: { syncChars?: number; stretch?: number } = {}) {
    this.syncChars = options.syncChars ?? SYNC_WRAP_CHARS
    this.stretch = options.stretch ?? 1024
    const exact = doc.length <= this.syncChars
    const width = Math.max(MIN_WRAP_WIDTH, Math.floor(spec.width))
    const rows = new Array<number>(doc.lineCount)
    for (let first = 1; first <= doc.lineCount; first += WINDOW) {
      const texts = doc.lineTexts(first, Math.min(doc.lineCount, first + WINDOW - 1))
      for (let index = 0; index < texts.length; index++) {
        rows[first - 1 + index] = exact ? wrapLine(texts[index], spec).breaks.length + 1 : estimate(texts[index], width)
      }
    }
    this.rows = new RowMap(rows)
    this.settled = exact ? doc.lineCount + 1 : 1
  }

  /** Every line has its real rows. */
  get complete(): boolean {
    return this.settled > this.rows.lineCount
  }

  /** Lines before this one have their real rows. */
  get frontier(): number {
    return this.settled
  }

  /** The breaks of a line with this text. */
  wrap(text: string): LineWrap {
    let wrap = this.cache.get(text)
    if (!wrap) {
      wrap = wrapLine(text, this.spec)
      this.remember(text, wrap)
    }
    return wrap
  }

  private remember(text: string, wrap: LineWrap): void {
    if (this.cache.size >= CACHE_LINES || this.cachedChars + text.length > CACHE_CHARS) {
      this.cache.clear()
      this.cachedChars = 0
    }
    this.cache.set(text, wrap)
    this.cachedChars += text.length
  }

  /** Gives line `n` its real rows; true when they were not what the layout had, after calling `changing` first. */
  settleLine(n: number, text: string, changing?: () => void): boolean {
    const rows = this.wrap(text).breaks.length + 1
    if (this.rows.rows(n) === rows) return false
    changing?.()
    this.rows.set(n, rows)
    return true
  }

  /**
   * Breaks the lines still guessed, from where that stopped, until `deadline` (a `performance.now()` time). `changing`
   * is called once before the first line whose rows change. False once every line has its real rows.
   */
  settle(doc: Text, deadline: number, changing: () => void): boolean {
    let warned = false
    while (this.settled <= doc.lineCount) {
      const last = Math.min(doc.lineCount, this.settled + this.stretch - 1)
      const texts = doc.lineTexts(this.settled, last)
      for (let index = 0; index < texts.length; index++) {
        const n = this.settled + index
        const rows = wrapLine(texts[index], this.spec).breaks.length + 1
        if (this.rows.rows(n) === rows) continue
        if (!warned) {
          changing()
          warned = true
        }
        this.rows.set(n, rows)
      }
      this.settled = last + 1
      if (performance.now() > deadline) break
    }
    return !this.complete
  }

  /** Follows an edit from `before` to `after`: the lines it touched get their rows, the rest keep theirs. */
  update(changes: ChangeSet, before: Text, after: Text): void {
    // Changes that touch the same or neighbouring lines are taken together, from the last, so the lines before keep their numbers.
    const groups: { fromA: number; toA: number; fromB: number; toB: number; single: { from: number; to: number; end: number } | null }[] = []
    changes.forEach((fromA, toA, fromB, toB, insert) => {
      const a1 = before.lineAt(fromA).number
      const a2 = before.lineAt(toA).number
      const b1 = after.lineAt(fromB).number
      const b2 = after.lineAt(toB).number
      const last = groups[groups.length - 1]
      if (last && a1 <= last.toA) {
        last.toA = Math.max(last.toA, a2)
        last.toB = Math.max(last.toB, b2)
        last.single = null
        return
      }
      const line = before.line(a1)
      const single = a1 === a2 && !insert.includes('\n') ? { from: fromA - line.from, to: toA - line.from, end: toB - after.line(b1).from } : null
      groups.push({ fromA: a1, toA: a2, fromB: b1, toB: b2, single })
    })
    const width = Math.max(MIN_WRAP_WIDTH, Math.floor(this.spec.width))
    let budget = this.syncChars
    for (let index = groups.length - 1; index >= 0; index--) {
      const group = groups[index]
      const texts = after.lineTexts(group.fromB, group.toB)
      const rows: number[] = []
      let guessedFrom = -1
      if (group.single) {
        // One line edited in place: a long one is broken again only where the edit reaches.
        const old = before.line(group.fromA).text
        const known = this.cache.get(old)
        const now = texts[0]
        const wrap = known ? rewrapLine(known, now, group.single.from, group.single.to, group.single.end, this.spec) : wrapLine(now, this.spec)
        // The text it had is let go of, so typing in a long line does not keep every version of it.
        if (known) {
          this.cache.delete(old)
          this.cachedChars -= old.length
        }
        this.remember(now, wrap)
        rows.push(wrap.breaks.length + 1)
        budget -= now.length
      } else {
        for (let at = 0; at < texts.length; at++) {
          const text = texts[at]
          if (budget > 0) {
            rows.push(this.wrap(text).breaks.length + 1)
            budget -= text.length
          } else {
            if (guessedFrom < 0) guessedFrom = group.fromA + at
            rows.push(estimate(text, width))
          }
        }
      }
      this.rows.replace(group.fromA, group.toA, rows)
      // The line settling had reached moves with the edit; lines the edit left guessed are settled again. (Lines are
      // counted here as they are with the edits after this one made and those before it not yet.)
      const delta = group.toB - group.fromB - (group.toA - group.fromA)
      if (this.settled > group.toA) this.settled += delta
      else if (this.settled > group.fromA) this.settled = group.fromA + rows.length
      if (guessedFrom >= 0) this.settled = Math.min(this.settled, guessedFrom)
    }
  }
}

