import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { check, gen } from '@encode/testkit'
import { parseConfig, type GlobalLimits } from './config'
import { COOLDOWN_BASE_MS, COOLDOWN_MAX_MS, Control, quantile, TTFT_BUCKETS, type KeySnapshot } from './control'
import { MINUTE, SECOND } from './time'

const parsed = parseConfig({ OPENROUTER_API_KEY: 'sk-or-v1-test', GATEWAY_SECRET: 'a-gateway-secret-of-at-least-32-characters' })
assert.ok(parsed.ok)
const LIMITS: GlobalLimits = parsed.config.global
const ALERTS = parsed.config.alerts
const T0 = Date.UTC(2026, 9, 21, 9)
const MIDNIGHT = Date.UTC(2026, 9, 22)
const FIRST = { firstAttempt: true, newActiveUser: false }

function key(free: KeySnapshot['free'], extra: Partial<KeySnapshot> = {}): KeySnapshot {
  return { free, creditsUsedToday: 0, creditLimit: null, creditLimitRemaining: null, ...extra }
}

describe('upstream pacing', () => {
  it('starts at most the per-minute limit in any rolling minute, queues briefly, then answers busy', () => {
    const control = new Control(undefined, T0)
    const slots: number[] = []
    for (let index = 0; index < LIMITS.requestsPerMinute; index++) {
      const admission = control.admit(FIRST, LIMITS, T0)
      assert.ok(admission.ok)
      assert.equal(admission.waitMs, 0)
      slots.push(admission.slot)
    }
    const queued = control.admit(FIRST, LIMITS, T0 + MINUTE - 5 * SECOND)
    assert.ok(queued.ok)
    assert.equal(queued.waitMs, 5 * SECOND, 'waits for the oldest start to leave the window')
    const busy = control.admit(FIRST, LIMITS, T0 + 10 * SECOND)
    assert.equal(busy.ok, false)
    assert.equal(!busy.ok && busy.code, 'free_tier_busy')
  })

  it('never exceeds the rate in any rolling minute and never queues past the wait limit', async () => {
    const step = gen.tuple(gen.int(0, 6_000), gen.oneOf('admit', 'admit', 'admit', 'cancel'))
    await check(gen.array(step, 1, 300), (steps) => {
      const control = new Control(undefined, T0)
      let now = T0
      const live: number[] = []
      for (const [wait, action] of steps) {
        now += wait
        if (action === 'cancel') {
          // Only a start that has not happened yet can be handed back.
          const index = live.findIndex((slot) => slot > now)
          if (index >= 0) control.cancel(live.splice(index, 1)[0], now)
          continue
        }
        const admission = control.admit(FIRST, LIMITS, now)
        if (!admission.ok) {
          assert.equal(admission.code, 'free_tier_busy')
          continue
        }
        assert.ok(admission.waitMs >= 0 && admission.waitMs <= LIMITS.maxQueueWaitMs)
        assert.equal(admission.slot, now + admission.waitMs)
        live.push(admission.slot)
        live.sort((a, b) => a - b)
        for (const slot of live) {
          const inWindow = live.filter((other) => other > slot - MINUTE && other <= slot).length
          assert.ok(inWindow <= LIMITS.requestsPerMinute, `${inWindow} starts in the minute up to ${slot - T0}`)
        }
      }
    })
  })

  it('pauses every start after an account-wide rate limit, up to a minute', () => {
    const control = new Control(undefined, T0)
    control.report({ model: 'acme/big:free', outcome: 'account_limited', retryAfterMs: 12 * SECOND }, T0)
    const admission = control.admit(FIRST, LIMITS, T0 + SECOND)
    assert.ok(!admission.ok, 'a 12 s pause is longer than the queue limit')
    assert.ok(control.admit(FIRST, LIMITS, T0 + 5 * SECOND).ok)
    control.report({ model: 'acme/big:free', outcome: 'account_limited', retryAfterMs: 10 * MINUTE }, T0)
    assert.equal(control.state.pausedUntil, T0 + MINUTE)
  })

  it('hands back a reserved start', () => {
    const control = new Control(undefined, T0)
    const admission = control.admit(FIRST, LIMITS, T0)
    assert.ok(admission.ok)
    control.cancel(admission.slot, T0)
    assert.equal(control.state.attempts, 0)
    assert.equal(control.state.starts.length, 0)
    control.cancel(admission.slot, T0)
    assert.equal(control.state.attempts, 0)
  })
})

