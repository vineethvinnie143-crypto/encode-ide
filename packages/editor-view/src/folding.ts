import {
  EditorSelection,
  SelectionRange,
  allFoldRanges,
  enclosingIndentRanges,
  foldDepths,
  foldRangeAt,
  isRegionStart,
  lineIndent,
  mapFoldRanges,
  mapFolded,
  rangeStartingAt,
  rangesContaining,
  type FoldRange,
  type LineStep,
} from '@encode/editor'
import type { ChangeSet, Text } from '@encode/text'
import { normalizeHidden, type HiddenLines } from './heights'
import type { EditorView } from './view'

/** A folded block: its first line stays shown, the lines after it up to `end` are hidden. */
interface Fold {
  start: number
  end: number
}

/** The gutter's column for the fold chevrons, right of the line numbers. */
export const FOLD_COLUMN = 16

/** Lines read ahead for whether a line starts a block, for its chevron in the gutter. */
const STARTS_LOOK_AHEAD = 2_000

/**
 * Folding: which ranges of the document can fold (from a language server, or found from the indentation and
 * `#region` markers), which are folded, and the lines that hides. The view lays the hidden lines out with no height,
 * steps the arrow keys over them, and unfolds a block when the cursor, a search or an edit reaches into it.
 */
export class FoldController {
  private folds: Fold[] = []
  private hiddenLines: HiddenLines[] | null = []
  private server: FoldRange[] | null = null
  /** Ranges found from the text, by first line, for the document they were read from. */
  private found = new Map<number, FoldRange | null>()
  private foundDoc: Text | null = null
  private allFound: { doc: Text; ranges: FoldRange[] } | null = null

  constructor(private readonly view: EditorView) {}

  // ----------------------------------------------------------------- ranges

  /**
   * The ranges a language server gave for the current document (1-based, sorted by start, as `normalizeFoldRanges`
   * returns them), or null to find them from the text again.
   */
  setRanges(ranges: readonly FoldRange[] | null): void {
    this.server = ranges ? [...ranges] : null
    this.view.requestRender()
  }

  /** Whether the ranges come from a language server. */
  get fromServer(): boolean {
    return this.server !== null
  }

  /** The range that starts on `line`, or null. */
  rangeAt(line: number): FoldRange | null {
    if (this.server) return rangeStartingAt(this.server, line)
    const doc = this.textDoc()
    if (!this.found.has(line)) this.found.set(line, foldRangeAt(doc, line, this.view.state.config.tabSize))
    return this.found.get(line)!
  }

  /** Whether a range starts on `line`, cheaply: what the gutter asks for every line it shows. */
  startsAt(line: number): boolean {
    if (this.server) return rangeStartingAt(this.server, line) !== null
    const doc = this.textDoc()
    if (line >= doc.lineCount) return false
    const known = this.found.get(line)
    if (known !== undefined) return known !== null
    const text = doc.line(line).text
    if (isRegionStart(text)) return this.rangeAt(line) !== null
    const tabSize = this.view.state.config.tabSize
    const indent = lineIndent(text, tabSize)
    if (indent < 0) return false
    const last = Math.min(doc.lineCount, line + STARTS_LOOK_AHEAD)
    for (let number = line + 1; number <= last; number++) {
      const width = lineIndent(doc.line(number).text, tabSize)
      if (width >= 0) return width > indent
    }
    return false
  }

  /** The ranges `line` is in or starts, outermost first. */
  rangesAt(line: number): FoldRange[] {
    if (this.server) return rangesContaining(this.server, line)
    const out = this.enclosing(line, Infinity)
    const own = this.rangeAt(line)
    return own ? [...out, own] : out
  }

  /** The ranges that start above `line` and hold it, outermost first, at most `max` (the innermost kept). */
  enclosing(line: number, max: number): FoldRange[] {
    if (this.server) return rangesContaining(this.server, line).filter((range) => range.start < line).slice(-max)
    return enclosingIndentRanges(this.textDoc(), line, this.view.state.config.tabSize, Number.isFinite(max) ? max : 64)
  }

