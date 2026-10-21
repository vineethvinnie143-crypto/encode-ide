import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { HealthTracker } from './health'
import { FakeClock } from './testing'

const KEY = 'openrouter:a/b:free'
const fail = (health: HealthTracker, retryAt?: number) => health.failure(KEY, { kind: 'server', message: 'HTTP 502', ...(retryAt !== undefined ? { retryAt } : {}) })

describe('HealthTracker', () => {
  it('cools a failing model down, doubling each time, up to the cap', async () => {
    const clock = new FakeClock()
    const health = new HealthTracker(clock, { cooldownMs: 5_000, maxCooldownMs: 30_000, openAfterConsecutive: 100 })
    const waits: number[] = []
    for (let index = 0; index < 5; index++) {
      fail(health)
      const availability = health.availability(KEY)
      assert.equal(availability.available, false)
      if (!availability.available) {
        waits.push(availability.until - clock.now())
        await clock.advance(availability.until - clock.now())
      }
    }
    assert.deepEqual(waits, [5_000, 10_000, 20_000, 30_000, 30_000])
  })

  it("honours the provider's retry time, up to a day", () => {
    const clock = new FakeClock()
    const health = new HealthTracker(clock)
    fail(health, clock.now() + 120_000)
    assert.deepEqual(health.availability(KEY), { available: false, until: clock.now() + 120_000, reason: 'HTTP 502' })
    health.rateLimited('other', { message: '429', retryAt: clock.now() + 7 * 24 * 60 * 60_000 })
    const later = health.availability('other')
    assert.equal(!later.available && later.until, clock.now() + 24 * 60 * 60_000)
  })

  it('opens the breaker after three failures in a row and lets one probe through', async () => {
    const clock = new FakeClock()
    const health = new HealthTracker(clock, { cooldownMs: 1_000 })
    for (let index = 0; index < 3; index++) {
      fail(health)
      await clock.advance(10_000)
    }
    assert.deepEqual(health.availability(KEY), { available: true, probe: true })
    assert.equal(health.startProbe(KEY), true)
    assert.equal(health.startProbe(KEY), false, 'one probe at a time')
    assert.equal(health.availability(KEY).available, false)
    health.success(KEY, { ttftMs: 800 })
    assert.deepEqual(health.availability(KEY), { available: true, probe: false })
    assert.equal(health.report().models[0].state, 'healthy')
  })

  it('opens the breaker when most of the recent calls failed, even with successes between', () => {
    const clock = new FakeClock()
    const health = new HealthTracker(clock, { cooldownMs: 1 })
    for (let index = 0; index < 12; index++) {
      if (index % 3 === 0) health.success(KEY)
      else fail(health)
    }
    assert.equal(health.report().models[0].state, 'open')
  })

  it('never trips the breaker for rate limits', async () => {
    const clock = new FakeClock()
    const health = new HealthTracker(clock)
    for (let index = 0; index < 10; index++) {
      health.rateLimited(KEY, { message: '429' })
      await clock.advance(16 * 60_000)
    }
    assert.deepEqual(health.availability(KEY), { available: true, probe: false })
    assert.equal(health.report().models[0].rateLimited, 10)
  })

  it('ranks a fast, reliable model above a slow, flaky one', () => {
    const health = new HealthTracker(new FakeClock())
    for (let index = 0; index < 5; index++) health.success('fast', { ttftMs: 500 })
    for (let index = 0; index < 5; index++) {
      health.success('slow', { ttftMs: 15_000 })
      health.failure('slow', { kind: 'timeout', message: 'slow' })
    }
    assert.ok(health.score('fast') > health.score('unknown'))
    assert.ok(health.score('unknown') > health.score('slow'))
  })

  it('blocks a scope until a time, never shortening an earlier block', async () => {
    const clock = new FakeClock()
    const health = new HealthTracker(clock)
    health.block('provider:openrouter', { until: clock.now() + 60_000, kind: 'auth', reason: 'bad key' })
    health.block('provider:openrouter', { until: clock.now() + 1_000, kind: 'network', reason: 'blip' })
    assert.equal(health.blocked('provider:openrouter')?.kind, 'auth')
    await clock.advance(60_000)
    assert.equal(health.blocked('provider:openrouter'), undefined)
  })

  it('restores a snapshot without a probe in flight, skipping what is malformed', () => {
    const clock = new FakeClock()
    const health = new HealthTracker(clock)
    for (let index = 0; index < 3; index++) fail(health)
    health.startProbe(KEY)
    health.block('paid:openrouter', { until: clock.now() + 60_000, kind: 'payment', reason: 'no credit' })
    const restored = new HealthTracker(clock)
    restored.restore(JSON.parse(JSON.stringify(health.snapshot())))
    assert.equal(restored.report().models[0].failures, 3)
    assert.equal(restored.startProbe(KEY), true, 'a restored probe is not stuck')
    assert.equal(restored.blocked('paid:openrouter')?.kind, 'payment')
    restored.restore({ version: 1, models: { x: 'junk', y: { recent: 'no' } }, scopes: { z: { until: 'later' } } })
    restored.restore('nonsense')
  })

  it('caps a cooldown or block from a damaged snapshot at a day', () => {
    const clock = new FakeClock()
    const health = new HealthTracker(clock)
    health.restore({ version: 1, models: { [KEY]: { recent: [], cooldownUntil: 1e15 } }, scopes: { 'provider:openrouter': { until: 1e15, kind: 'auth', reason: 'x' } } })
    const availability = health.availability(KEY)
    assert.equal(!availability.available && availability.until, clock.now() + 24 * 60 * 60_000)
    assert.equal(health.blocked('provider:openrouter')?.until, clock.now() + 24 * 60 * 60_000)
  })
})
