import type { ChangeSet, Text } from '@encode/text'

/** Something placed on one line by columns, `from` to `to` (the same column for a point), in UTF-16 units. */
export interface Placed {
  readonly from: number
  readonly to: number
}

/**
 * Items placed on lines by column (a server's semantic tokens, its inlay hints), kept line by line so that a line's
 * items are found at once and followed through edits cheaply. An edit drops the items it reaches into, moves those
 * after it on its own line, and shifts the lines below it; the items of the other lines are not touched, and keep
 * their arrays, so a line drawn from them is not drawn again. A point at the place text is typed moves with the text
 * after it.
 */
export class LineItems<T extends Placed> {
  /** By 1-based line number; a line with none holds undefined. */
  private lines: (readonly T[] | undefined)[] = []
  private any = false
  /** Goes up whenever the items change, so what is drawn from them knows to draw again. */
  version = 0

  /** `move` gives an item moved to other columns on its line. */
  constructor(private readonly move: (item: T, from: number, to: number) => T) {}

  /** Replaces every item: `byLine` maps 1-based lines to their items, each line's sorted by `from`. */
  set(byLine: ReadonlyMap<number, readonly T[]> | null): void {
    this.lines = []
    this.any = false
    if (byLine) {
      for (const [line, items] of byLine) {
        if (line < 1 || !items.length) continue
        this.lines[line] = items
        this.any = true
      }
    }
    this.version++
  }

  /** The items of line `n`, the same array until they change; undefined for none. */
  line(n: number): readonly T[] | undefined {
    return this.lines[n]
  }

  get empty(): boolean {
    return !this.any
  }

  clear(): void {
    if (!this.any) return
    this.set(null)
  }

  /** Follows a change to `before`, the document the items are placed in. */
  map(changes: ChangeSet, before: Text): void {
    if (!this.any || changes.empty) return
    const list: [number, number, string][] = []
    changes.forEach((fromA, toA, _fromB, _toB, insert) => list.push([fromA, toA, insert]))
    // From the last change to the first: each is in the old document's places, and the text before it is unchanged so far.
    for (let index = list.length - 1; index >= 0; index--) this.apply(before, list[index][0], list[index][1], list[index][2])
    this.version++
  }

  private apply(before: Text, fromA: number, toA: number, insert: string): void {
    const start = before.lineAt(fromA)
    const end = toA <= start.to ? start : before.lineAt(toA)
    const colFrom = fromA - start.from
    const colTo = toA - end.from
    const first = this.lines[start.number]
    const last = this.lines[end.number]
    // Before the change: what ends at or before it, but not a point at the very place text goes in.
    const head = first?.filter((item) => item.to <= colFrom && !(start === end && item.from >= colTo)) ?? []
    const after = last?.filter((item) => item.from >= colTo) ?? []
    const breaks = insert.split('\n')
    const shift = (breaks.length === 1 ? colFrom + insert.length : breaks[breaks.length - 1].length) - colTo
    const tail = shift ? after.map((item) => this.move(item, item.from + shift, item.to + shift)) : after
    const replaced: (readonly T[] | undefined)[] = []
    if (breaks.length === 1) {
      // Untouched when the change reached no item there: the line keeps its array, and is not drawn again for it.
      const untouched = first && start === end && head.length + after.length === first.length && !shift
      replaced.push(untouched ? first : nonEmpty([...head, ...tail]))
    } else {
      replaced.push(nonEmpty(head))
      for (let line = 1; line < breaks.length - 1; line++) replaced.push(undefined)
      replaced.push(nonEmpty(tail))
    }
    // Lines past the end of the array hold nothing: only splice when the change reaches lines that hold items, or
    // moves the lines below some that do.
    if (start.number >= this.lines.length && replaced.every((items) => !items)) return
    // A paste of many lines is too many arguments for one splice.
    if (replaced.length > 1_000) this.lines = this.lines.slice(0, start.number).concat(replaced, this.lines.slice(end.number + 1))
    else this.lines.splice(start.number, end.number - start.number + 1, ...replaced)
  }
}

function nonEmpty<T>(items: readonly T[]): readonly T[] | undefined {
  return items.length ? items : undefined
}
