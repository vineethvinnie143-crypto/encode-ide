import type { GlobalLimits } from './config'
import { MINUTE, nextUtcMidnight, SECOND, utcDay } from './time'

/**
 * The global control plane: one instance for the whole gateway, owned by a
 * single Durable Object so every isolate sees the same numbers.
 *
 * - The daily free budget: our own ceiling, OpenRouter's reported counters,
 *   and the fair share that per-account limits shrink to as it runs low.
 * - Upstream pacing: never more than `requestsPerMinute` starts in any
 *   rolling minute, queued first-come first-served for a few seconds at most.
 * - Model health: a failing model cools down from 30 s, doubling to 15 min,
 *   and the next request after the cooldown is its probe.
 * - Metrics and alerts, which hold metadata only.
 *
 * Pure and synchronous like UserQuota; the owner persists `state`.
 */

export type AttemptOutcome =
  /** The model streamed an answer. */
  | 'ok'
  /** This model's provider is rate limited. */
  | 'rate_limited'
  /** OpenRouter's account-wide per-minute limit. */
  | 'account_limited'
  /** OpenRouter's account-wide daily free limit. */
  | 'daily_exhausted'
  | 'error'
  | 'timeout'
  /** The model is gone from OpenRouter. */
  | 'not_found'
  /** The request was refused as invalid or flagged; it says nothing about the model's health. */
  | 'rejected'
  /** A negative balance or exhausted credit on our key. */
  | 'payment_required'
  /** Our key was refused. */
  | 'unauthorized'
  /** The client left. */
  | 'client_closed'

export interface ModelHealth {
  failures: number
  cooldownMs: number
  coolingUntil: number
}

/** Bucket upper bounds for time to first token, in ms. */
export const TTFT_BUCKETS = [250, 500, 1_000, 2_000, 4_000, 8_000, 16_000, 32_000, Number.POSITIVE_INFINITY] as const

export interface ModelMetrics {
  attempts: number
  ok: number
  rateLimited: number
  errors: number
  timeouts: number
  rejected: number
  ttft: number[]
  inputTokens: number
  outputTokens: number
}

export interface DayMetrics {
  day: string
  requests: number
  attempts: number
  busy: number
  exhausted: number
  activeUsers: number
  models: Record<string, ModelMetrics>
}

export interface KeySnapshot {
  /** OpenRouter's free requests a day for the account, and today's count; null when the answer lacks them. */
  free: { limit: number; used: number; remaining: number } | null
  /** Credits our key spent today. Anything above zero means a request was not free. */
  creditsUsedToday: number
  /** The key's credit limit and what is left of it; null when the key has no limit. */
  creditLimit: number | null
  creditLimitRemaining: number | null
}

export interface Alert {
  key: string
  severity: 'warning' | 'critical'
  message: string
}

export interface ControlState {
  v: 1
  day: string
  /** Upstream attempts admitted today. */
  attempts: number
  /** Scheduled upstream start times, ascending, for the last minute and the queue. */
  starts: number[]
  key: (KeySnapshot & { fetchedAt: number; day: string; attemptsAtFetch: number }) | null
  pausedUntil: number
  exhaustedUntil: number
  exhaustedReason: 'budget' | 'openrouter' | 'payment' | 'key' | null
  health: Record<string, ModelHealth>
  metrics: DayMetrics
  history: DayMetrics[]
  /** Alert key to the day it was raised, so each fires once a day. */
  raised: Record<string, string>
  pending: Alert[]
}

export type Admission =
  | { ok: true; slot: number; waitMs: number; scale: number; coolingUntil: Record<string, number> }
  | { ok: false; code: 'free_tier_exhausted' | 'free_tier_busy'; message: string; retryAfterMs: number }

export interface AttemptReport {
  model: string
  outcome: AttemptOutcome
  ttftMs?: number
  inputTokens?: number
  outputTokens?: number
  retryAfterMs?: number
}

export interface ControlStatus {
  available: boolean
  message?: string
  availableAt?: number
  limit: number
  used: number
  remaining: number
  scale: number
  pausedUntil: number
  cooling: string[]
}

export interface AlertThresholds {
  quotaFraction: number
  modelErrorRate: number
  minSamples: number
}

export const COOLDOWN_BASE_MS = 30 * SECOND
export const COOLDOWN_MAX_MS = 15 * MINUTE
const HISTORY_DAYS = 14
const MAX_ACCOUNT_PAUSE_MS = MINUTE
const PROBLEM_PAUSE_MS = 15 * MINUTE

function emptyDay(day: string): DayMetrics {
  return { day, requests: 0, attempts: 0, busy: 0, exhausted: 0, activeUsers: 0, models: {} }
}

