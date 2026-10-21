import { Text } from './text'

/** A stretch of an intermediate document: kept from the original, or inserted. */
type Piece = { from: number; to: number } | { text: string }

function pieceSize(piece: Piece): number {
  return 'text' in piece ? piece.text.length : piece.to - piece.from
}

function slicePiece(piece: Piece, from: number, to: number): Piece {
  return 'text' in piece ? { text: piece.text.slice(from, to) } : { from: piece.from + from, to: piece.from + to }
}

/** One edit: replace `from`–`to` with `insert`. Leaving out `to` inserts at `from`. */
export interface ChangeSpec {
  from: number
  to?: number
  insert?: string
}

export interface Change {
  readonly from: number
  readonly to: number
  readonly insert: string
}

/**
 * Edits to one version of a document, all in that version's offsets: sorted,
 * non-overlapping, and applied together. Changes that overlap, or that touch
 * at an insertion point, are merged into one, so the result never depends on
 * the order in which the specs were given.
 */
export class ChangeSet {
  /** Net length change before each change, then the total. */
  private readonly deltas: Float64Array

  private constructor(
    readonly changes: readonly Change[],
    /** Length of the document the changes apply to. */
    readonly length: number,
  ) {
    this.deltas = new Float64Array(changes.length + 1)
    let delta = 0
    for (let index = 0; index < changes.length; index++) {
      this.deltas[index] = delta
      const change = changes[index]
      delta += change.insert.length - (change.to - change.from)
    }
    this.deltas[changes.length] = delta
  }

  static of(specs: ChangeSpec | readonly ChangeSpec[], length: number): ChangeSet {
    const list = (Array.isArray(specs) ? specs : [specs]) as readonly ChangeSpec[]
    const changes: Change[] = []
    for (const spec of list) {
      const to = spec.to ?? spec.from
      if (!Number.isInteger(spec.from) || !Number.isInteger(to) || spec.from < 0 || to > length || spec.from > to) {
        throw new RangeError(`Change ${spec.from}-${to} does not fit a document of length ${length}`)
      }
      const insert = spec.insert ?? ''
      if (spec.from === to && !insert) continue
      changes.push({ from: spec.from, to, insert })
    }
    // Stable: specs at the same offset keep their given order.
    changes.sort((a, b) => a.from - b.from || a.to - b.to)
    const merged: Change[] = []
    for (const change of changes) {
      const last = merged[merged.length - 1]
      const touches =
        last !== undefined &&
        (change.from < last.to || (change.from === last.to && (last.from === last.to || change.from === change.to)))
      if (touches) {
        merged[merged.length - 1] = { from: last.from, to: Math.max(last.to, change.to), insert: last.insert + change.insert }
      } else {
        merged.push(change)
      }
    }
    return new ChangeSet(merged, length)
  }

  static empty(length: number): ChangeSet {
    return new ChangeSet([], length)
  }

  get empty(): boolean {
    return this.changes.length === 0
  }

  /** Length of the document after the changes. */
  get newLength(): number {
    return this.length + this.deltas[this.changes.length]
  }

  apply(doc: Text): Text {
    if (doc.length !== this.length) {
      throw new RangeError(`Changes for a document of length ${this.length} applied to one of length ${doc.length}`)
    }
    if (this.changes.length <= 32) {
      let result = doc
      for (let index = this.changes.length - 1; index >= 0; index--) {
        const change = this.changes[index]
        result = result.replace(change.from, change.to, change.insert)
      }
      return result
    }
    // Many changes (replace all): build the new lines in one pass, reusing
    // every untouched line, instead of rebuilding the document per change.
    const lines: string[] = []
    let pending = ''
    const appendString = (text: string) => {
      const parts = text.split('\n')
      pending += parts[0]
      for (let index = 1; index < parts.length; index++) {
        lines.push(pending)
        pending = parts[index]
      }
    }
    const appendRange = (from: number, to: number) => {
      if (from === to) return
      const first = doc.lineAt(from)
      if (to <= first.to) {
        pending += first.text.slice(from - first.from, to - first.from)
        return
      }
      const last = doc.lineAt(to)
      lines.push(pending + first.text.slice(from - first.from))
      if (last.number - first.number > 1) lines.push(...doc.lineTexts(first.number + 1, last.number - 1))
      pending = last.text.slice(0, to - last.from)
    }
    let cursor = 0
    for (const change of this.changes) {
      appendRange(cursor, change.from)
      appendString(change.insert)
      cursor = change.to
    }
    appendRange(cursor, doc.length)
    lines.push(pending)
    return Text.of(lines)
  }

