import type { QuotaSnapshot } from '@encode/gateway-protocol'
import type { GatewayConfig } from '../core/config'
import { Control, type Admission, type Alert, type AttemptReport, type ControlStatus, type DayMetrics, type KeySnapshot } from '../core/control'
import type { PoolDocument, PoolOverrides } from '../core/pool'
import type {
  Account,
  AccountStore,
  AddressLimiterPort,
  ConfigStore,
  ControlPort,
  GitHubIdentity,
  KillSwitch,
  LogValue,
  Logger,
  Session,
  UserQuotaPort,
} from '../core/ports'
import { hitWindows, UserQuota, type AcquireInput, type AcquireResult, type ReleaseInput, type WindowRule, type WindowState } from '../core/user-quota'

/**
 * In-memory stand-ins for the Cloudflare bindings. They run the same pure
 * cores the Durable Objects run, and round-trip state through JSON on every
 * call, as Durable Object storage does, so a test cannot lean on shared
 * object references the real thing would not have.
 */

const clone = <T>(value: T): T => (value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T))

export class MemoryUsers implements UserQuotaPort {
  readonly states = new Map<string, unknown>()

  constructor(
    private readonly config: GatewayConfig,
    private readonly now: () => number,
  ) {}

  private with<T>(accountId: string, run: (quota: UserQuota) => T): T {
    const quota = new UserQuota(clone(this.states.get(accountId)) as never, this.now())
    const result = run(quota)
    this.states.set(accountId, clone(quota.state))
    return clone(result)
  }

  async acquire(accountId: string, input: AcquireInput): Promise<AcquireResult> {
    return this.with(accountId, (quota) => quota.acquire(input, this.config.user, this.now()))
  }

  async release(accountId: string, input: ReleaseInput): Promise<void> {
    this.with(accountId, (quota) => quota.release(input, this.config.user, this.now()))
  }

  async snapshot(accountId: string, scale: number, sessionId: string): Promise<QuotaSnapshot | null> {
    return this.with(accountId, (quota) =>
      quota.isRevoked(sessionId, this.config.user, this.now()) ? null : quota.snapshot(this.config.user, scale, this.now()),
    )
  }

  async revokeSession(accountId: string, sessionId: string, until: number): Promise<void> {
    this.with(accountId, (quota) => quota.revoke(sessionId, until))
  }

  async setSuspended(accountId: string, suspended: boolean): Promise<void> {
    this.with(accountId, (quota) => quota.setSuspended(suspended))
  }

  async clearFlag(accountId: string): Promise<void> {
    this.with(accountId, (quota) => quota.clearFlag())
  }
}

export class MemoryControl implements ControlPort {
  state: unknown = undefined
  readonly reports: AttemptReport[] = []

  constructor(
    private readonly config: GatewayConfig,
    private readonly now: () => number,
  ) {}

  private with<T>(run: (control: Control) => T): T {
    const control = new Control(clone(this.state) as never, this.now())
    const result = run(control)
    this.state = clone(control.state)
    return clone(result)
  }

  async admit(input: { firstAttempt: boolean; newActiveUser: boolean }): Promise<Admission> {
    return this.with((control) => control.admit(input, this.config.global, this.now()))
  }

  async cancel(slot: number): Promise<void> {
    this.with((control) => control.cancel(slot, this.now()))
  }

  async report(report: AttemptReport): Promise<void> {
    this.reports.push(clone(report))
    this.with((control) => control.report(report, this.now()))
  }

  async status(): Promise<ControlStatus> {
    return this.with((control) => control.status(this.config.global, this.now()))
  }

  async updateKey(snapshot: KeySnapshot): Promise<void> {
    this.with((control) => control.updateKey(snapshot, this.now()))
  }

  async flagged(logId: string, reason: string): Promise<void> {
    this.with((control) => control.flagged(logId, reason, this.now()))
  }

  async takeAlerts(): Promise<Alert[]> {
    return this.with((control) => control.takeAlerts(this.config.global, this.config.alerts, this.now()))
  }

  async metrics(days: number): Promise<DayMetrics[]> {
    return this.with((control) => control.metrics(days, this.now()))
  }

  async latency(): Promise<Record<string, number>> {
    return this.with((control) => control.latency())
  }
}

export class MemoryAddresses implements AddressLimiterPort {
  readonly states = new Map<string, WindowState>()

  constructor(private readonly now: () => number) {}

  async hit(bucket: string, rules: WindowRule[]): Promise<{ ok: true } | { ok: false; retryAfterMs: number }> {
    const state = clone(this.states.get(bucket) ?? {})
    const verdict = hitWindows(state, rules, this.now())
    this.states.set(bucket, state)
    return verdict
  }
}

export class MemoryConfigStore implements ConfigStore {
  kill: KillSwitch = { on: false, message: '' }
  doc: PoolDocument | null = null
  poolOverrides: PoolOverrides = {}

  async killSwitch(): Promise<KillSwitch> {
    return clone(this.kill)
  }

  async setKillSwitch(value: KillSwitch): Promise<void> {
    this.kill = clone(value)
  }

  async pool(): Promise<PoolDocument | null> {
    return this.doc ? clone(this.doc) : null
  }

  async setPool(doc: PoolDocument): Promise<void> {
    this.doc = clone(doc)
  }