function emptyModelMetrics(): ModelMetrics {
  return { attempts: 0, ok: 0, rateLimited: 0, errors: 0, timeouts: 0, rejected: 0, ttft: TTFT_BUCKETS.map(() => 0), inputTokens: 0, outputTokens: 0 }
}

export function emptyControl(now: number): ControlState {
  const day = utcDay(now)
  return {
    v: 1,
    day,
    attempts: 0,
    starts: [],
    key: null,
    pausedUntil: 0,
    exhaustedUntil: 0,
    exhaustedReason: null,
    health: {},
    metrics: emptyDay(day),
    history: [],
    raised: {},
    pending: [],
  }
}

/** The bucket bound at or above the `fraction` quantile; 0 with no samples. */
export function quantile(buckets: readonly number[], fraction: number): number {
  const total = buckets.reduce((sum, count) => sum + count, 0)
  if (!total) return 0
  let seen = 0
  for (let index = 0; index < buckets.length; index++) {
    seen += buckets[index]
    if (seen >= fraction * total) return Number.isFinite(TTFT_BUCKETS[index]) ? TTFT_BUCKETS[index] : 60_000
  }
  return 60_000
}

export class Control {
  readonly state: ControlState

  constructor(state: ControlState | undefined, now: number) {
    this.state = state?.v === 1 ? state : emptyControl(now)
  }

  private rollover(now: number): void {
    const s = this.state
    const today = utcDay(now)
    if (s.day === today) return
    s.history = [s.metrics, ...s.history].slice(0, HISTORY_DAYS)
    s.metrics = emptyDay(today)
    s.day = today
    s.attempts = 0
    if (s.exhaustedReason === 'budget' || s.exhaustedReason === 'openrouter') {
      s.exhaustedUntil = 0
      s.exhaustedReason = null
    }
    for (const [key, day] of Object.entries(s.raised)) if (day !== today) delete s.raised[key]
  }

  private budget(limits: GlobalLimits): { limit: number; used: number; remaining: number } {
    const s = this.state
    const key = s.key && s.key.day === s.day ? s.key : null
    const free = key?.free ?? null
    const limit = Math.max(0, Math.min(limits.requestsPerDay, free ? free.limit : Number.POSITIVE_INFINITY))
    const used = Math.max(s.attempts, key && free ? free.used + Math.max(0, s.attempts - key.attemptsAtFetch) : 0)
    return { limit, used, remaining: Math.max(0, limit - used) }
  }

  /** The fair-share multiplier for per-account daily limits: 1 until the budget runs low, then shrinking to the floor. */
  scale(limits: GlobalLimits): number {
    const { limit, remaining } = this.budget(limits)
    if (!limit) return limits.fairShareFloor
    const left = remaining / limit
    if (left >= limits.fairShareStart) return 1
    return Math.max(limits.fairShareFloor, left / limits.fairShareStart)
  }

  private coolingUntil(now: number): Record<string, number> {
    const out: Record<string, number> = {}
    for (const [model, health] of Object.entries(this.state.health)) if (health.coolingUntil > now) out[model] = health.coolingUntil
    return out
  }

  private exhausted(now: number): Admission & { ok: false } {
    const s = this.state
    s.metrics.exhausted += 1
    const message =
      s.exhaustedReason === 'payment' || s.exhaustedReason === 'key'
        ? 'The free tier is unavailable for a few minutes.'
        : "Today's shared free requests are used up. The free tier is back at midnight UTC."
    return { ok: false, code: 'free_tier_exhausted', message, retryAfterMs: Math.max(SECOND, s.exhaustedUntil - now) }
  }

  /**
   * Reserves one upstream start. `firstAttempt` marks a new request (not a
   * failover) and `newActiveUser` an account's first request of the day.
   */
  admit(input: { firstAttempt: boolean; newActiveUser: boolean }, limits: GlobalLimits, now: number): Admission {
    this.rollover(now)
    const s = this.state
    if (s.exhaustedUntil > now) return this.exhausted(now)
    if (this.budget(limits).remaining <= 0) {
      s.exhaustedUntil = nextUtcMidnight(now)
      s.exhaustedReason = 'budget'
      return this.exhausted(now)
    }

    s.starts = s.starts.filter((at) => at > now - MINUTE)
    let slot = Math.max(now, s.pausedUntil, s.starts.length ? s.starts[s.starts.length - 1] : 0)
    if (s.starts.length >= limits.requestsPerMinute) {
      slot = Math.max(slot, s.starts[s.starts.length - limits.requestsPerMinute] + MINUTE)
    }
    const waitMs = slot - now
    if (waitMs > limits.maxQueueWaitMs) {
      s.metrics.busy += 1
      return {
        ok: false,
        code: 'free_tier_busy',
        message: 'The free tier is busy. Try again in a few seconds.',
        retryAfterMs: waitMs,
      }
    }

    s.starts.push(slot)
    s.attempts += 1
    s.metrics.attempts += 1
    if (input.firstAttempt) s.metrics.requests += 1
    if (input.newActiveUser) s.metrics.activeUsers += 1
    return { ok: true, slot, waitMs, scale: this.scale(limits), coolingUntil: this.coolingUntil(now) }
  }

