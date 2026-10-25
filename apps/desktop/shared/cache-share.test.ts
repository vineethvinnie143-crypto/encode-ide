import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CACHE_MIN_CALLS, cacheAdvice, cacheByModel, cachePercent, cacheShare, cacheVerdict } from './cache-share'
import type { DayUsage, SessionUsage, UsageTally } from './types'

const tally = (calls: number, inputTokens: number, cachedTokens: number): UsageTally => ({ calls, inputTokens, cachedTokens, outputTokens: 0, cost: 0, unpriced: 0 })

function day(models: Record<string, UsageTally>): DayUsage {
  return { ...tally(0, 0, 0), requests: 1, models }
}

describe('the cached share (ADR 0128)', () => {
  it('is what was read from the cache, rounded down so only a whole cache says 100%', () => {
    assert.equal(cacheShare(tally(1, 0, 0)), null)
    assert.equal(cachePercent(tally(1, 0, 0)), '—')
    assert.equal(cachePercent(tally(1, 1000, 996)), '99%')
    assert.equal(cachePercent(tally(1, 1000, 1000)), '100%')
  })

  it('says nothing for a few calls, and tells a provider that reports no cache from one that misses', () => {
    assert.equal(cacheVerdict(tally(CACHE_MIN_CALLS - 1, 100_000, 10)), 'few')
    assert.equal(cacheVerdict(tally(CACHE_MIN_CALLS, 100_000, 0)), 'none')
    assert.equal(cacheVerdict(tally(CACHE_MIN_CALLS, 100_000, 79_999)), 'low')
    assert.equal(cacheVerdict(tally(CACHE_MIN_CALLS, 100_000, 80_000)), 'good')
    assert.match(cacheAdvice('low')!, /fixed provider order/)
    assert.match(cacheAdvice('none')!, /may not cache/)
    assert.equal(cacheAdvice('good'), null)
    assert.equal(cacheAdvice('few'), null)
  })

  it("adds up each model's calls over the days asked for, the most read first", () => {
    const sessions: SessionUsage[] = [
      { id: 'a', title: 'A', projectRoot: null, days: { '2026-10-18': day({ m1: tally(500, 9_000_000, 0) }), '2026-10-25': day({ m1: tally(30, 400_000, 390_000), m2: tally(25, 900_000, 500_000) }) } },
      { id: 'b', title: 'B', projectRoot: null, days: { '2026-10-19': day({ m1: tally(10, 100_000, 95_000) }) } },
    ]
    const rows = cacheByModel(sessions, { today: new Date(2026, 9, 25, 23, 0), days: 7 })
    assert.deepEqual(rows, [
      { model: 'm2', calls: 25, inputTokens: 900_000, cachedTokens: 500_000, verdict: 'low' },
      { model: 'm1', calls: 40, inputTokens: 500_000, cachedTokens: 485_000, verdict: 'good' },
    ])
  })
})
