import type { QuotaSnapshot } from '@encode/gateway-protocol'
import type { UserLimits } from './config'
import { DAY, HOUR, MINUTE, nextUtcMidnight, utcDay } from './time'

/**
 * One account's quota: requests per minute and per day, daily token budgets,
 * concurrent streams, and the signals that flag scripted use. Pure and
 * synchronous: the Durable Object that owns an account feeds it the clock and
 * persists `state` after every call, and tests drive it directly.
 */

export type FlagReason = 'round_the_clock' | 'machine_speed'

export interface Lease {
  id: string
  at: number
  /** Input tokens counted at admission, corrected when the request ends. */
  estimate: number
}

export interface UserQuotaState {
  v: 1
  day: string
  requests: number
  inputTokens: number
  outputTokens: number
  refunds: number
  /** Admission times within the last minute, oldest first. */
  recent: number[]
  leases: Lease[]
  /** Epoch hour to request count, for the last 24 hours. */
  hours: Record<string, number>
  /** Epoch minutes within the last hour in which a request hit the per-minute limit. */
  saturated: number[]
  flag: { reason: FlagReason; until: number } | null
  suspended: boolean
  /** Session id to the time its access tokens stop being refused (when they would have expired anyway). */
  revoked: Record<string, number>
}

export interface AcquireInput {
  leaseId: string
  sessionId: string
  estimatedInputTokens: number
  /** The control plane's fair-share multiplier, from 0 to 1. */
  scale: number
}

export type AcquireRejection =
  | 'invalid_token'
  | 'account_suspended'
  | 'rate_limited'
  | 'concurrency_limited'
  | 'daily_quota_exhausted'
  | 'token_quota_exhausted'

export type AcquireResult =
  | { ok: true; remaining: number; resetAt: number; firstToday: boolean; flagged: FlagReason | null; newlyFlagged: boolean }
  | { ok: false; code: AcquireRejection; message: string; retryAfterMs?: number; newlyFlagged: boolean }

export interface ReleaseInput {
  leaseId: string
  /** Real prompt tokens when the upstream reported them. */
  inputTokens?: number
  outputTokens: number
  /** Hand the request back: the upstream failed and the account got nothing. */
  refund: boolean
}

const FLAG_DURATION = DAY

export function emptyUserQuota(now: number): UserQuotaState {
  return {
    v: 1,
    day: utcDay(now),
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    refunds: 0,
    recent: [],
    leases: [],
    hours: {},
    saturated: [],
    flag: null,
    suspended: false,
    revoked: {},
  }
}

export class UserQuota {
  readonly state: UserQuotaState

  constructor(state: UserQuotaState | undefined, now: number) {
    this.state = state?.v === 1 ? state : emptyUserQuota(now)
  }

  private tidy(limits: UserLimits, now: number): void {
    const s = this.state
    const today = utcDay(now)
    if (s.day !== today) {
      s.day = today
      s.requests = 0
      s.inputTokens = 0
      s.outputTokens = 0
      s.refunds = 0
    }
    s.recent = s.recent.filter((at) => at > now - MINUTE)
    s.leases = s.leases.filter((lease) => lease.at + limits.leaseTtlMs > now)
    const oldestHour = Math.floor((now - DAY) / HOUR)
    for (const hour of Object.keys(s.hours)) if (Number(hour) <= oldestHour) delete s.hours[hour]
    s.saturated = s.saturated.filter((minute) => minute > Math.floor((now - HOUR) / MINUTE))
    for (const [session, until] of Object.entries(s.revoked)) if (until <= now) delete s.revoked[session]
    if (s.flag && s.flag.until <= now) s.flag = null
  }

  /** Raises a flag the first time a pattern shows; true when this call raised it. */
  private detect(limits: UserLimits, now: number): boolean {
    const s = this.state
    let reason: FlagReason | null = null
    if (Object.keys(s.hours).length >= limits.flagActiveHours) reason = 'round_the_clock'
    else if (new Set(s.saturated).size >= limits.flagSaturatedMinutes) reason = 'machine_speed'
    if (!reason) return false
    const raised = s.flag === null
    s.flag = { reason, until: now + FLAG_DURATION }
    return raised
  }

  private caps(limits: UserLimits, scale: number) {
    const factor = Math.max(0, Math.min(1, scale)) * (this.state.flag ? limits.flaggedScale : 1)
    return {
      requests: Math.max(1, Math.floor(limits.requestsPerDay * factor)),
      inputTokens: Math.max(1, Math.floor(limits.inputTokensPerDay * factor)),
      outputTokens: Math.max(1, Math.floor(limits.outputTokensPerDay * factor)),
    }
  }

