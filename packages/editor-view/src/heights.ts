/**
 * Vertical layout of a document: every line is `lineHeight` tall, zones
 * (the removed lines of a review hunk, a widget) add height between lines,
 * and folded lines take none. Pure arithmetic, so a million-line document
 * costs nothing to lay out and the module is tested in Node.
 */

export interface Zone {
  readonly id: number
  /** Lines above the zone: 0 puts it before the first line, `lineCount` after the last. */
  readonly after: number
  readonly height: number
}

/** Lines `from` to `to` (1-based, inclusive) are folded away. */
export interface HiddenLines {
  readonly from: number
  readonly to: number
}

export class HeightMap {
  private readonly zones: readonly Zone[]
  /** cumulative[i]: the height of the zones before zones[i]. */
  private readonly cumulative: Float64Array
  /** Sorted, apart and inside the document. */
  readonly hidden: readonly HiddenLines[]
  /** hiddenCum[i]: the lines hidden by hidden[0 .. i). */
  private readonly hiddenCum: Float64Array

  /**
   * @param padBottom Empty space after the last line, so the last line can scroll up the viewport.
   * @param zones Sorted by `after`; zones with the same `after` keep their order. A zone after a hidden line is left
   *   out by the caller.
   * @param hidden Folded lines, as `normalizeHidden` returns them.
   */
  constructor(
    readonly lineHeight: number,
    readonly lineCount: number,
    zones: readonly Zone[] = [],
    readonly padBottom = 0,
    hidden: readonly HiddenLines[] = [],
  ) {
    this.zones = zones.length > 1 && !isSorted(zones) ? stableSort(zones) : zones
    this.cumulative = new Float64Array(this.zones.length + 1)
    for (let index = 0; index < this.zones.length; index++) this.cumulative[index + 1] = this.cumulative[index] + this.zones[index].height
    this.hidden = normalizeHidden(hidden, lineCount)
    this.hiddenCum = new Float64Array(this.hidden.length + 1)
    for (let index = 0; index < this.hidden.length; index++) {
      this.hiddenCum[index + 1] = this.hiddenCum[index] + this.hidden[index].to - this.hidden[index].from + 1
    }
  }

  /** Lines folded away. */
  get hiddenCount(): number {
    return this.hiddenCum[this.hidden.length]
  }

  /** The height of the lines and zones, without the padding. */
  get contentHeight(): number {
    return (this.lineCount - this.hiddenCount) * this.lineHeight + this.cumulative[this.zones.length]
  }

  /** Hidden lines before line `n`. */
  hiddenBefore(n: number): number {
    const index = this.lastHiddenStartingBefore(n)
    if (index < 0) return 0
    const range = this.hidden[index]
    return this.hiddenCum[index] + Math.min(n - range.from, range.to - range.from + 1)
  }

  isHidden(n: number): boolean {
    const index = this.lastHiddenStartingBefore(n + 1)
    return index >= 0 && this.hidden[index].to >= n
  }

  /** The first line at or after `n` that shows; `lineCount + 1` when none does. */
  nextVisible(n: number): number {
    const index = this.lastHiddenStartingBefore(n + 1)
    return index >= 0 && this.hidden[index].to >= n ? this.hidden[index].to + 1 : n
  }

  /** The last line at or before `n` that shows; 0 when none does. */
  previousVisible(n: number): number {
    const index = this.lastHiddenStartingBefore(n + 1)
    return index >= 0 && this.hidden[index].to >= n ? this.hidden[index].from - 1 : n
  }

  /** Index of the last hidden range that starts before line `n`, or -1. */
  private lastHiddenStartingBefore(n: number): number {
    let low = 0
    let high = this.hidden.length
    while (low < high) {
      const mid = (low + high) >>> 1
      if (this.hidden[mid].from < n) low = mid + 1
      else high = mid
    }
    return low - 1
  }

  get totalHeight(): number {
    return this.contentHeight + this.padBottom
  }

  /**
   * Top of line `n` (1-based); `lineCount + 1` is the bottom of the last line and of the zones after it. A hidden line
   * has no height: its top is that of the next line that shows.
   */
  top(n: number): number {
    const hidden = this.hidden.length ? this.hiddenBefore(n) : 0
    return (n - 1 - hidden) * this.lineHeight + this.cumulative[this.firstZoneAtOrAfter(n)]
  }

  bottom(n: number): number {
    return this.top(n) + this.lineHeight
  }

  /**
   * The last line that shows whose top is at or above `y`; the first line that shows above the document, the last one
   * below it.
   */
  lineAt(y: number): number {
    if (y <= 0 || this.lineCount <= 1) return this.nextVisible(1) > this.lineCount ? 1 : this.nextVisible(1)
    if (!this.zones.length && !this.hidden.length) return Math.min(this.lineCount, Math.floor(y / this.lineHeight) + 1)
    let low = 1
    let high = this.lineCount
    while (low < high) {
      const mid = (low + high + 1) >>> 1
      if (this.top(mid) <= y) low = mid
      else high = mid - 1
    }
    // Hidden lines share the top of the line after them, so the search lands past them unless they end the document.
    if (this.isHidden(low)) {
      const before = this.previousVisible(low)
      return before >= 1 ? before : Math.min(this.lineCount, this.nextVisible(low))
    }
    return low
  }

  /** Where zone number `index` (in layout order) starts. */
  zoneTop(index: number): number {
    const after = this.zones[index].after
    const hidden = this.hidden.length ? this.hiddenBefore(after + 1) : 0
    return (after - hidden) * this.lineHeight + this.cumulative[index]
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

/** Folded lines in order, merged where they touch or overlap, and cut to the document. */
export function normalizeHidden(hidden: readonly HiddenLines[], lineCount: number): HiddenLines[] {
  const sorted = hidden
    .filter((range) => range.to >= range.from && range.to >= 1 && range.from <= lineCount)
    .map((range) => ({ from: Math.max(1, range.from), to: Math.min(lineCount, range.to) }))
    .sort((a, b) => a.from - b.from)
  const out: HiddenLines[] = []
  for (const range of sorted) {
    const last = out[out.length - 1]
    if (last && range.from <= last.to + 1) out[out.length - 1] = { from: last.from, to: Math.max(last.to, range.to) }
    else out.push(range)
  }
  return out
}

/** Whether two lists of folded lines are the same. */
export function sameHidden(a: readonly HiddenLines[], b: readonly HiddenLines[]): boolean {
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index++) if (a[index].from !== b[index].from || a[index].to !== b[index].to) return false
  return true
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
