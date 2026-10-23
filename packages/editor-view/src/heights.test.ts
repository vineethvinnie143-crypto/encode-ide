import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { check, gen, type Gen } from '@encode/testkit'
import { HeightMap, MAX_SCROLL_HEIGHT, ScrollScale, type Zone } from './heights'

/** Lays the lines and zones out one by one, the slow way. */
function model(lineHeight: number, lineCount: number, zones: readonly Zone[]) {
  const tops: number[] = [0]
  const zoneTops: number[] = []
  let y = 0
  const sorted = zones.map((zone, index) => ({ zone, index })).sort((a, b) => a.zone.after - b.zone.after || a.index - b.index)
  let next = 0
  const placeZones = (after: number) => {
    while (next < sorted.length && sorted[next].zone.after === after) {
      zoneTops.push(y)
      y += sorted[next].zone.height
      next++
    }
  }
  placeZones(0)
  for (let line = 1; line <= lineCount; line++) {
    tops[line] = y
    y += lineHeight
    placeZones(line)
  }
  tops[lineCount + 1] = y
  return { tops, zoneTops, total: y, sorted: sorted.map((entry) => entry.zone) }
}

const scenarios: Gen<{ lineHeight: number; lineCount: number; zones: Zone[] }> = (random, size) => {
  const lineCount = 1 + Math.floor(random() * (size * 20 + 1))
  const count = Math.floor(random() * (size + 1))
  const zones: Zone[] = []
  for (let id = 0; id < count; id++) {
    zones.push({ id, after: Math.floor(random() * (lineCount + 1)), height: 1 + Math.floor(random() * 80) })
  }
  return { lineHeight: 10 + Math.floor(random() * 20), lineCount, zones }
}

describe('HeightMap', () => {
  it('is plain arithmetic without zones', () => {
    const map = new HeightMap(20, 100)
    assert.equal(map.top(1), 0)
    assert.equal(map.top(11), 200)
    assert.equal(map.bottom(100), 2000)
    assert.equal(map.totalHeight, 2000)
    assert.equal(map.lineAt(-5), 1)
    assert.equal(map.lineAt(0), 1)
    assert.equal(map.lineAt(19.9), 1)
    assert.equal(map.lineAt(20), 2)
    assert.equal(map.lineAt(1999), 100)
    assert.equal(map.lineAt(9999), 100)
  })

  it('puts a zone between lines and pushes the lines below down', () => {
    const map = new HeightMap(20, 10, [{ id: 1, after: 3, height: 50 }])
    assert.equal(map.top(3), 40)
    assert.equal(map.top(4), 60 + 50)
    assert.equal(map.zoneTop(0), 60)
    assert.equal(map.lineAt(61), 3)
    assert.equal(map.lineAt(109), 3)
    assert.equal(map.lineAt(110), 4)
    assert.equal(map.totalHeight, 250)
    assert.deepEqual(map.zoneAt(70)?.zone.id, 1)
    assert.equal(map.zoneAt(59), null)
    assert.equal(map.zoneAt(110), null)
  })

  it('places zones before the first line and after the last', () => {
    const map = new HeightMap(10, 3, [
      { id: 1, after: 0, height: 5 },
      { id: 2, after: 3, height: 7 },
    ])
    assert.equal(map.top(1), 5)
    assert.equal(map.bottom(3), 35)
    assert.equal(map.zoneTop(1), 35)
    assert.equal(map.top(4), 35 + 7)
    assert.equal(map.totalHeight, 42)
  })

  it('stacks zones with the same position in the order given', () => {
    const map = new HeightMap(10, 2, [
      { id: 1, after: 1, height: 4 },
      { id: 2, after: 1, height: 6 },
    ])
    assert.equal(map.zoneTop(0), 10)
    assert.equal(map.zoneTop(1), 14)
    assert.equal(map.top(2), 20)
    assert.deepEqual(
      map.zonesBetween(1, 1).map((entry) => entry.zone.id),
      [1, 2],
    )
  })

  it('adds the bottom padding to the total only', () => {
    const map = new HeightMap(20, 10, [], 300)
    assert.equal(map.contentHeight, 200)
    assert.equal(map.totalHeight, 500)
    assert.equal(map.lineAt(450), 10)
  })

  it('agrees with a line-by-line layout', async () => {
    await check(scenarios, ({ lineHeight, lineCount, zones }) => {
      const map = new HeightMap(lineHeight, lineCount, zones)
      const expected = model(lineHeight, lineCount, zones)
      assert.equal(map.contentHeight, expected.total)
      for (let line = 1; line <= lineCount + 1; line++) assert.equal(map.top(line), expected.tops[line], `top(${line})`)
      for (let index = 0; index < expected.zoneTops.length; index++) assert.equal(map.zoneTop(index), expected.zoneTops[index])
      // lineAt: the last line whose top is at or above y.
      for (let probe = 0; probe < 50; probe++) {
        const y = (probe / 49) * (expected.total + lineHeight) - 3
        let line = 1
        for (let candidate = 1; candidate <= lineCount; candidate++) if (expected.tops[candidate] <= y) line = candidate
        assert.equal(map.lineAt(y), line, `lineAt(${y})`)
      }
    })
  })

  it('finds the zone at a point and lists the zones in a range', async () => {
    await check(scenarios, ({ lineHeight, lineCount, zones }) => {
      const map = new HeightMap(lineHeight, lineCount, zones)
      const expected = model(lineHeight, lineCount, zones)
      expected.sorted.forEach((zone, index) => {
        const top = expected.zoneTops[index]
        assert.equal(map.zoneAt(top)?.zone, zone)
        assert.equal(map.zoneAt(top + zone.height - 0.5)?.zone, zone)
      })
      const from = Math.floor(lineCount / 3)
      const to = Math.floor((lineCount * 2) / 3)
      const listed = map.zonesBetween(from, to).map((entry) => entry.zone)
      assert.deepEqual(
        listed,
        expected.sorted.filter((zone) => zone.after >= from && zone.after <= to),
      )
    })
  })
})

