import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { FreeTier } from './free-tier'
import { nextUtcMidnight } from './openrouter'
import { FakeClock } from './testing'

describe('FreeTier', () => {
  it('paces requests under the per-minute limit with a sliding window', async () => {
    const clock = new FakeClock()
    const tier = new FreeTier(clock, 'openrouter', 3)
    for (let index = 0; index < 3; index++) {
      assert.equal(tier.delay(), 0)
      tier.record()
      await clock.advance(10_000)
    }
    // Sent at 0, 10 and 20 s; at 30 s the next slot opens when the first leaves the window, at 60 s.
    assert.equal(tier.delay(), 30_000)
    await clock.advance(30_000)
    assert.equal(tier.delay(), 0)
  })

  it('closes for the day once the known daily limit is used, and reopens at midnight UTC', async () => {
    const clock = new FakeClock()
    const tier = new FreeTier(clock, 'openrouter', 20)
    tier.applyQuota({ used: 48, limit: 50, remaining: 2, resetAt: nextUtcMidnight(clock.now()) })
    tier.record()
    assert.equal(tier.closure(), undefined)
    tier.record()
    assert.equal(tier.closure()?.kind, 'free-daily')
    assert.equal(tier.remaining(), 0)
    await clock.advance(nextUtcMidnight(clock.now()) - clock.now())
    assert.equal(tier.closure(), undefined)
    assert.equal(tier.remaining(), 50)
  })

  it("raises its own count to OpenRouter's, which sees other apps, but never lowers it to a late one", () => {
    const clock = new FakeClock()
    const tier = new FreeTier(clock, 'openrouter', 20)
    const resetAt = nextUtcMidnight(clock.now())
    for (let index = 0; index < 5; index++) tier.record()
    // OpenRouter's count can read zero after requests went through.
    tier.applyQuota({ used: 0, limit: 1_000, remaining: 1_000, resetAt })
    assert.equal(tier.remaining(), 995)
    tier.applyQuota({ used: 20, limit: 1_000, remaining: 980, resetAt })
    assert.equal(tier.remaining(), 980)
    tier.applyQuota({ used: 3, limit: 1_000, remaining: 997, resetAt })
    assert.equal(tier.remaining(), 980)
  })

  it('stays closed after a 429, whatever a late count says', () => {
    const clock = new FakeClock()
    const tier = new FreeTier(clock, 'openrouter', 20)
    const resetAt = nextUtcMidnight(clock.now())
    tier.applyQuota({ used: 40, limit: 1_000, remaining: 960, resetAt })
    tier.close({ until: resetAt, kind: 'free-daily', reason: 'spent' })
    tier.applyQuota({ used: 0, limit: 1_000, remaining: 1_000, resetAt })
    assert.equal(tier.closure()?.kind, 'free-daily')
    assert.equal(tier.closure()?.until, resetAt)
    assert.equal(tier.remaining(), 0)
  })

  it('reopens when the limit itself rises, as it does once the account has bought credit', () => {
    const clock = new FakeClock()
    const tier = new FreeTier(clock, 'openrouter', 20)
    const resetAt = nextUtcMidnight(clock.now())
    tier.applyQuota({ used: 48, limit: 50, remaining: 2, resetAt })
    tier.record()
    tier.record()
    assert.equal(tier.closure()?.kind, 'free-daily')
    tier.applyQuota({ used: 50, limit: 50, remaining: 0, resetAt })
    assert.equal(tier.closure()?.kind, 'free-daily')
    tier.applyQuota({ used: 50, limit: 1_000, remaining: 950, resetAt })
    assert.equal(tier.closure(), undefined)
    assert.equal(tier.status().daily?.remaining, 950)
  })

  it('closes on its say-so alone only until the next reading, and leaves its own count alone', async () => {
    const clock = new FakeClock()
    const tier = new FreeTier(clock, 'openrouter', 20)
    const resetAt = nextUtcMidnight(clock.now())
    // Just after midnight, OpenRouter can still show yesterday's figure.
    tier.applyQuota({ used: 1_000, limit: 1_000, remaining: 0, resetAt })
    assert.equal(tier.closure()?.kind, 'free-daily')
    assert.equal(tier.closure()?.until, clock.now() + 15 * 60_000)
    assert.equal(tier.remaining(), 1_000)
    await clock.advance(15 * 60_000)
    assert.equal(tier.closure(), undefined)
    tier.applyQuota({ used: 12, limit: 1_000, remaining: 988, resetAt })
    assert.equal(tier.closure(), undefined)
    assert.equal(tier.remaining(), 988)
  })

  it('closes for the rest of the day when its own count reaches the limit OpenRouter reports', () => {
    const clock = new FakeClock()
    const tier = new FreeTier(clock, 'openrouter', 20)
    const resetAt = nextUtcMidnight(clock.now())
    for (let index = 0; index < 50; index++) tier.record()
    tier.applyQuota({ used: 10, limit: 50, remaining: 40, resetAt })
    assert.equal(tier.closure()?.kind, 'free-daily')
    assert.equal(tier.closure()?.until, resetAt)
  })

  it('keeps the longer of two closures', () => {
    const clock = new FakeClock()
    const tier = new FreeTier(clock, 'openrouter', 20)
    tier.close({ until: clock.now() + 600_000, kind: 'free-daily', reason: 'spent' })
    tier.close({ until: clock.now() + 30_000, kind: 'free-rpm', reason: 'minute' })
    assert.equal(tier.closure()?.kind, 'free-daily')
  })

  it('survives a restart through its snapshot', () => {
    const clock = new FakeClock()
    const tier = new FreeTier(clock, 'openrouter', 2)
    tier.record()
    tier.record()
    const restored = new FreeTier(clock, 'openrouter', 2)
    restored.restore(JSON.parse(JSON.stringify(tier.snapshot())))
    assert.ok(restored.delay() > 0)
    restored.restore({ version: 1, sent: ['x', clock.now() + 1e9], daily: { used: 'many' } })
  })

  it('never stays closed past the next reset because of a damaged snapshot', async () => {
    const clock = new FakeClock()
    const tier = new FreeTier(clock, 'openrouter', 20)
    tier.restore({ version: 1, sent: [], daily: { used: 50, limit: 50, resetAt: 1e15 }, closed: { until: 1e15, kind: 'free-daily', reason: 'spent' } })
    assert.equal(tier.closure()?.until, nextUtcMidnight(clock.now()))
    await clock.advance(nextUtcMidnight(clock.now()) - clock.now())
    assert.equal(tier.closure(), undefined)
    assert.equal(tier.remaining(), 50)
  })
})