  /** The changes that undo these ones; `doc` is the document they were applied to. */
  invert(doc: Text): ChangeSet {
    if (doc.length !== this.length) {
      throw new RangeError(`Changes for a document of length ${this.length} inverted against one of length ${doc.length}`)
    }
    const inverse = this.changes.map((change, index) => {
      const from = change.from + this.deltas[index]
      return { from, to: from + change.insert.length, insert: doc.sliceString(change.from, change.to) }
    })
    return new ChangeSet(inverse, this.newLength)
  }

  /**
   * Where `pos` ends up after the changes. A position at an insertion point,
   * or inside replaced text, goes before the new text when `assoc` is
   * negative and after it when positive.
   */
  mapPos(pos: number, assoc: -1 | 1 = -1): number {
    // First change that ends at or after pos.
    let lo = 0
    let hi = this.changes.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.changes[mid].to < pos) lo = mid + 1
      else hi = mid
    }
    const change = this.changes[lo]
    const delta = this.deltas[lo]
    if (!change || pos < change.from) return pos + delta
    const start = change.from + delta
    const end = start + change.insert.length
    if (change.from === change.to) return assoc < 0 ? start : end
    if (pos === change.to) return end
    return assoc < 0 ? start : end
  }

  /**
   * These changes followed by `next` (which applies to the document these
   * changes produce), as one set against the original document.
   */
  compose(next: ChangeSet): ChangeSet {
    if (next.length !== this.newLength) {
      throw new RangeError(`Cannot compose: changes produce length ${this.newLength} but the next ones expect ${next.length}`)
    }
    if (this.empty) return next
    if (next.empty) return this
    // The intermediate document as non-empty pieces: ranges kept from the original, and inserted text.
    let pieces: Piece[] = []
    let cursor = 0
    for (const change of this.changes) {
      if (change.from > cursor) pieces.push({ from: cursor, to: change.from })
      if (change.insert) pieces.push({ text: change.insert })
      cursor = change.to
    }
    if (cursor < this.length) pieces.push({ from: cursor, to: this.length })

    // Apply `next`, last change first, so earlier offsets stay valid.
    for (let index = next.changes.length - 1; index >= 0; index--) {
      const change = next.changes[index]
      const before: Piece[] = []
      const after: Piece[] = []
      let start = 0
      for (const piece of pieces) {
        const end = start + pieceSize(piece)
        if (end <= change.from) before.push(piece)
        else if (start >= change.to) after.push(piece)
        else {
          if (start < change.from) before.push(slicePiece(piece, 0, change.from - start))
          if (end > change.to) after.push(slicePiece(piece, change.to - start, end - start))
        }
        start = end
      }
      if (change.insert) before.push({ text: change.insert })
      pieces = before.concat(after)
    }

    // Everything between two kept ranges is one change.
    const changes: ChangeSpec[] = []
    let pos = 0
    let pending = ''
    for (const piece of pieces) {
      if ('text' in piece) {
        pending += piece.text
        continue
      }
      if (piece.from > pos || pending) changes.push({ from: pos, to: piece.from, insert: pending })
      pos = piece.to
      pending = ''
    }
    if (pos < this.length || pending) changes.push({ from: pos, to: this.length, insert: pending })
    return ChangeSet.of(changes, this.length)
  }

  /**
   * The span the changes cover, before (`fromA`–`toA`) and after
   * (`fromB`–`toB`); null when there are none.
   */
  span(): { fromA: number; toA: number; fromB: number; toB: number } | null {
    if (!this.changes.length) return null
    const first = this.changes[0]
    const last = this.changes[this.changes.length - 1]
    const lastIndex = this.changes.length - 1
    return {
      fromA: first.from,
      toA: last.to,
      fromB: first.from,
      toB: last.from + this.deltas[lastIndex] + last.insert.length,
    }
  }

  /** Each change with its position in the new document as well. */
  forEach(callback: (fromA: number, toA: number, fromB: number, toB: number, insert: string) => void): void {
    this.changes.forEach((change, index) => {
      const fromB = change.from + this.deltas[index]
      callback(change.from, change.to, fromB, fromB + change.insert.length, change.insert)
    })
  }
}