describe('the daily free budget', () => {
  it('stops at our own ceiling until midnight UTC', () => {
    const control = new Control(undefined, T0)
    const limits = { ...LIMITS, requestsPerDay: 3, requestsPerMinute: 100 }
    for (let index = 0; index < 3; index++) assert.ok(control.admit(FIRST, limits, T0 + index).ok)
    const refused = control.admit(FIRST, limits, T0 + 10)
    assert.equal(!refused.ok && refused.code, 'free_tier_exhausted')
    assert.equal(!refused.ok && refused.retryAfterMs, MIDNIGHT - (T0 + 10))
    assert.equal(control.status(limits, T0 + 20).available, false)
    assert.ok(control.admit(FIRST, limits, MIDNIGHT).ok)
  })

  it("follows OpenRouter's own counters and counts our attempts since", () => {
    const control = new Control(undefined, T0)
    control.updateKey(key({ limit: 1000, used: 900, remaining: 100 }), T0)
    const status = control.status(LIMITS, T0)
    assert.equal(status.limit, LIMITS.requestsPerDay, 'our own ceiling is lower than OpenRouter\'s')
    assert.equal(status.used, 900)
    for (let index = 0; index < 5; index++) assert.ok(control.admit(FIRST, LIMITS, T0 + index * 4 * SECOND).ok)
    assert.equal(control.status(LIMITS, T0 + MINUTE).used, 905)
    control.updateKey(key({ limit: 50, used: 50, remaining: 0 }), T0 + 2 * MINUTE)
    const refused = control.admit(FIRST, LIMITS, T0 + 3 * MINUTE)
    assert.equal(!refused.ok && refused.code, 'free_tier_exhausted')
  })

  it('clears an OpenRouter exhaustion when the counters say requests are left again', () => {
    const control = new Control(undefined, T0)
    control.updateKey(key({ limit: 50, used: 50, remaining: 0 }), T0)
    assert.equal(control.status(LIMITS, T0).available, false)
    control.updateKey(key({ limit: 1000, used: 50, remaining: 950 }), T0 + MINUTE)
    assert.equal(control.status(LIMITS, T0 + MINUTE).available, true)
  })

  it('treats a key answer without counters as no news', () => {
    const control = new Control(undefined, T0)
    control.updateKey(key(null), T0)
    const status = control.status(LIMITS, T0)
    assert.equal(status.available, true)
    assert.equal(status.limit, LIMITS.requestsPerDay)
  })

  it('shrinks per-account limits toward a fair share as the budget runs low', () => {
    const control = new Control(undefined, T0)
    const limits = { ...LIMITS, requestsPerDay: 100, requestsPerMinute: 1000 }
    assert.equal(control.scale(limits), 1)
    for (let index = 0; index < 75; index++) control.admit(FIRST, limits, T0)
    assert.equal(control.scale(limits), 0.5)
    for (let index = 0; index < 24; index++) control.admit(FIRST, limits, T0)
    assert.equal(control.scale(limits), LIMITS.fairShareFloor)
    assert.match(control.status(limits, T0).message ?? '', /lower than usual/)
  })

  it('stops for a while when OpenRouter reports the daily free limit or refuses the key', () => {
    const control = new Control(undefined, T0)
    control.report({ model: 'acme/big:free', outcome: 'daily_exhausted', retryAfterMs: 3 * 3_600_000 }, T0)
    assert.equal(control.state.exhaustedUntil, T0 + 3 * 3_600_000)
    const later = new Control(undefined, T0)
    later.report({ model: 'acme/big:free', outcome: 'payment_required' }, T0)
    const refused = later.admit(FIRST, LIMITS, T0 + MINUTE)
    assert.equal(!refused.ok && refused.message, 'The free tier is unavailable for a few minutes.')
    assert.ok(later.admit(FIRST, LIMITS, T0 + 16 * MINUTE).ok)
  })
})