  async overrides(): Promise<PoolOverrides> {
    return clone(this.poolOverrides)
  }

  async setOverrides(value: PoolOverrides): Promise<void> {
    this.poolOverrides = clone(value)
  }
}

export class MemoryAccounts implements AccountStore {
  readonly accounts = new Map<string, Account>()
  readonly sessions = new Map<string, Session>()
  readonly allowed = new Map<string, number | null>()

  async upsertFromGitHub(identity: GitHubIdentity, now: number, newId: string): Promise<Account> {
    const existing = [...this.accounts.values()].find((account) => account.githubId === identity.id)
    const account: Account = existing
      ? { ...existing, login: identity.login, ...(identity.avatarUrl ? { avatarUrl: identity.avatarUrl } : {}), lastSignInAt: now }
      : {
          id: newId,
          githubId: identity.id,
          login: identity.login,
          ...(identity.avatarUrl ? { avatarUrl: identity.avatarUrl } : {}),
          status: 'active',
          createdAt: now,
          lastSignInAt: now,
        }
    this.accounts.set(account.id, account)
    return clone(account)
  }

  async getAccount(id: string): Promise<Account | null> {
    const account = this.accounts.get(id)
    return account ? clone(account) : null
  }

  async findByGitHubId(githubId: number): Promise<Account | null> {
    const account = [...this.accounts.values()].find((entry) => entry.githubId === githubId)
    return account ? clone(account) : null
  }

  async findByLogin(login: string): Promise<Account | null> {
    const account = [...this.accounts.values()].find((entry) => entry.login.toLowerCase() === login.toLowerCase())
    return account ? clone(account) : null
  }

  async setStatus(accountId: string, status: Account['status'], reason: string | null): Promise<void> {
    const account = this.accounts.get(accountId)
    if (!account) return
    account.status = status
    if (reason) account.statusReason = reason
    else delete account.statusReason
  }

  async allowlisted(login: string, githubId: number): Promise<boolean> {
    const key = login.toLowerCase()
    if (!this.allowed.has(key)) return false
    const bound = this.allowed.get(key)
    if (bound === null || bound === undefined) {
      this.allowed.set(key, githubId)
      return true
    }
    return bound === githubId
  }

  async allow(login: string): Promise<void> {
    if (!this.allowed.has(login.toLowerCase())) this.allowed.set(login.toLowerCase(), null)
  }

  async disallow(login: string): Promise<void> {
    this.allowed.delete(login.toLowerCase())
  }

  async listAllowed(): Promise<string[]> {
    return [...this.allowed.keys()].sort()
  }

  async createSession(session: Session): Promise<void> {
    this.sessions.set(session.id, clone(session))
  }

  async findSession(refreshHash: string): Promise<{ session: Session; match: 'current' | 'previous' } | null> {
    for (const session of this.sessions.values()) {
      if (session.refreshHash === refreshHash) return { session: clone(session), match: 'current' }
      if (session.previousHash === refreshHash) return { session: clone(session), match: 'previous' }
    }
    return null
  }

  async rotateSession(
    sessionId: string,
    expectedHash: string,
    next: { refreshHash: string; previousHash: string; rotatedAt: number; refreshExpiresAt: number },
  ): Promise<boolean> {
    const session = this.sessions.get(sessionId)
    if (!session || session.refreshHash !== expectedHash || session.revokedAt !== null) return false
    Object.assign(session, next, { lastUsedAt: next.rotatedAt })
    return true
  }

  async revokeSession(sessionId: string, reason: string, now: number): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (session && session.revokedAt === null) Object.assign(session, { revokedAt: now, revokedReason: reason })
  }

  async revokeAccountSessions(accountId: string, reason: string, now: number): Promise<string[]> {
    const ids: string[] = []
    for (const session of this.sessions.values()) {
      if (session.accountId === accountId && session.revokedAt === null && session.expiresAt > now) {
        Object.assign(session, { revokedAt: now, revokedReason: reason })
        ids.push(session.id)
      }
    }
    return ids
  }

  async countLiveSessions(accountId: string, now: number): Promise<number> {
    return [...this.sessions.values()].filter((session) => session.accountId === accountId && session.revokedAt === null && session.expiresAt > now).length
  }

  async pruneSessions(olderThan: number): Promise<number> {
    let removed = 0
    for (const [id, session] of this.sessions) {
      const ended = Math.min(session.revokedAt ?? session.expiresAt, session.refreshExpiresAt)
      if (ended < olderThan) {
        this.sessions.delete(id)
        removed += 1
      }
    }
    return removed
  }
}

export class MemoryLogger implements Logger {
  readonly events: Array<{ name: string; fields: Record<string, LogValue> }> = []
  readonly errors: Array<{ name: string; error: unknown; fields: Record<string, LogValue> }> = []

  event(name: string, fields: Record<string, LogValue> = {}): void {
    this.events.push({ name, fields })
  }

  error(name: string, error: unknown, fields: Record<string, LogValue> = {}): void {
    this.errors.push({ name, error, fields })
  }

  /** Every logged line as text, for checking that nothing secret was written. */
  text(): string {
    return JSON.stringify([this.events, this.errors.map(({ name, error, fields }) => ({ name, error: String(error), fields }))])
  }
}
