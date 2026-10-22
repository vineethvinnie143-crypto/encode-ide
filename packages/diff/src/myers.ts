/**
 * Myers' O(ND) difference algorithm in linear space ("An O(ND) Difference
 * Algorithm and Its Variations", 1986, section 4b): find the middle snake of
 * the shortest edit script, then recurse on both halves. Sequences are
 * arrays of integers, so callers intern lines or words first and every
 * comparison is a number compare.
 */

/** A changed region: [fromA, toA) in the old sequence became [fromB, toB) in the new one. */
export interface DiffBlock {
  fromA: number
  toA: number
  fromB: number
  toB: number
}

interface Snake {
  /** Start of the middle snake. */
  x: number
  y: number
  /** End of the middle snake. */
  u: number
  v: number
}

export class DiffSearch {
  private forward: Int32Array
  private backward: Int32Array
  private timedOut = false

  constructor(
    private readonly a: ArrayLike<number>,
    private readonly b: ArrayLike<number>,
    private readonly deadline: number,
  ) {
    const size = 2 * (Math.ceil((a.length + b.length) / 2) + 1) + 1
    this.forward = new Int32Array(size)
    this.backward = new Int32Array(size)
  }

  /** True when the deadline passed and part of the result is a coarse replacement. */
  get approximate(): boolean {
    return this.timedOut
  }

  run(): DiffBlock[] {
    const out: DiffBlock[] = []
    this.diff(0, this.a.length, 0, this.b.length, out)
    return merge(out)
  }

  private diff(aLo: number, aHi: number, bLo: number, bHi: number, out: DiffBlock[]): void {
    const { a, b } = this
    while (aLo < aHi && bLo < bHi && a[aLo] === b[bLo]) {
      aLo++
      bLo++
    }
    while (aLo < aHi && bLo < bHi && a[aHi - 1] === b[bHi - 1]) {
      aHi--
      bHi--
    }
    if (aLo === aHi && bLo === bHi) return
    if (aLo === aHi || bLo === bHi) {
      out.push({ fromA: aLo, toA: aHi, fromB: bLo, toB: bHi })
      return
    }
    if (this.timedOut || Date.now() > this.deadline) {
      this.timedOut = true
      out.push({ fromA: aLo, toA: aHi, fromB: bLo, toB: bHi })
      return
    }
    const snake = this.middleSnake(aLo, aHi, bLo, bHi)
    if (!snake) {
      out.push({ fromA: aLo, toA: aHi, fromB: bLo, toB: bHi })
      return
    }
    this.diff(aLo, snake.x, bLo, snake.y, out)
    this.diff(snake.u, aHi, snake.v, bHi, out)
  }

  /**
   * Searches from both ends at once until the paths overlap. Diagonal k
   * holds the points with x - y = k; `forward[k]` is the furthest x reached
   * from the start, `backward[k]` the furthest distance from the end on the
   * reversed diagonal (delta - k).
   */
  private middleSnake(aLo: number, aHi: number, bLo: number, bHi: number): Snake | null {
    const { a, b, forward, backward } = this
    const n = aHi - aLo
    const m = bHi - bLo
    const delta = n - m
    const odd = (delta & 1) !== 0
    const max = Math.ceil((n + m) / 2)
    const offset = max + 1
    forward[offset + 1] = 0
    backward[offset + 1] = 0
    for (let d = 0; d <= max; d++) {
      if ((d & 63) === 63 && Date.now() > this.deadline) {
        this.timedOut = true
        return null
      }
      for (let k = -d; k <= d; k += 2) {
        let x =
          k === -d || (k !== d && forward[offset + k - 1] < forward[offset + k + 1])
            ? forward[offset + k + 1]
            : forward[offset + k - 1] + 1
        let y = x - k
        const x0 = x
        const y0 = y
        while (x < n && y < m && a[aLo + x] === b[bLo + y]) {
          x++
          y++
        }
        forward[offset + k] = x
        const reverse = delta - k
        if (odd && reverse >= -(d - 1) && reverse <= d - 1 && x + backward[offset + reverse] >= n) {
          return { x: aLo + x0, y: bLo + y0, u: aLo + x, v: bLo + y }
        }
      }
      for (let k = -d; k <= d; k += 2) {
        let x =
          k === -d || (k !== d && backward[offset + k - 1] < backward[offset + k + 1])
            ? backward[offset + k + 1]
            : backward[offset + k - 1] + 1
        let y = x - k
        const x0 = x
        const y0 = y
        while (x < n && y < m && a[aHi - 1 - x] === b[bHi - 1 - y]) {
          x++
          y++
        }
        backward[offset + k] = x
        const ahead = delta - k
        if (!odd && ahead >= -d && ahead <= d && x + forward[offset + ahead] >= n) {
          return { x: aHi - x, y: bHi - y, u: aHi - x0, v: bHi - y0 }
        }
      }
    }
    return null
  }
}

/** Joins blocks that touch, which the recursion produces around empty snakes. */
export function merge(blocks: readonly DiffBlock[]): DiffBlock[] {
  const out: DiffBlock[] = []
  for (const block of blocks) {
    const last = out[out.length - 1]
    if (last && last.toA === block.fromA && last.toB === block.fromB) {
      last.toA = block.toA
      last.toB = block.toB
    } else {
      out.push({ ...block })
    }
  }
  return out
}
