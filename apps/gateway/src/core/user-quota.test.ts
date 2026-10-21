import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { check, gen } from '@encode/testkit'
import { parseConfig, type UserLimits } from './config'
import { DAY, HOUR, MINUTE, SECOND } from './time'
import { hitWindows, UserQuota, type AcquireInput, type WindowState } from './user-quota'

const parsed = parseConfig({ OPENROUTER_API_KEY: 'sk-or-v1-test', GATEWAY_SECRET: 'a-gateway-secret-of-at-least-32-characters' })
assert.ok(parsed.ok)
const LIMITS: UserLimits = parsed.config.user
const T0 = Date.UTC(2026, 9, 21, 9)

let lease = 0
function input(extra: Partial<AcquireInput> = {}): AcquireInput {
  lease += 1
  return { leaseId: `lease-${lease}`, sessionId: 'ses_12345678', estimatedInputTokens: 1000, scale: 1, ...extra }
}

describe('an account quota', () => {
  it('allows the per-minute rate and says when the next request fits', () => {
    const quota = new UserQuota(undefined, T0)
    for (let index = 0; index < LIMITS.requestsPerMinute; index++) {
      const result = quota.acquire(input(), LIMITS, T0 + index * SECOND)
      assert.ok(result.ok, `request ${index}`)
      quota.release({ leaseId: `lease-${lease}`, outputTokens: 10, refund: false }, LIMITS, T0 + index * SECOND)
    }
    const refused = quota.acquire(input(), LIMITS, T0 + 30 * SECOND)
    assert.equal(refused.ok, false)
    assert.equal(!refused.ok && refused.code, 'rate_limited')
    assert.equal(!refused.ok && refused.retryAfterMs, 30 * SECOND)
    assert.ok(quota.acquire(input(), LIMITS, T0 + MINUTE + 1).ok)
  })

  it('runs at most the concurrent limit, and frees a slot on release or when a lease expires', () => {
    const quota = new UserQuota(undefined, T0)
    const first = input()
    assert.ok(quota.acquire(first, LIMITS, T0).ok)
    assert.ok(quota.acquire(input(), LIMITS, T0).ok)
    const refused = quota.acquire(input(), LIMITS, T0)
    assert.equal(!refused.ok && refused.code, 'concurrency_limited')
    quota.release({ leaseId: first.leaseId, outputTokens: 0, refund: false }, LIMITS, T0)
    assert.ok(quota.acquire(input(), LIMITS, T0).ok)
    assert.equal(quota.acquire(input(), LIMITS, T0 + 2 * SECOND).ok, false)
    assert.ok(quota.acquire(input(), LIMITS, T0 + LIMITS.leaseTtlMs + 1).ok, 'a crashed request frees its slot by itself')
  })

  it('stops at the daily request limit until midnight UTC', () => {
    const quota = new UserQuota(undefined, T0)
    let now = T0
    for (let index = 0; index < LIMITS.requestsPerDay; index++) {
      now += 7 * SECOND
      const acquired = input()
      assert.ok(quota.acquire(acquired, LIMITS, now).ok, `request ${index}`)
      quota.release({ leaseId: acquired.leaseId, outputTokens: 10, refund: false }, LIMITS, now)
    }
    const refused = quota.acquire(input(), LIMITS, now + 7 * SECOND)
    assert.equal(!refused.ok && refused.code, 'daily_quota_exhausted')
    const midnight = Date.UTC(2026, 9, 22)
    assert.equal(!refused.ok && refused.retryAfterMs, midnight - (now + 7 * SECOND))
    assert.ok(quota.acquire(input(), LIMITS, midnight).ok)
  })

  it('holds the estimated input tokens and settles the real count', () => {
    const quota = new UserQuota(undefined, T0)
    const big = input({ estimatedInputTokens: LIMITS.inputTokensPerDay - 1000 })
    assert.ok(quota.acquire(big, LIMITS, T0).ok)
    const refused = quota.acquire(input({ estimatedInputTokens: 2000 }), LIMITS, T0)
    assert.equal(!refused.ok && refused.code, 'token_quota_exhausted')
    quota.release({ leaseId: big.leaseId, inputTokens: 10_000, outputTokens: 50, refund: false }, LIMITS, T0)
    assert.equal(quota.state.inputTokens, 10_000)
    assert.equal(quota.state.outputTokens, 50)
    assert.ok(quota.acquire(input({ estimatedInputTokens: 2000 }), LIMITS, T0 + SECOND).ok)
  })

  it("stops when the day's output tokens are spent", () => {
    const quota = new UserQuota(undefined, T0)
    const acquired = input()
    assert.ok(quota.acquire(acquired, LIMITS, T0).ok)
    quota.release({ leaseId: acquired.leaseId, outputTokens: LIMITS.outputTokensPerDay, refund: false }, LIMITS, T0)
    const refused = quota.acquire(input(), LIMITS, T0 + SECOND)
    assert.equal(!refused.ok && refused.code, 'token_quota_exhausted')
  })

  it('refunds failed requests up to a daily cap, and releasing twice changes nothing', () => {
    const quota = new UserQuota(undefined, T0)
    let now = T0
    for (let index = 0; index < LIMITS.refundsPerDay + 3; index++) {
      now += 7 * SECOND
      const acquired = input()
      assert.ok(quota.acquire(acquired, LIMITS, now).ok)
      quota.release({ leaseId: acquired.leaseId, outputTokens: 0, refund: true }, LIMITS, now)
      quota.release({ leaseId: acquired.leaseId, outputTokens: 0, refund: true }, LIMITS, now)
    }
    assert.equal(quota.state.refunds, LIMITS.refundsPerDay)
    assert.equal(quota.state.requests, 3)
  })

  it('shrinks daily limits with the fair share, and never below one request', () => {
    const quota = new UserQuota(undefined, T0)
    assert.equal(quota.snapshot(LIMITS, 0.5, T0).requests.limit, Math.floor(LIMITS.requestsPerDay / 2))
    assert.equal(quota.snapshot(LIMITS, 0, T0).requests.limit, 1)
    assert.equal(quota.snapshot(LIMITS, 7, T0).requests.limit, LIMITS.requestsPerDay)
  })

  it('refuses a signed-out session until its tokens would have expired anyway', () => {
    const quota = new UserQuota(undefined, T0)
    quota.revoke('ses_12345678', T0 + HOUR)
    const refused = quota.acquire(input(), LIMITS, T0 + MINUTE)
    assert.equal(!refused.ok && refused.code, 'invalid_token')
    assert.ok(quota.acquire(input({ sessionId: 'ses_other123' }), LIMITS, T0 + MINUTE).ok)
    assert.equal(quota.isRevoked('ses_12345678', LIMITS, T0 + HOUR - 1), true)
    assert.equal(quota.isRevoked('ses_12345678', LIMITS, T0 + HOUR), false)
  })

  it('refuses a suspended account and drops its running leases', () => {
    const quota = new UserQuota(undefined, T0)
    assert.ok(quota.acquire(input(), LIMITS, T0).ok)
    quota.setSuspended(true)
    assert.equal(quota.state.leases.length, 0)
    const refused = quota.acquire(input(), LIMITS, T0)
    assert.equal(!refused.ok && refused.code, 'account_suspended')
    quota.setSuspended(false)
    assert.ok(quota.acquire(input(), LIMITS, T0).ok)
  })

  it('flags an account that sits at the per-minute limit for many minutes, once, and cuts its limits', () => {
    // A daily limit high enough that only the per-minute limit is ever hit.
    const limits = { ...LIMITS, requestsPerDay: 100_000 }
    const quota = new UserQuota(undefined, T0)
    const raised: number[] = []
    for (let minute = 0; minute < limits.flagSaturatedMinutes + 5; minute++) {
      const start = T0 + minute * MINUTE
      for (let index = 0; index <= limits.requestsPerMinute; index++) {
        const acquired = input()
        const result = quota.acquire(acquired, limits, start + index * 100)
        if (result.newlyFlagged) raised.push(minute)
        if (result.ok) quota.release({ leaseId: acquired.leaseId, outputTokens: 1, refund: false }, limits, start + index * 100)
      }
    }
    assert.deepEqual(raised, [limits.flagSaturatedMinutes - 1])
    assert.equal(quota.state.flag?.reason, 'machine_speed')
    assert.equal(quota.snapshot(limits, 1, T0 + HOUR).requests.limit, Math.floor(limits.requestsPerDay * limits.flaggedScale))
    quota.clearFlag()
    assert.equal(quota.snapshot(limits, 1, T0 + HOUR).requests.limit, limits.requestsPerDay)
  })

  it('flags an account active in nearly every hour of a day', () => {
    const quota = new UserQuota(undefined, T0)
    let flagged = false
    for (let hour = 0; hour < LIMITS.flagActiveHours; hour++) {
      const acquired = input()
      const result = quota.acquire(acquired, LIMITS, T0 + hour * HOUR)
      assert.ok(result.ok)
      flagged ||= result.newlyFlagged
      quota.release({ leaseId: acquired.leaseId, outputTokens: 1, refund: false }, LIMITS, T0 + hour * HOUR)
    }
    assert.ok(flagged)
    assert.equal(quota.state.flag?.reason, 'round_the_clock')
    assert.equal(new UserQuota(quota.state, T0).snapshot(LIMITS, 1, T0 + DAY + HOUR * LIMITS.flagActiveHours).requests.limit, LIMITS.requestsPerDay)
  })

  it('never lets more requests through than the limits allow, whatever the timing', async () => {
    const step = gen.tuple(gen.int(0, 20_000), gen.oneOf('acquire', 'release', 'refund'))
    await check(gen.array(step, 1, 200), (steps) => {
      const quota = new UserQuota(undefined, T0)
      const open: string[] = []
      const admitted: number[] = []
      let now = T0
      for (const [wait, action] of steps) {
        now += wait
        if (action === 'acquire') {
          const acquired = input()
          const result = quota.acquire(acquired, LIMITS, now)
          if (result.ok) {
            open.push(acquired.leaseId)
            admitted.push(now)
          }
        } else if (open.length) {
          quota.release({ leaseId: open.shift()!, outputTokens: 5, refund: action === 'refund' }, LIMITS, now)
        }
        assert.ok(quota.state.leases.length <= LIMITS.maxConcurrent)
        assert.ok(admitted.filter((at) => at > now - MINUTE).length <= LIMITS.requestsPerMinute)
        assert.ok(quota.state.requests <= LIMITS.requestsPerDay)
        assert.ok(quota.state.refunds <= LIMITS.refundsPerDay)
      }
    })
  })
})

describe('per-address windows', () => {
  it('count within a window and reset after it', () => {
    const state: WindowState = {}
    const rules = [{ name: 'start', limit: 2, windowMs: MINUTE }]
    assert.deepEqual(hitWindows(state, rules, T0), { ok: true })
    assert.deepEqual(hitWindows(state, rules, T0 + 1), { ok: true })
    assert.deepEqual(hitWindows(state, rules, T0 + 2), { ok: false, retryAfterMs: MINUTE - 2 })
    assert.deepEqual(hitWindows(state, rules, T0 + MINUTE), { ok: true })
  })

  it('count nothing when any rule refuses', () => {
    const state: WindowState = {}
    const rules = [
      { name: 'minute', limit: 5, windowMs: MINUTE },
      { name: 'hour', limit: 1, windowMs: HOUR },
    ]
    assert.ok(hitWindows(state, rules, T0).ok)
    assert.equal(hitWindows(state, rules, T0 + 1).ok, false)
    assert.equal(state.minute.count, 1)
  })
})
