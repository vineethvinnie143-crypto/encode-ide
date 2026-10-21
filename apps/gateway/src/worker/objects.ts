import { DurableObject } from 'cloudflare:workers'
import type { QuotaSnapshot } from '@encode/gateway-protocol'
import type { GatewayConfig } from '../core/config'
import { Control, type Admission, type Alert, type AttemptReport, type ControlState, type ControlStatus, type DayMetrics, type KeySnapshot } from '../core/control'
import {
  hitWindows,
  UserQuota,
  type AcquireInput,
  type AcquireResult,
  type ReleaseInput,
  type UserQuotaState,
  type WindowRule,
  type WindowState,
} from '../core/user-quota'
import { configFor, type Env } from './env'

/**
 * The Durable Objects that hold the gateway's counters. Each one keeps its
 * state as a single value in its own SQLite-backed storage and changes it in
 * one synchronous step per call, so concurrent requests can never interleave
 * inside an update. The logic lives in src/core; these classes only load and
 * save it. They are reached through RPC from this Worker alone.
 */

const STATE = 'state'

function configOrThrow(env: Env): GatewayConfig {
  const result = configFor(env)
  if (!result.ok) throw new Error('The gateway configuration is invalid.')
  return result.config
}

/** One per account, named by the account id: its quotas, running requests, flags and signed-out sessions. */
export class UserQuotaObject extends DurableObject<Env> {
  private readonly config = configOrThrow(this.env)

  private update<T>(change: (quota: UserQuota, now: number) => T): T {
    const now = Date.now()
    const quota = new UserQuota(this.ctx.storage.kv.get<UserQuotaState>(STATE), now)
    const result = change(quota, now)
    this.ctx.storage.kv.put(STATE, quota.state)
    return result
  }

  acquire(input: AcquireInput): AcquireResult {
    return this.update((quota, now) => quota.acquire(input, this.config.user, now))
  }

  release(input: ReleaseInput): void {
    this.update((quota, now) => quota.release(input, this.config.user, now))
  }

  snapshot(scale: number, sessionId: string): QuotaSnapshot | null {
    return this.update((quota, now) => (quota.isRevoked(sessionId, this.config.user, now) ? null : quota.snapshot(this.config.user, scale, now)))
  }

  revokeSession(sessionId: string, until: number): void {
    this.update((quota) => quota.revoke(sessionId, until))
  }

  setSuspended(suspended: boolean): void {
    this.update((quota) => quota.setSuspended(suspended))
  }

  clearFlag(): void {
    this.update((quota) => quota.clearFlag())
  }
}

/** The one global instance (named "global"): the daily budget, upstream pacing, model health, metrics and alerts. */
export class ControlObject extends DurableObject<Env> {
  private readonly config = configOrThrow(this.env)

  private update<T>(change: (control: Control, now: number) => T): T {
    const now = Date.now()
    const control = new Control(this.ctx.storage.kv.get<ControlState>(STATE), now)
    const result = change(control, now)
    this.ctx.storage.kv.put(STATE, control.state)
    return result
  }

  admit(input: { firstAttempt: boolean; newActiveUser: boolean }): Admission {
    return this.update((control, now) => control.admit(input, this.config.global, now))
  }

  cancel(slot: number): void {
    this.update((control, now) => control.cancel(slot, now))
  }

  report(report: AttemptReport): void {
    this.update((control, now) => control.report(report, now))
  }

  status(): ControlStatus {
    return this.update((control, now) => control.status(this.config.global, now))
  }

  updateKey(snapshot: KeySnapshot): void {
    this.update((control, now) => control.updateKey(snapshot, now))
  }

  flagged(logId: string, reason: string): void {
    this.update((control, now) => control.flagged(logId, reason, now))
  }

  takeAlerts(): Alert[] {
    return this.update((control, now) => control.takeAlerts(this.config.global, this.config.alerts, now))
  }

  metrics(days: number): DayMetrics[] {
    return this.update((control, now) => control.metrics(days, now))
  }

  latency(): Record<string, number> {
    return this.update((control) => control.latency())
  }
}

const UNTIL = 'until'

/**
 * One per client network (a keyed hash of its address, never the address):
 * fixed-window limits on the sign-in endpoints. It deletes itself once its
 * windows have passed, so storage does not grow with every address ever seen.
 */
export class AddressLimiterObject extends DurableObject<Env> {
  async hit(rules: WindowRule[]): Promise<{ ok: true } | { ok: false; retryAfterMs: number }> {
    const now = Date.now()
    const kv = this.ctx.storage.kv
    const state = kv.get<WindowState>(STATE) ?? {}
    const verdict = hitWindows(state, rules, now)
    kv.put(STATE, state)
    const until = Math.max(kv.get<number>(UNTIL) ?? 0, ...rules.map((rule) => (state[rule.name]?.start ?? now) + rule.windowMs))
    kv.put(UNTIL, until)
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(until)
    return verdict
  }

  async alarm(): Promise<void> {
    const until = this.ctx.storage.kv.get<number>(UNTIL) ?? 0
    if (Date.now() >= until) await this.ctx.storage.deleteAll()
    else await this.ctx.storage.setAlarm(until)
  }
}