  /** Hands back a reserved start that was never used. */
  cancel(slot: number, now: number): void {
    this.rollover(now)
    const s = this.state
    const index = s.starts.lastIndexOf(slot)
    if (index < 0) return
    s.starts.splice(index, 1)
    s.attempts = Math.max(0, s.attempts - 1)
    s.metrics.attempts = Math.max(0, s.metrics.attempts - 1)
  }

  report(report: AttemptReport, now: number): void {
    this.rollover(now)
    const s = this.state
    const metrics = (s.metrics.models[report.model] ??= emptyModelMetrics())
    const health = (s.health[report.model] ??= { failures: 0, cooldownMs: COOLDOWN_BASE_MS, coolingUntil: 0 })
    const fail = (coolMs: number) => {
      health.failures += 1
      health.coolingUntil = Math.max(health.coolingUntil, now + coolMs)
    }

    if (report.outcome !== 'client_closed') metrics.attempts += 1
    switch (report.outcome) {
      case 'ok':
        metrics.ok += 1
        health.failures = 0
        health.cooldownMs = COOLDOWN_BASE_MS
        health.coolingUntil = 0
        if (report.ttftMs !== undefined && report.ttftMs >= 0) {
          const bucket = TTFT_BUCKETS.findIndex((bound) => report.ttftMs! <= bound)
          metrics.ttft[bucket] += 1
        }
        metrics.inputTokens += Math.max(0, Math.round(report.inputTokens ?? 0))
        metrics.outputTokens += Math.max(0, Math.round(report.outputTokens ?? 0))
        break
      case 'rate_limited':
        metrics.rateLimited += 1
        // A provider's reset time beats our own guess.
        if (report.retryAfterMs !== undefined) fail(Math.min(COOLDOWN_MAX_MS, Math.max(SECOND, report.retryAfterMs)))
        else {
          fail(health.cooldownMs)
          health.cooldownMs = Math.min(COOLDOWN_MAX_MS, health.cooldownMs * 2)
        }
        break
      case 'error':
      case 'timeout':
        if (report.outcome === 'error') metrics.errors += 1
        else metrics.timeouts += 1
        fail(health.cooldownMs)
        health.cooldownMs = Math.min(COOLDOWN_MAX_MS, health.cooldownMs * 2)
        break
      case 'not_found':
        metrics.errors += 1
        fail(COOLDOWN_MAX_MS)
        break
      case 'rejected':
        metrics.rejected += 1
        break
      case 'account_limited':
        metrics.rateLimited += 1
        s.pausedUntil = Math.max(s.pausedUntil, now + Math.min(MAX_ACCOUNT_PAUSE_MS, Math.max(SECOND, report.retryAfterMs ?? 10 * SECOND)))
        break
      case 'daily_exhausted':
        metrics.rateLimited += 1
        s.exhaustedUntil = Math.min(nextUtcMidnight(now), now + Math.max(MINUTE, report.retryAfterMs ?? Number.POSITIVE_INFINITY))
        s.exhaustedReason = 'openrouter'
        this.raise({ key: 'free_quota_exhausted', severity: 'warning', message: "OpenRouter reports the account's daily free requests are used up." })
        break
      case 'payment_required':
        metrics.errors += 1
        s.exhaustedUntil = now + PROBLEM_PAUSE_MS
        s.exhaustedReason = 'payment'
        this.raise({ key: 'payment_required', severity: 'critical', message: 'OpenRouter refused the free-tier key with 402: the account balance is negative or the key is out of credit.' })
        break
      case 'unauthorized':
        metrics.errors += 1
        s.exhaustedUntil = now + PROBLEM_PAUSE_MS
        s.exhaustedReason = 'key'
        this.raise({ key: 'key_refused', severity: 'critical', message: 'OpenRouter refused the free-tier key with 401. Check OPENROUTER_API_KEY.' })
        break
      case 'client_closed':
        break
    }
  }

