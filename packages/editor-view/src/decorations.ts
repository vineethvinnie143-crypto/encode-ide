import type { ChangeSet, Text } from '@encode/text'

/** A range painted behind the text as a rectangle per line, styled by `className`. */
export interface MarkSpec {
  readonly from: number
  readonly to: number
  readonly className: string
}

/** A whole line, painted across the editor (a background) or marked in the gutter. */
export interface LineSpec {
  /** 1-based. */
  readonly line: number
  readonly className: string
}

/**
 * Something that decorates the document. The view asks each source for what
 * lies in the lines it is about to draw, so a source can be a fixed set
 * (diagnostics, review changes) or compute on demand (every match of a
 * search in a huge file).
 */
export interface DecorationSource {
  marks?(doc: Text, from: number, to: number, out: MarkSpec[]): void
  lines?(doc: Text, fromLine: number, toLine: number, out: LineSpec[]): void
  gutter?(doc: Text, fromLine: number, toLine: number, out: LineSpec[]): void
  /**
   * Follows a document change: the source for the new document, or null to
   * drop it. Sources without this are asked again at every draw.
   */
  map?(changes: ChangeSet, doc: Text): DecorationSource | null
}

export interface DecorationSpec {
  marks?: readonly MarkSpec[]
  /** Line backgrounds. */
  lines?: readonly LineSpec[]
  gutter?: readonly LineSpec[]
}

interface PositionedClass {
  readonly pos: number
  readonly className: string
}

/** A fixed set of decorations, kept sorted so a window of it is found by binary search. */
export class DecorationSet implements DecorationSource {
  private readonly froms: Int32Array
  private readonly tos: Int32Array
  private readonly classes: readonly string[]
  /** reach[i]: the largest `to` among marks 0..i, which lets a search skip everything that ends before a window. */
  private readonly reach: Int32Array

  private constructor(
    marks: readonly MarkSpec[],
    private readonly lineMarks: readonly PositionedClass[],
    private readonly gutterMarks: readonly PositionedClass[],
  ) {
    const sorted = marks.length > 1 && !isSortedByFrom(marks) ? stableSortMarks(marks) : marks
    this.froms = Int32Array.from(sorted, (mark) => mark.from)
    this.tos = Int32Array.from(sorted, (mark) => mark.to)
    this.classes = sorted.map((mark) => mark.className)
    this.reach = new Int32Array(sorted.length)
    let max = -1
    for (let index = 0; index < sorted.length; index++) {
      max = Math.max(max, this.tos[index])
      this.reach[index] = max
    }
  }

  static of(doc: Text, spec: DecorationSpec): DecorationSet {
    const position = (entries: readonly LineSpec[] | undefined) =>
      (entries ?? [])
        .filter((entry) => entry.line >= 1 && entry.line <= doc.lineCount)
        .map((entry) => ({ pos: doc.line(entry.line).from, className: entry.className }))
        .sort((a, b) => a.pos - b.pos)
    return new DecorationSet(spec.marks ?? [], position(spec.lines), position(spec.gutter))
  }

  get size(): number {
    return this.froms.length + this.lineMarks.length + this.gutterMarks.length
  }

  marks(_doc: Text, from: number, to: number, out: MarkSpec[]): void {
    const count = this.froms.length
    // The first mark that could reach into the window.
    let low = 0
    let high = count
    while (low < high) {
      const mid = (low + high) >>> 1
      if (this.reach[mid] > from || (this.reach[mid] === from && this.froms[mid] === from)) high = mid
      else low = mid + 1
    }
    for (let index = low; index < count && this.froms[index] < to; index++) {
      const start = this.froms[index]
      const end = this.tos[index]
      if (end > from || (start === end && start >= from)) out.push({ from: start, to: end, className: this.classes[index] })
    }
  }

  lines(doc: Text, fromLine: number, toLine: number, out: LineSpec[]): void {
    collectLines(this.lineMarks, doc, fromLine, toLine, out)
  }

  gutter(doc: Text, fromLine: number, toLine: number, out: LineSpec[]): void {
    collectLines(this.gutterMarks, doc, fromLine, toLine, out)
  }

  map(changes: ChangeSet, doc: Text): DecorationSet | null {
    if (changes.empty) return this
    const marks: MarkSpec[] = []
    for (let index = 0; index < this.froms.length; index++) {
      const from = changes.mapPos(this.froms[index], 1)
      const to = changes.mapPos(this.tos[index], -1)
      // A mark whose text was deleted is gone; one that was always empty stays.
      if (to > from || (this.tos[index] === this.froms[index] && to >= from)) {
        marks.push({ from, to: Math.max(from, to), className: this.classes[index] })
      }
    }
    const mapLines = (entries: readonly PositionedClass[]) => entries.map((entry) => ({ pos: Math.min(changes.mapPos(entry.pos, 1), doc.length), className: entry.className }))
    return new DecorationSet(marks, mapLines(this.lineMarks), mapLines(this.gutterMarks))
  }
}

function collectLines(entries: readonly PositionedClass[], doc: Text, fromLine: number, toLine: number, out: LineSpec[]): void {
  if (!entries.length) return
  const first = doc.line(Math.max(1, fromLine)).from
  const last = doc.line(Math.min(doc.lineCount, toLine)).to
  let low = 0
  let high = entries.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (entries[mid].pos < first) low = mid + 1
    else high = mid
  }
  for (let index = low; index < entries.length && entries[index].pos <= last; index++) {
    out.push({ line: doc.lineAt(entries[index].pos).number, className: entries[index].className })
  }
}

function isSortedByFrom(marks: readonly MarkSpec[]): boolean {
  for (let index = 1; index < marks.length; index++) if (marks[index].from < marks[index - 1].from) return false
  return true
}

function stableSortMarks(marks: readonly MarkSpec[]): MarkSpec[] {
  return marks
    .map((mark, index) => ({ mark, index }))
    .sort((a, b) => a.mark.from - b.mark.from || a.index - b.index)
    .map(({ mark }) => mark)
}
