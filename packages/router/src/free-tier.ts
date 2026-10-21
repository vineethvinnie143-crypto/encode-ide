import type { Clock } from './clock'
import { nextUtcMidnight, type FreeQuota } from './openrouter'

/**
 * One OpenRouter account's free tier. Its limits apply to the whole account,
 * not to a model: 20 requests a minute, and 50 a day (1,000 once the account
 * has bought $10 of credit). Pacing keeps eNCode under the per-minute limit
 * instead of running into it, the daily count comes from OpenRouter's /key
 * endpoint plus eNCode's own tally, and a 429 for either limit closes the
 * whole tier until it resets, so no other free model is tried in vain.
 */

const MINUTE = 60_000

export interface FreeTierStatus {
  provider: string
  requestsPerMinute: number
  sentLastMinute: number
  /** When the next request may go out, if pacing holds it back now. */
  nextSlotAt?: number
  daily?: { used: number; limit: number; remaining: number; resetAt: number }
  /** Set while the tier is closed after a 429 or an exhausted day. */
  closed?: { until: number; kind: 'free-rpm' | 'free-daily'; reason: string }
}

export interface FreeTierSnapshot {
  version: 1
  sent: number[]
  daily?: { used: number; limit?: number; resetAt: number }
  closed?: FreeTierStatus['closed']
}

export class FreeTier {
  private sent: number[] = []
  private daily: { used: number; limit?: number; resetAt: number }
  private closed: FreeTierStatus['closed']

  constructor(
    private readonly clock: Clock,
    readonly provider: string,
    private perMinute: number,
  ) {
    this.daily = { used: 0, resetAt: nextUtcMidnight(clock.now()) }
  }

  setRequestsPerMinute(perMinute: number): void {
    this.perMinute = Math.max(1, Math.floor(perMinute))
  }

  private prune(): void {
    const cutoff = this.clock.now() - MINUTE
    let drop = 0
    while (drop < this.sent.length && this.sent[drop] <= cutoff) drop++
    if (drop) this.sent.splice(0, drop)
  }

  private rollDay(): void {
    const now = this.clock.now()
    if (now >= this.daily.resetAt) this.daily = { used: 0, limit: this.daily.limit, resetAt: nextUtcMidnight(now) }
  }

  /** Milliseconds until a free request may go out without breaking the per-minute limit. */
  delay(): number {
    this.prune()
    if (this.sent.length < this.perMinute) return 0
    return Math.max(0, this.sent[this.sent.length - this.perMinute] + MINUTE - this.clock.now())
  }

  /** Counts a free request that went out. */
  record(): void {
    this.prune()
    this.rollDay()
    this.sent.push(this.clock.now())
    this.daily.used++
    if (this.daily.limit !== undefined && this.daily.used >= this.daily.limit) {
      this.close({ until: this.daily.resetAt, kind: 'free-daily', reason: 'The free tier used up its requests for today.' })
    }
  }

  /** Takes OpenRouter's own count, which also sees requests from other apps using the same key. */
  applyQuota(quota: FreeQuota): void {
    this.daily = { used: quota.used, limit: quota.limit, resetAt: quota.resetAt }
    if (quota.remaining <= 0) this.close({ until: quota.resetAt, kind: 'free-daily', reason: 'The free tier used up its requests for today.' })
    else if (this.closed?.kind === 'free-daily') this.closed = undefined
  }

  /** Closes the tier after a 429 that named the per-minute or the daily limit. */
  close(closed: NonNullable<FreeTierStatus['closed']>): void {
    if (this.closed && this.closed.until >= closed.until && this.clock.now() < this.closed.until) return
    this.closed = closed
    if (closed.kind === 'free-daily') this.daily = { ...this.daily, used: Math.max(this.daily.used, this.daily.limit ?? 0) }
  }

  /** The closure in force, if any. */
  closure(): FreeTierStatus['closed'] {
    if (this.closed && this.clock.now() >= this.closed.until) this.closed = undefined
    return this.closed
  }

  /** Requests left today, when the limit is known. */
  remaining(): number | undefined {
    this.rollDay()
    return this.daily.limit === undefined ? undefined : Math.max(0, this.daily.limit - this.daily.used)
  }

  status(): FreeTierStatus {
    this.prune()
    this.rollDay()
    const delay = this.delay()
    const limit = this.daily.limit
    return {
      provider: this.provider,
      requestsPerMinute: this.perMinute,
      sentLastMinute: this.sent.length,
      nextSlotAt: delay ? this.clock.now() + delay : undefined,
      daily: limit === undefined ? undefined : { used: this.daily.used, limit, remaining: Math.max(0, limit - this.daily.used), resetAt: this.daily.resetAt },
      closed: this.closure(),
    }
  }

  snapshot(): FreeTierSnapshot {
    this.prune()
    return { version: 1, sent: [...this.sent], daily: { ...this.daily }, closed: this.closure() }
  }

  restore(snapshot: unknown): void {
    if (!snapshot || typeof snapshot !== 'object' || (snapshot as FreeTierSnapshot).version !== 1) return
    const { sent, daily, closed } = snapshot as FreeTierSnapshot
    const now = this.clock.now()
    // A damaged snapshot must not close the tier for longer than a real limit could.
    const midnight = nextUtcMidnight(now)
    if (Array.isArray(sent)) this.sent = sent.filter((at) => Number.isFinite(at) && at <= now).sort((a, b) => a - b)
    if (daily && Number.isFinite(daily.used) && daily.used >= 0 && Number.isFinite(daily.resetAt)) {
      const limit = Number.isFinite(daily.limit) && daily.limit! >= 0 ? daily.limit : undefined
      this.daily = { used: daily.used, limit, resetAt: Math.min(daily.resetAt, midnight) }
    }
    if (closed && Number.isFinite(closed.until) && (closed.kind === 'free-rpm' || closed.kind === 'free-daily') && typeof closed.reason === 'string') {
      this.close({ until: Math.min(closed.until, closed.kind === 'free-daily' ? midnight : now + 10 * MINUTE), kind: closed.kind, reason: closed.reason })
    }
    this.prune()
    this.rollDay()
  }
}
