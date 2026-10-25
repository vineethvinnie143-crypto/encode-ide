import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CacheClock, LONG_CACHE_MS, SHORT_CACHE_MS, cacheKeyOf } from './cache-hints'

describe('cache hints (ADR 0128)', () => {
  it('keys each conversation of a session apart, stably, without naming the session', () => {
    const main = cacheKeyOf('session-1', 'main')
    assert.equal(main, cacheKeyOf('session-1', 'main'))
    assert.notEqual(main, cacheKeyOf('session-1', 'explore-1'))
    assert.notEqual(main, cacheKeyOf('session-2', 'main'))
    assert.match(main, /^encode-[0-9a-f]{32}$/)
    assert.ok(!main.includes('session-1'))
  })

  it('asks for the hour-long cache from the first wait past five minutes on', () => {
    let now = 1_000_000
    const clock = new CacheClock(() => now)
    assert.equal(clock.start(), false, 'the first request has waited for nothing')
    now += 40_000
    assert.equal(clock.start(), false)
    now += SHORT_CACHE_MS
    assert.equal(clock.start(), false, 'five minutes to the millisecond still finds the cache')
    now += SHORT_CACHE_MS + 1
    assert.equal(clock.start(), true, 'the wait that outlived the cache')
    now += 2_000
    assert.equal(clock.start(), true, 'and every request after it, since the session waits')
  })

  it('tells a cache that has expired since the last request started (ADR 0130)', () => {
    let now = 1_000_000
    const clock = new CacheClock(() => now)
    assert.equal(clock.expired(SHORT_CACHE_MS), false, 'nothing was cached yet')
    clock.start()
    now += SHORT_CACHE_MS
    assert.equal(clock.expired(SHORT_CACHE_MS), false)
    now += 1
    assert.equal(clock.expired(SHORT_CACHE_MS), true)
    clock.start()
    now += 30 * 60_000
    assert.equal(clock.expired(SHORT_CACHE_MS), false, 'the session asks for the hour now')
    now += LONG_CACHE_MS
    assert.equal(clock.expired(SHORT_CACHE_MS), true)
  })
})