  acquire(input: AcquireInput, limits: UserLimits, now: number): AcquireResult {
    this.tidy(limits, now)
    const s = this.state
    const resetAt = nextUtcMidnight(now)
    const untilReset = resetAt - now

    if (s.revoked[input.sessionId] !== undefined) {
      return { ok: false, code: 'invalid_token', message: 'This session was signed out. Sign in again.', newlyFlagged: false }
    }
    if (s.suspended) {
      return { ok: false, code: 'account_suspended', message: 'This account cannot use the free tier.', newlyFlagged: false }
    }

    const caps = this.caps(limits, input.scale)
    if (s.requests >= caps.requests) {
      return {
        ok: false,
        code: 'daily_quota_exhausted',
        message: `You have used today's ${caps.requests} free requests. They reset at midnight UTC.`,
        retryAfterMs: untilReset,
        newlyFlagged: false,
      }
    }
    if (s.inputTokens + input.estimatedInputTokens > caps.inputTokens || s.outputTokens >= caps.outputTokens) {
      return {
        ok: false,
        code: 'token_quota_exhausted',
        message: "This request would pass today's free token budget. It resets at midnight UTC.",
        retryAfterMs: untilReset,
        newlyFlagged: false,
      }
    }
    if (s.recent.length >= limits.requestsPerMinute) {
      s.saturated.push(Math.floor(now / MINUTE))
      const newlyFlagged = this.detect(limits, now)
      return {
        ok: false,
        code: 'rate_limited',
        message: `The free tier allows ${limits.requestsPerMinute} requests a minute.`,
        retryAfterMs: Math.max(1, s.recent[0] + MINUTE - now),
        newlyFlagged,
      }
    }
    if (s.leases.length >= limits.maxConcurrent) {
      return {
        ok: false,
        code: 'concurrency_limited',
        message: `The free tier runs ${limits.maxConcurrent} requests at a time per account.`,
        retryAfterMs: 2_000,
        newlyFlagged: false,
      }
    }

    s.requests += 1
    s.inputTokens += input.estimatedInputTokens
    s.recent.push(now)
    s.leases.push({ id: input.leaseId, at: now, estimate: input.estimatedInputTokens })
    const hour = String(Math.floor(now / HOUR))
    s.hours[hour] = (s.hours[hour] ?? 0) + 1
    const newlyFlagged = this.detect(limits, now)
    return {
      ok: true,
      remaining: Math.max(0, caps.requests - s.requests),
      resetAt,
      firstToday: s.requests === 1,
      flagged: s.flag?.reason ?? null,
      newlyFlagged,
    }
  }

  /** Ends a request and settles its real token use. Releasing the same lease again does nothing. */
  release(input: ReleaseInput, limits: UserLimits, now: number): void {
    this.tidy(limits, now)
    const s = this.state
    const index = s.leases.findIndex((lease) => lease.id === input.leaseId)
    const lease = index >= 0 ? s.leases.splice(index, 1)[0] : undefined
    if (!lease) return
    if (input.refund && s.refunds < limits.refundsPerDay && s.requests > 0) {
      s.requests -= 1
      s.refunds += 1
      s.inputTokens = Math.max(0, s.inputTokens - lease.estimate)
      return
    }
    if (input.inputTokens !== undefined && Number.isFinite(input.inputTokens) && input.inputTokens >= 0) {
      s.inputTokens = Math.max(0, s.inputTokens - lease.estimate + Math.round(input.inputTokens))
    }
    if (Number.isFinite(input.outputTokens) && input.outputTokens > 0) s.outputTokens += Math.round(input.outputTokens)
  }

  isRevoked(sessionId: string, limits: UserLimits, now: number): boolean {
    this.tidy(limits, now)
    return this.state.revoked[sessionId] !== undefined
  }

  snapshot(limits: UserLimits, scale: number, now: number): QuotaSnapshot {
    this.tidy(limits, now)
    const s = this.state
    const caps = this.caps(limits, scale)
    return {
      requests: { used: s.requests, limit: caps.requests, remaining: Math.max(0, caps.requests - s.requests) },
      input_tokens: { used: s.inputTokens, limit: caps.inputTokens },
      output_tokens: { used: s.outputTokens, limit: caps.outputTokens },
      requests_per_minute: limits.requestsPerMinute,
      concurrent_streams: limits.maxConcurrent,
      reset_at: nextUtcMidnight(now),
    }
  }

  revoke(sessionId: string, until: number): void {
    this.state.revoked[sessionId] = Math.max(this.state.revoked[sessionId] ?? 0, until)
  }

  setSuspended(suspended: boolean): void {
    this.state.suspended = suspended
    if (suspended) this.state.leases = []
  }

  clearFlag(): void {
    this.state.flag = null
    this.state.hours = {}
    this.state.saturated = []
  }
}

/** Fixed-window counters for per-address limits on the sign-in endpoints. */
export interface WindowRule {
  name: string
  limit: number
  windowMs: number
}

export type WindowState = Record<string, { start: number; count: number }>

export function hitWindows(state: WindowState, rules: readonly WindowRule[], now: number): { ok: true } | { ok: false; retryAfterMs: number } {
  for (const rule of rules) {
    const window = state[rule.name]
    if (window && window.start + rule.windowMs > now && window.count >= rule.limit) {
      return { ok: false, retryAfterMs: window.start + rule.windowMs - now }
    }
  }
  for (const rule of rules) {
    const window = state[rule.name]
    if (!window || window.start + rule.windowMs <= now) state[rule.name] = { start: now, count: 1 }
    else window.count += 1
  }
  return { ok: true }
}