  /** Every range of the document, sorted by start. */
  all(): readonly FoldRange[] {
    if (this.server) return this.server
    const doc = this.view.state.doc
    if (this.allFound?.doc !== doc) this.allFound = { doc, ranges: allFoldRanges(doc, this.view.state.config.tabSize) }
    return this.allFound.ranges
  }

  private textDoc(): Text {
    const doc = this.view.state.doc
    if (this.foundDoc !== doc) {
      this.found.clear()
      this.foundDoc = doc
    }
    return doc
  }

  // ----------------------------------------------------------------- what is folded

  /** The folded blocks, outermost first where they nest: what a host keeps to fold them again later. */
  get folded(): readonly FoldRange[] {
    return this.folds.map(({ start, end }) => ({ start, end }))
  }

  isFolded(line: number): boolean {
    return this.folds.some((fold) => fold.start === line)
  }

  /** The lines folded away, merged and sorted. */
  hidden(): readonly HiddenLines[] {
    if (!this.hiddenLines) {
      this.hiddenLines = normalizeHidden(
        this.folds.map((fold) => ({ from: fold.start + 1, to: fold.end })),
        this.view.state.doc.lineCount,
      )
    }
    return this.hiddenLines
  }

  /** The hidden block that `line` is in, or null when it shows. */
  hiddenAt(line: number): HiddenLines | null {
    for (const range of this.hidden()) {
      if (range.from > line) break
      if (range.to >= line) return range
    }
    return null
  }

  /**
   * Counts `lines` lines from `line` over the lines that show: the arrow keys, Page Up and Page Down, and adding a
   * cursor above or below step over a folded block in one go.
   */
  readonly step: LineStep = (line, lines) => {
    const hidden = this.hidden()
    if (!hidden.length) return line + lines
    const direction = lines < 0 ? -1 : 1
    let at = line
    for (let left = Math.abs(lines); left > 0; left--) {
      at += direction
      const block = this.hiddenAt(at)
      if (block) at = direction > 0 ? block.to + 1 : block.from - 1
      if (at < 1 || at > this.view.state.doc.lineCount) return at
    }
    return at
  }

  // ----------------------------------------------------------------- folding and unfolding

  /** Folds the innermost block at `line` (the cursor's by default) that is not folded yet. */
  fold(line = this.cursorLine()): boolean {
    const candidates = this.rangesAt(line).filter((range) => !this.isFolded(range.start))
    const range = candidates[candidates.length - 1]
    return range ? this.add([range]) : false
  }

  /** Unfolds the block whose first line is `line`, or the innermost folded one it is in. */
  unfold(line = this.cursorLine()): boolean {
    const own = this.folds.filter((fold) => fold.start === line)
    if (own.length) return this.remove(own)
    const around = this.folds.filter((fold) => fold.start < line && fold.end >= line)
    return around.length ? this.remove([around[around.length - 1]]) : false
  }

  toggle(line = this.cursorLine()): boolean {
    return this.isFolded(line) ? this.unfold(line) : this.fold(line)
  }

  /** Folds the block at `line` and every block inside it. */
  foldRecursively(line = this.cursorLine()): boolean {
    const ranges = this.rangesAt(line)
    const outer = ranges[ranges.length - 1]
    if (!outer) return false
    return this.add(this.all().filter((range) => range.start >= outer.start && range.end <= outer.end))
  }

  /** Unfolds the block at `line` and every block inside it. */
  unfoldRecursively(line = this.cursorLine()): boolean {
    const ranges = this.rangesAt(line)
    const outer = ranges[ranges.length - 1]
    if (!outer) return false
    return this.remove(this.folds.filter((fold) => fold.start >= outer.start && fold.end <= outer.end))
  }

  foldAll(): boolean {
    return this.add(this.all())
  }

  unfoldAll(): boolean {
    return this.remove(this.folds)
  }