  /** Takes OpenRouter's own counters for our key (GET /api/v1/key). */
  updateKey(snapshot: KeySnapshot, now: number): void {
    this.rollover(now)
    const s = this.state
    s.key = { ...snapshot, fetchedAt: now, day: s.day, attemptsAtFetch: s.attempts }
    if (snapshot.free && snapshot.free.remaining <= 0) {
      if (s.exhaustedUntil <= now) {
        s.exhaustedUntil = nextUtcMidnight(now)
        s.exhaustedReason = 'openrouter'
      }
    } else if (snapshot.free && s.exhaustedReason === 'openrouter') {
      s.exhaustedUntil = 0
      s.exhaustedReason = null
    }
    if (snapshot.creditsUsedToday > 0) {
      this.raise({
        key: 'paid_usage',
        severity: 'critical',
        message: `The free-tier key spent ${snapshot.creditsUsedToday} credits today. Free requests cost nothing, so something was billed: check the cost firewall and the key's activity.`,
      })
    }
    if (snapshot.creditLimit !== null && snapshot.creditLimitRemaining !== null && snapshot.creditLimitRemaining < snapshot.creditLimit * 0.2) {
      this.raise({ key: 'credit_low', severity: 'warning', message: 'The free-tier key has less than 20% of its credit limit left.' })
    }
  }

  status(limits: GlobalLimits, now: number): ControlStatus {
    this.rollover(now)
    const s = this.state
    const budget = this.budget(limits)
    const cooling = Object.keys(this.coolingUntil(now))
    const exhausted = s.exhaustedUntil > now || budget.remaining <= 0
    const scale = this.scale(limits)
    const base = { ...budget, scale, pausedUntil: s.pausedUntil, cooling }
    if (exhausted) {
      return {
        ...base,
        available: false,
        message: "Today's shared free requests are used up. Your own keys still work.",
        availableAt: s.exhaustedUntil > now ? s.exhaustedUntil : nextUtcMidnight(now),
      }
    }
    if (scale < 1) return { ...base, available: true, message: 'The free tier is busy today, so daily limits are lower than usual.' }
    return { ...base, available: true }
  }

  private raise(alert: Alert): void {
    const s = this.state
    if (s.raised[alert.key] === s.day) return
    s.raised[alert.key] = s.day
    s.pending.push(alert)
  }

  /** Records a flagged account; the alert names it only by its log id. */
  flagged(logId: string, reason: string, now: number): void {
    this.rollover(now)
    this.raise({ key: `flagged:${logId}`, severity: 'warning', message: `Account ${logId} was flagged for ${reason.replace(/_/g, ' ')} use and runs on reduced limits for a day.` })
  }

  /** Alerts due now, each once a day. The caller delivers them. */
  takeAlerts(limits: GlobalLimits, thresholds: AlertThresholds, now: number): Alert[] {
    this.rollover(now)
    const s = this.state
    const budget = this.budget(limits)
    if (budget.limit && budget.used >= budget.limit * thresholds.quotaFraction) {
      this.raise({
        key: 'quota_high',
        severity: 'warning',
        message: `The free tier has used ${budget.used} of ${budget.limit} requests today (${Math.round((budget.used / budget.limit) * 100)}%).`,
      })
    }
    for (const [model, metrics] of Object.entries(s.metrics.models)) {
      const failures = metrics.errors + metrics.timeouts
      if (metrics.attempts >= thresholds.minSamples && failures / metrics.attempts > thresholds.modelErrorRate) {
        this.raise({
          key: `model_errors:${model}`,
          severity: 'warning',
          message: `${model} failed ${failures} of ${metrics.attempts} attempts today (${Math.round((failures / metrics.attempts) * 100)}%).`,
        })
      }
    }
    const due = s.pending
    s.pending = []
    return due
  }

  /** Median time to first token per model over today and yesterday, for ordering the fast pool. */
  latency(): Record<string, number> {
    const merged: Record<string, number[]> = {}
    for (const day of [this.state.metrics, ...this.state.history.slice(0, 1)]) {
      for (const [model, metrics] of Object.entries(day.models)) {
        const buckets = (merged[model] ??= TTFT_BUCKETS.map(() => 0))
        metrics.ttft.forEach((count, index) => (buckets[index] += count))
      }
    }
    const out: Record<string, number> = {}
    for (const [model, buckets] of Object.entries(merged)) {
      const median = quantile(buckets, 0.5)
      if (median) out[model] = median
    }
    return out
  }

  metrics(days: number, now: number): DayMetrics[] {
    this.rollover(now)
    return [this.state.metrics, ...this.state.history].slice(0, Math.max(1, Math.min(HISTORY_DAYS + 1, days)))
  }
}
