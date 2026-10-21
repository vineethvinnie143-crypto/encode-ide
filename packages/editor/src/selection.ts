import type { ChangeSet } from '@encode/text'

/**
 * One selection: from `anchor` (where it started) to `head` (where the
 * cursor is). An empty range is a cursor. `goalColumn` remembers the column
 * vertical motion aims for, so moving through a short line and on keeps the
 * original column.
 */
export class SelectionRange {
  constructor(
    readonly anchor: number,
    readonly head: number,
    readonly goalColumn?: number,
  ) {}

  static cursor(pos: number, goalColumn?: number): SelectionRange {
    return new SelectionRange(pos, pos, goalColumn)
  }

  get from(): number {
    return Math.min(this.anchor, this.head)
  }

  get to(): number {
    return Math.max(this.anchor, this.head)
  }

  get empty(): boolean {
    return this.anchor === this.head
  }

  /** Moves the head, keeping the anchor; a cursor becomes a selection. */
  extend(head: number, goalColumn?: number): SelectionRange {
    return new SelectionRange(this.anchor, head, goalColumn)
  }

  /**
   * Follows the text through changes made elsewhere: a cursor stays before
   * text inserted at it, and a selection does not grow to take in text
   * inserted at either edge.
   */
  map(changes: ChangeSet): SelectionRange {
    if (changes.empty) return this
    if (this.empty) return SelectionRange.cursor(changes.mapPos(this.head, -1))
    const forward = this.head > this.anchor
    return new SelectionRange(changes.mapPos(this.anchor, forward ? 1 : -1), changes.mapPos(this.head, forward ? -1 : 1))
  }

  eq(other: SelectionRange): boolean {
    return this.anchor === other.anchor && this.head === other.head
  }
}

/**
 * All the selections of an editor, sorted and never overlapping. `mainIndex`
 * is the primary one: the one the view scrolls to and that single-cursor
 * commands use.
 */
export class EditorSelection {
  private constructor(
    readonly ranges: readonly SelectionRange[],
    readonly mainIndex: number,
  ) {}

  static single(anchor: number, head = anchor): EditorSelection {
    return new EditorSelection([new SelectionRange(anchor, head)], 0)
  }

  static cursor(pos: number): EditorSelection {
    return EditorSelection.single(pos)
  }

  /**
   * Sorts the ranges and merges those that overlap, or touch where one of
   * them is a cursor, keeping the main range's direction.
   */
  static create(ranges: readonly SelectionRange[], mainIndex = 0): EditorSelection {
    if (!ranges.length) throw new RangeError('A selection needs at least one range')
    const main = ranges[Math.min(Math.max(0, mainIndex), ranges.length - 1)]
    const sorted = ranges.slice().sort((a, b) => a.from - b.from || a.to - b.to)
    const merged: SelectionRange[] = []
    let newMain = 0
    for (const range of sorted) {
      const last = merged[merged.length - 1]
      if (last && (range.from < last.to || (range.from === last.to && (range.empty || last.empty)))) {
        const lastIsMain = newMain === merged.length - 1
        const direction = range === main ? range : last
        const from = last.from
        const to = Math.max(last.to, range.to)
        merged[merged.length - 1] =
          direction.head >= direction.anchor ? new SelectionRange(from, to) : new SelectionRange(to, from)
        if (range === main || lastIsMain) newMain = merged.length - 1
      } else {
        if (range === main) newMain = merged.length
        merged.push(range)
      }
    }
    return new EditorSelection(merged, newMain)
  }

  get main(): SelectionRange {
    return this.ranges[this.mainIndex]
  }

  map(changes: ChangeSet): EditorSelection {
    if (changes.empty) return this
    return EditorSelection.create(
      this.ranges.map((range) => range.map(changes)),
      this.mainIndex,
    )
  }

  /** Adds a range and, by default, makes it the main one. */
  addRange(range: SelectionRange, main = true): EditorSelection {
    const ranges = [...this.ranges, range]
    return EditorSelection.create(ranges, main ? ranges.length - 1 : this.mainIndex)
  }

  replaceRange(range: SelectionRange, index = this.mainIndex): EditorSelection {
    const ranges = this.ranges.slice()
    ranges[index] = range
    return EditorSelection.create(ranges, index)
  }

  /** Only the main range. */
  asSingle(): EditorSelection {
    return this.ranges.length === 1 ? this : new EditorSelection([this.main], 0)
  }

  eq(other: EditorSelection): boolean {
    if (this.ranges.length !== other.ranges.length || this.mainIndex !== other.mainIndex) return false
    return this.ranges.every((range, index) => range.eq(other.ranges[index]))
  }

  /** Every range clamped to a document of `length`. */
  clamp(length: number): EditorSelection {
    if (this.ranges.every((range) => range.to <= length)) return this
    return EditorSelection.create(
      this.ranges.map((range) => new SelectionRange(Math.min(range.anchor, length), Math.min(range.head, length))),
      this.mainIndex,
    )
  }
}