  /** Folds every block nested `level` deep (1 is the outermost), except those the cursor is in. */
  foldLevel(level: number): boolean {
    const all = this.all()
    const depths = foldDepths(all)
    const line = this.cursorLine()
    const ranges = all.filter((range, index) => depths[index] === level && !(range.start <= line && range.end >= line))
    // Deeper folds inside them are opened, so unfolding one later shows its whole body.
    const inside = this.folds.filter((fold) => ranges.some((range) => fold.start > range.start && fold.end <= range.end))
    const removed = inside.length ? this.remove(inside, false) : false
    return this.add(ranges) || removed
  }

  /** Folds every block of a kind: comments, imports or regions. */
  foldKind(kind: NonNullable<FoldRange['kind']>): boolean {
    return this.add(this.all().filter((range) => range.kind === kind))
  }

  unfoldKind(kind: NonNullable<FoldRange['kind']>): boolean {
    const starts = new Set(this.all().filter((range) => range.kind === kind).map((range) => range.start))
    return this.remove(this.folds.filter((fold) => starts.has(fold.start)))
  }

  /** Folds these blocks again, as `folded` gave them; ranges that no longer fit the document are skipped. */
  restore(ranges: readonly FoldRange[]): void {
    this.folds = []
    this.hiddenLines = null
    this.add(ranges.filter((range) => Number.isInteger(range.start) && Number.isInteger(range.end)), false)
  }

  /** Unfolds whatever hides `pos`: a search, Go to line or the cursor reached into a folded block. */
  reveal(pos: number): boolean {
    const doc = this.view.state.doc
    const line = doc.lineAt(Math.max(0, Math.min(pos, doc.length))).number
    if (!this.hiddenAt(line)) return false
    return this.remove(this.folds.filter((fold) => fold.start < line && fold.end >= line))
  }

  private add(ranges: readonly FoldRange[], moveCursor = true): boolean {
    const doc = this.view.state.doc
    let changed = false
    for (const range of ranges) {
      if (range.start < 1 || range.end <= range.start || range.end > doc.lineCount || this.isFolded(range.start)) continue
      this.folds.push({ start: range.start, end: range.end })
      changed = true
    }
    if (!changed) return false
    this.folds.sort((a, b) => a.start - b.start || b.end - a.end)
    this.changed()
    if (moveCursor) this.liftCursors()
    return true
  }

  private remove(folds: readonly Fold[], notify = true): boolean {
    if (!folds.length) return false
    const gone = new Set(folds)
    this.folds = this.folds.filter((fold) => !gone.has(fold))
    if (notify) this.changed()
    else this.hiddenLines = null
    return true
  }

  /** Cursors that a fold just hid move to the end of its first line, as they would stay in the block otherwise. */
  private liftCursors(): void {
    const { state } = this.view
    const doc = state.doc
    let moved = false
    const ranges = state.selection.ranges.map((range) => {
      const hidden = this.hiddenAt(doc.lineAt(range.head).number)
      if (!hidden) return range
      moved = true
      const pos = doc.line(hidden.from - 1).to
      return range.empty ? SelectionRange.cursor(pos) : new SelectionRange(range.anchor, pos)
    })
    if (moved) this.view.dispatch({ selection: EditorSelection.create(ranges, state.selection.mainIndex), origin: 'select.fold' })
  }

  private changed(): void {
    this.hiddenLines = null
    this.view.requestRender()
    this.view.emit('folds')
  }

  private cursorLine(): number {
    const { state } = this.view
    return state.doc.lineAt(state.selection.main.head).number
  }

  // ----------------------------------------------------------------- following the document

  /** Follows an edit from `before` to `doc`: a fold whose hidden lines the edit touched opens; the rest move with the text. */
  documentChanged(changes: ChangeSet, before: Text, doc: Text): void {
    if (this.server) this.server = mapFoldRanges(this.server, changes, before, doc)
    this.allFound = null
    if (!this.folds.length) return
    const count = this.folds.length
    this.folds = mapFolded(this.folds, changes, before, doc)
    this.hiddenLines = null
    if (this.folds.length !== count) this.view.emit('folds')
  }

  /** Another document: nothing is folded and the ranges are found from its text until a server gives some. */
  stateReplaced(): void {
    this.folds = []
    this.hiddenLines = []
    this.server = null
    this.found.clear()
    this.foundDoc = null
    this.allFound = null
  }
}