describe('ScrollScale', () => {
  it('is the identity for documents under the cap', () => {
    const scale = new ScrollScale(100_000, 800)
    assert.equal(scale.factor, 1)
    assert.equal(scale.scaled, false)
    assert.equal(scale.scrollHeight, 100_000)
    assert.equal(scale.toDoc(1234), 1234)
    assert.equal(scale.toScroll(1234), 1234)
  })

  it('maps the whole scroll range onto the whole document past the cap', () => {
    const total = 120_000_000
    const viewport = 900
    const scale = new ScrollScale(total, viewport)
    assert.equal(scale.scrollHeight, MAX_SCROLL_HEIGHT)
    assert.ok(scale.scaled)
    assert.equal(scale.toDoc(0), 0)
    // The last scroll offset shows the end of the document.
    assert.ok(Math.abs(scale.toDoc(MAX_SCROLL_HEIGHT - viewport) - (total - viewport)) < 1)
    assert.ok(Math.abs(scale.toScroll(scale.toDoc(3_000_000)) - 3_000_000) < 1e-6)
  })
})

describe('HeightMap with folded lines', () => {
  /** The slow way: hidden lines take no height, and the caller leaves out zones after them. */
  function folded(lineHeight: number, lineCount: number, zones: readonly Zone[], hidden: Set<number>) {
    const tops: number[] = [0]
    let y = 0
    const sorted = zones.map((zone, index) => ({ zone, index })).sort((a, b) => a.zone.after - b.zone.after || a.index - b.index)
    let next = 0
    const placeZones = (after: number) => {
      while (next < sorted.length && sorted[next].zone.after === after) y += sorted[next++].zone.height
    }
    placeZones(0)
    for (let line = 1; line <= lineCount; line++) {
      tops[line] = y
      if (!hidden.has(line)) y += lineHeight
      placeZones(line)
    }
    tops[lineCount + 1] = y
    return { tops, total: y }
  }

  it('lays out folded lines with no height, wherever the folds and zones are', async () => {
    await check(gen.tuple(scenarios, gen.array(gen.tuple(gen.int(1, 400), gen.int(0, 30)), 0, 6)), ([{ lineHeight, lineCount, zones }, folds]) => {
      const ranges = folds.map(([from, length]) => ({ from: Math.min(lineCount, from), to: Math.min(lineCount, from + length) }))
      const hidden = new Set<number>()
      for (const range of ranges) for (let line = range.from; line <= range.to; line++) hidden.add(line)
      const shown = zones.filter((zone) => !hidden.has(zone.after))
      const map = new HeightMap(lineHeight, lineCount, shown, 0, ranges)
      const expected = folded(lineHeight, lineCount, shown, hidden)
      assert.equal(map.contentHeight, expected.total)
      assert.equal(map.hiddenCount, hidden.size)
      for (let line = 1; line <= lineCount + 1; line++) {
        assert.equal(map.top(line), expected.tops[line], `top of line ${line}`)
        if (line <= lineCount) assert.equal(map.isHidden(line), hidden.has(line), `line ${line} hidden`)
      }
      for (let line = 1; line <= lineCount; line++) {
        if (hidden.has(line)) continue
        // Any y on a line that shows finds that line.
        assert.equal(map.lineAt(expected.tops[line] + lineHeight / 2), line, `lineAt in line ${line}`)
      }
      // lineAt never returns a hidden line while one shows.
      if (hidden.size < lineCount) {
        for (const y of [-5, 0, expected.total / 3, expected.total - 1, expected.total + 50]) assert.equal(map.isHidden(map.lineAt(y)), false, `lineAt(${y})`)
      }
    })
  })

  it('steps to the lines that show around a fold', () => {
    const map = new HeightMap(10, 20, [], 0, [
      { from: 3, to: 5 },
      { from: 6, to: 8 },
      { from: 18, to: 20 },
    ])
    assert.deepEqual(map.hidden, [
      { from: 3, to: 8 },
      { from: 18, to: 20 },
    ], 'touching folds merge')
    assert.equal(map.nextVisible(4), 9)
    assert.equal(map.previousVisible(4), 2)
    assert.equal(map.nextVisible(9), 9)
    assert.equal(map.nextVisible(19), 21)
    assert.equal(map.lineAt(10_000), 17, 'below a fold that ends the document: the last line that shows')
    assert.equal(map.hiddenBefore(10), 6)
  })
})