describe('model health', () => {
  it('cools a failing model from 30 s, doubling to 15 minutes, and resets on success', () => {
    const control = new Control(undefined, T0)
    const cooling = () => control.state.health['acme/big:free'].coolingUntil - T0
    control.report({ model: 'acme/big:free', outcome: 'error' }, T0)
    assert.equal(cooling(), COOLDOWN_BASE_MS)
    control.report({ model: 'acme/big:free', outcome: 'timeout' }, T0)
    assert.equal(cooling(), 2 * COOLDOWN_BASE_MS)
    for (let index = 0; index < 10; index++) control.report({ model: 'acme/big:free', outcome: 'error' }, T0)
    assert.equal(cooling(), COOLDOWN_MAX_MS)
    const admission = control.admit(FIRST, LIMITS, T0)
    assert.ok(admission.ok && admission.coolingUntil['acme/big:free'] === T0 + COOLDOWN_MAX_MS)
    control.report({ model: 'acme/big:free', outcome: 'ok', ttftMs: 700 }, T0)
    assert.equal(control.state.health['acme/big:free'].coolingUntil, 0)
    assert.equal(control.state.health['acme/big:free'].cooldownMs, COOLDOWN_BASE_MS)
  })

  it("uses a provider's reset time, retires vanished models, and ignores rejected requests", () => {
    const control = new Control(undefined, T0)
    control.report({ model: 'a/b:free', outcome: 'rate_limited', retryAfterMs: 90 * SECOND }, T0)
    assert.equal(control.state.health['a/b:free'].coolingUntil, T0 + 90 * SECOND)
    control.report({ model: 'a/gone:free', outcome: 'not_found' }, T0)
    assert.equal(control.state.health['a/gone:free'].coolingUntil, T0 + COOLDOWN_MAX_MS)
    control.report({ model: 'a/fine:free', outcome: 'rejected' }, T0)
    assert.equal(control.state.health['a/fine:free'].coolingUntil, 0)
  })

  it('keeps time-to-first-token histograms and reports medians', () => {
    const control = new Control(undefined, T0)
    for (const ttftMs of [100, 300, 700, 700, 900]) control.report({ model: 'a/b:free', outcome: 'ok', ttftMs }, T0)
    assert.deepEqual(control.latency(), { 'a/b:free': 1_000 })
    assert.equal(quantile(TTFT_BUCKETS.map(() => 0), 0.5), 0)
  })
})

describe('alerts', () => {
  it('raise each alert once a day, with no account named', () => {
    const control = new Control(undefined, T0)
    control.updateKey(key({ limit: 1000, used: 10, remaining: 990 }, { creditsUsedToday: 0.02 }), T0)
    control.updateKey(key({ limit: 1000, used: 10, remaining: 990 }, { creditsUsedToday: 0.03 }), T0 + MINUTE)
    const alerts = control.takeAlerts(LIMITS, ALERTS, T0 + MINUTE)
    assert.deepEqual(alerts.map((alert) => alert.key), ['paid_usage'])
    assert.equal(alerts[0].severity, 'critical')
    assert.deepEqual(control.takeAlerts(LIMITS, ALERTS, T0 + 2 * MINUTE), [])
    control.updateKey(key({ limit: 1000, used: 10, remaining: 990 }, { creditsUsedToday: 0.01 }), MIDNIGHT + MINUTE)
    assert.deepEqual(control.takeAlerts(LIMITS, ALERTS, MIDNIGHT + MINUTE).map((alert) => alert.key), ['paid_usage'])
  })

  it('warn when the budget is mostly used, a model keeps failing, or an account is flagged', () => {
    const control = new Control(undefined, T0)
    const limits = { ...LIMITS, requestsPerDay: 100, requestsPerMinute: 1000 }
    for (let index = 0; index < 80; index++) control.admit(FIRST, limits, T0)
    for (let index = 0; index < 18; index++) control.report({ model: 'a/flaky:free', outcome: 'ok' }, T0)
    for (let index = 0; index < 4; index++) control.report({ model: 'a/flaky:free', outcome: 'error' }, T0)
    control.flagged('0123456789abcdef', 'machine_speed', T0)
    const alerts = control.takeAlerts(limits, ALERTS, T0)
    assert.deepEqual(alerts.map((alert) => alert.key).sort(), ['flagged:0123456789abcdef', 'model_errors:a/flaky:free', 'quota_high'])
    assert.match(alerts.find((alert) => alert.key.startsWith('flagged'))!.message, /machine speed/)
  })
})

describe('metrics', () => {
  it('count requests, attempts and active users per day and keep two weeks', () => {
    const control = new Control(undefined, T0)
    control.admit({ firstAttempt: true, newActiveUser: true }, LIMITS, T0)
    control.admit({ firstAttempt: false, newActiveUser: false }, LIMITS, T0 + 4 * SECOND)
    control.admit(FIRST, LIMITS, T0 + 8 * SECOND)
    const [today] = control.metrics(1, T0 + 10 * SECOND)
    assert.equal(today.day, '2026-10-21')
    assert.equal(today.requests, 2)
    assert.equal(today.attempts, 3)
    assert.equal(today.activeUsers, 1)
    for (let day = 1; day <= 20; day++) control.admit(FIRST, LIMITS, T0 + day * 86_400_000)
    const history = control.metrics(100, T0 + 20 * 86_400_000)
    assert.equal(history.length, 15)
    assert.equal(history[0].day, '2026-11-10')
  })
})
