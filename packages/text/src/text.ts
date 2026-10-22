/**
 * eNCode's document model: an immutable sequence of lines.
 *
 * Lines live in leaves of at most LEAF_LINES lines (and about LEAF_CHARS
 * characters); a document is one array of leaves plus prefix sums of their
 * offsets and line numbers. An edit rebuilds only the leaves it touches and
 * shares the rest with the version it came from, so old versions stay cheap
 * to keep (undo, review baselines, the copy a language server has seen) and
 * a million-line document edits in microseconds.
 *
 * Offsets count UTF-16 code units, like JavaScript strings and the Language
 * Server Protocol. Only "\n" separates lines: a "\r" is ordinary text, so
 * callers convert CRLF files at the boundary where they read and write them.
 */

const LEAF_LINES = 256
const LEAF_CHARS = 16_384
/** Leaves below this many lines merge with a neighbour after an edit. */
const LEAF_MERGE = LEAF_LINES >> 2

class Leaf {
  readonly length: number
  private starts: Int32Array | null = null

  constructor(readonly lines: readonly string[]) {
    let length = lines.length - 1
    for (const line of lines) length += line.length
    this.length = length
  }

  /** Where each line starts, counted from the start of the leaf. */
  lineStarts(): Int32Array {
    if (!this.starts) {
      const starts = new Int32Array(this.lines.length)
      let offset = 0
      for (let index = 0; index < this.lines.length; index++) {
        starts[index] = offset
        offset += this.lines[index].length + 1
      }
      this.starts = starts
    }
    return this.starts
  }
}

/** Splits lines into leaves that respect both size limits. */
function chunk(lines: readonly string[]): Leaf[] {
  const leaves: Leaf[] = []
  let start = 0
  let chars = 0
  for (let index = 0; index < lines.length; index++) {
    const size = lines[index].length + 1
    if (index > start && (index - start >= LEAF_LINES || chars + size > LEAF_CHARS)) {
      leaves.push(new Leaf(lines.slice(start, index)))
      start = index
      chars = 0
    }
    chars += size
  }
  leaves.push(new Leaf(lines.slice(start)))
  return leaves
}

export interface Line {
  /** 1-based line number. */
  readonly number: number
  /** Offset of the line's first character. */
  readonly from: number
  /** Offset just past the line's last character, before its line break. */
  readonly to: number
  readonly text: string
}

export class Text {
  /** A document with one empty line. */
  static readonly empty: Text = new Text([new Leaf([''])])

  /** A document from a string (split on "\n") or from its lines. */
  static of(source: string | readonly string[]): Text {
    const lines = typeof source === 'string' ? source.split('\n') : source
    if (!lines.length) return Text.empty
    if (lines.length === 1 && lines[0] === '') return Text.empty
    return new Text(chunk(lines))
  }

  /** Length in UTF-16 code units, line breaks included. */
  readonly length: number
  /** Number of lines; never less than 1. */
  readonly lineCount: number
  /** Offset where each leaf starts. */
  private readonly leafFrom: Float64Array
  /** 0-based number of each leaf's first line. */
  private readonly leafLine: Float64Array

  private constructor(private readonly leaves: readonly Leaf[]) {
    const count = leaves.length
    this.leafFrom = new Float64Array(count)
    this.leafLine = new Float64Array(count)
    let offset = 0
    let line = 0
    for (let index = 0; index < count; index++) {
      this.leafFrom[index] = offset
      this.leafLine[index] = line
      offset += leaves[index].length + 1
      line += leaves[index].lines.length
    }
    this.length = offset - 1
    this.lineCount = line
  }

  /** The line that contains `pos`; a position on a line break belongs to the line it ends. */
  lineAt(pos: number): Line {
    this.checkPos(pos)
    const index = lastAtOrBefore(this.leafFrom, pos)
    const leaf = this.leaves[index]
    const starts = leaf.lineStarts()
    const local = lastAtOrBefore(starts, pos - this.leafFrom[index])
    const from = this.leafFrom[index] + starts[local]
    const text = leaf.lines[local]
    return { number: this.leafLine[index] + local + 1, from, to: from + text.length, text }
  }

  /** Line `n`, counted from 1. */
  line(n: number): Line {
    if (!Number.isInteger(n) || n < 1 || n > this.lineCount) {
      throw new RangeError(`Line ${n} is outside the document (1-${this.lineCount})`)
    }
    const index = lastAtOrBefore(this.leafLine, n - 1)
    const leaf = this.leaves[index]
    const local = n - 1 - this.leafLine[index]
    const from = this.leafFrom[index] + leaf.lineStarts()[local]
    const text = leaf.lines[local]
    return { number: n, from, to: from + text.length, text }
  }

