/**
 * Vertical layout of a document: every line is `lineHeight` tall and zones
 * (the removed lines of a review hunk, a widget) add height between lines.
 * Pure arithmetic, so a million-line document costs nothing to lay out and
 * the module is tested in Node.
 */

export interface Zone {
  readonly id: number
  /** Lines above the zone: 0 puts it before the first line, `lineCount` after the last. */
  readonly after: number
  readonly height: number
}

export class HeightMap {
  private readonly zones: readonly Zone[]
  /** cumulative[i]: the height of the zones before zones[i]. */
  private readonly cumulative: Float64Array

  /**
   * @param padBottom Empty space after the last line, so the last line can scroll up the viewport.
   * @param zones Sorted by `after`; zones with the same `after` keep their order.
   */
  constructor(
    readonly lineHeight: number,
    readonly lineCount: number,
    zones: readonly Zone[] = [],
    readonly padBottom = 0,
  ) {
    this.zones = zones.length > 1 && !isSorted(zones) ? stableSort(zones) : zones
    this.cumulative = new Float64Array(this.zones.length + 1)
    for (let index = 0; index < this.zones.length; index++) this.cumulative[index + 1] = this.cumulative[index] + this.zones[index].height
  }

  /** The height of the lines and zones, without the padding. */
  get contentHeight(): number {
    return this.lineCount * this.lineHeight + this.cumulative[this.zones.length]
  }

  get totalHeight(): number {
    return this.contentHeight + this.padBottom
  }

  /** Top of line `n` (1-based); `lineCount + 1` is the bottom of the last line and of the zones after it. */
  top(n: number): number {
    return (n - 1) * this.lineHeight + this.cumulative[this.firstZoneAtOrAfter(n)]
  }

  bottom(n: number): number {
    return this.top(n) + this.lineHeight
  }

  /** The last line whose top is at or above `y`; 1 above the document, the last line below it. */
  lineAt(y: number): number {
    if (y <= 0 || this.lineCount <= 1) return 1
    if (!this.zones.length) return Math.min(this.lineCount, Math.floor(y / this.lineHeight) + 1)
    let low = 1
    let high = this.lineCount
    while (low < high) {
      const mid = (low + high + 1) >>> 1
      if (this.top(mid) <= y) low = mid
      else high = mid - 1
    }
    return low
  }

  /** Where zone number `index` (in layout order) starts. */
  zoneTop(index: number): number {
    return this.zones[index].after * this.lineHeight + this.cumulative[index]
  }

  /** Zones placed after lines `fromAfter`..`toAfter` (inclusive), in layout order, with their tops. */
  zonesBetween(fromAfter: number, toAfter: number): { zone: Zone; top: number }[] {
    const out: { zone: Zone; top: number }[] = []
    for (let index = this.firstZoneAtOrAfter(fromAfter); index < this.zones.length; index++) {
      const zone = this.zones[index]
      if (zone.after > toAfter) break
      out.push({ zone, top: this.zoneTop(index) })
    }
    return out
  }

  /** The zone covering `y`, if any. */
  zoneAt(y: number): { zone: Zone; top: number } | null {
    if (!this.zones.length) return null
    // The last zone that starts at or above y.
    let low = 0
    let high = this.zones.length - 1
    let found = -1
    while (low <= high) {
      const mid = (low + high) >>> 1
      if (this.zoneTop(mid) <= y) {
        found = mid
        low = mid + 1
      } else high = mid - 1
    }
    if (found < 0) return null
    const top = this.zoneTop(found)
    return y < top + this.zones[found].height ? { zone: this.zones[found], top } : null
  }

  /** Where `zone` is in layout order, or -1. */
  indexOf(zone: Zone): number {
    return this.zones.indexOf(zone)
  }

  get zoneList(): readonly Zone[] {
    return this.zones
  }

  /** Index of the first zone with `after` at or past `n` (so also the number of zones before it). */
  private firstZoneAtOrAfter(n: number): number {
    let low = 0
    let high = this.zones.length
    while (low < high) {
      const mid = (low + high) >>> 1
      if (this.zones[mid].after < n) low = mid + 1
      else high = mid
    }
    return low
  }
}

function isSorted(zones: readonly Zone[]): boolean {
  for (let index = 1; index < zones.length; index++) if (zones[index].after < zones[index - 1].after) return false
  return true
}

function stableSort(zones: readonly Zone[]): Zone[] {
  return zones
    .map((zone, index) => ({ zone, index }))
    .sort((a, b) => a.zone.after - b.zone.after || a.index - b.index)
    .map(({ zone }) => zone)
}

/**
 * Browsers cap the height of an element (about 33 million pixels in
 * Chromium, and scroll offsets lose precision well before that). Past this
 * height the scrollbar covers a scaled-down range and the view maps scroll
 * offsets to document positions.
 */
export const MAX_SCROLL_HEIGHT = 8_000_000

export class ScrollScale {
  /** Document pixels per scroll pixel; 1 until the document is taller than the cap. */
  readonly factor: number
  /** The height the scroll container is given. */
  readonly scrollHeight: number

  constructor(totalHeight: number, readonly viewportHeight: number, max = MAX_SCROLL_HEIGHT) {
    if (totalHeight <= max) {
      this.factor = 1
      this.scrollHeight = totalHeight
    } else {
      this.scrollHeight = max
      // The last scroll offset must land on the last document offset, or the end is unreachable.
      this.factor = (totalHeight - viewportHeight) / Math.max(1, max - viewportHeight)
    }
  }

  get scaled(): boolean {
    return this.factor !== 1
  }

  /** The document offset at the top of the viewport for a scroll offset. */
  toDoc(scrollTop: number): number {
    return scrollTop * this.factor
  }

  toScroll(docY: number): number {
    return docY / this.factor
  }
}