  /** The text of lines `first` through `last` (1-based, inclusive). */
  lineTexts(first = 1, last = this.lineCount): string[] {
    if (first < 1 || last > this.lineCount || first > last + 1) {
      throw new RangeError(`Lines ${first}-${last} are outside the document (1-${this.lineCount})`)
    }
    const out: string[] = []
    if (first > last) return out
    let index = lastAtOrBefore(this.leafLine, first - 1)
    let local = first - 1 - this.leafLine[index]
    for (let n = first; n <= last; n++) {
      const leaf = this.leaves[index]
      out.push(leaf.lines[local])
      if (++local === leaf.lines.length) {
        index++
        local = 0
      }
    }
    return out
  }

  sliceString(from = 0, to = this.length): string {
    this.checkRange(from, to)
    if (from === to) return ''
    const start = this.lineAt(from)
    if (to <= start.to) return start.text.slice(from - start.from, to - start.from)
    const end = this.lineAt(to)
    const parts = this.lineTexts(start.number, end.number)
    parts[0] = parts[0].slice(from - start.from)
    parts[parts.length - 1] = parts[parts.length - 1].slice(0, to - end.from)
    return parts.join('\n')
  }

  toString(): string {
    // One flat join is several times faster than joining leaf by leaf.
    let all: string[] = []
    for (let index = 0; index < this.leaves.length; index += 4096) {
      all = all.concat(...this.leaves.slice(index, index + 4096).map((leaf) => leaf.lines))
    }
    return all.join('\n')
  }

  /** Replaces `from`–`to` with `insert`, returning the new document. */
  replace(from: number, to: number, insert: string | Text = ''): Text {
    this.checkRange(from, to)
    const lines = typeof insert === 'string' ? insert.split('\n') : insert.lineTexts()
    if (from === to && lines.length === 1 && lines[0] === '') return this
    const first = this.lineAt(from)
    const last = to <= first.to ? first : this.lineAt(to)
    lines[0] = first.text.slice(0, from - first.from) + lines[0]
    lines[lines.length - 1] += last.text.slice(to - last.from)
    return this.replaceLines(first.number - 1, last.number, lines)
  }

  /** True when both documents hold the same text. */
  eq(other: Text): boolean {
    if (other === this) return true
    if (other.length !== this.length || other.lineCount !== this.lineCount) return false
    const mine = this.lineTexts()
    const theirs = other.lineTexts()
    for (let index = 0; index < mine.length; index++) if (mine[index] !== theirs[index]) return false
    return true
  }

  /** Replaces 0-based lines [start, end) with `lines`. */
  private replaceLines(start: number, end: number, lines: string[]): Text {
    let lo = lastAtOrBefore(this.leafLine, start)
    let hi = lastAtOrBefore(this.leafLine, end - 1)
    const head = this.leaves[lo].lines.slice(0, start - this.leafLine[lo])
    const tail = this.leaves[hi].lines.slice(end - this.leafLine[hi])
    let combined = head.concat(lines, tail)
    // Fold a small result into a neighbour so edits do not leave a trail of tiny leaves.
    if (combined.length < LEAF_MERGE) {
      const next = this.leaves[hi + 1]
      const previous = this.leaves[lo - 1]
      if (next && next.lines.length + combined.length <= LEAF_LINES) {
        combined = combined.concat(next.lines)
        hi++
      } else if (previous && previous.lines.length + combined.length <= LEAF_LINES) {
        combined = previous.lines.concat(combined)
        lo--
      }
    }
    return new Text(this.leaves.slice(0, lo).concat(chunk(combined), this.leaves.slice(hi + 1)))
  }

  private checkPos(pos: number): void {
    if (!Number.isInteger(pos) || pos < 0 || pos > this.length) {
      throw new RangeError(`Position ${pos} is outside the document (0-${this.length})`)
    }
  }

  private checkRange(from: number, to: number): void {
    this.checkPos(from)
    this.checkPos(to)
    if (from > to) throw new RangeError(`Range ${from}-${to} is reversed`)
  }
}

/** Index of the last element <= `value` in an ascending array whose first element is <= `value`. */
function lastAtOrBefore(sorted: ArrayLike<number>, value: number): number {
  let lo = 0
  let hi = sorted.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (sorted[mid] <= value) lo = mid
    else hi = mid - 1
  }
  return lo
}
