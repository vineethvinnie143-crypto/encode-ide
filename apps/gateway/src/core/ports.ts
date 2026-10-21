import type { QuotaSnapshot } from '@encode/gateway-protocol'
import type { Admission, Alert, AttemptReport, ControlStatus, DayMetrics, KeySnapshot } from './control'
import type { PoolDocument, PoolOverrides } from './pool'
import type { AcquireInput, AcquireResult, ReleaseInput, WindowRule } from './user-quota'

/**
 * The gateway core talks to storage only through these interfaces. On
 * Cloudflare they are Durable Objects, D1 and KV (src/worker); in tests they
 * are in-memory (src/testing). Each port method is one round trip.
 */

export interface UserQuotaPort {
  acquire(accountId: string, input: AcquireInput): Promise<AcquireResult>
  release(accountId: string, input: ReleaseInput): Promise<void>
  /** Null when `sessionId` was signed out. */
  snapshot(accountId: string, scale: number, sessionId: string): Promise<QuotaSnapshot | null>
  revokeSession(accountId: string, sessionId: string, until: number): Promise<void>
  setSuspended(accountId: string, suspended: boolean): Promise<void>
  clearFlag(accountId: string): Promise<void>
}

export interface ControlPort {
  admit(input: { firstAttempt: boolean; newActiveUser: boolean }): Promise<Admission>
  cancel(slot: number): Promise<void>
  report(report: AttemptReport): Promise<void>
  status(): Promise<ControlStatus>
  updateKey(snapshot: KeySnapshot): Promise<void>
  flagged(logId: string, reason: string): Promise<void>
  takeAlerts(): Promise<Alert[]>
  metrics(days: number): Promise<DayMetrics[]>
  latency(): Promise<Record<string, number>>
}

export interface AddressLimiterPort {
  hit(bucket: string, rules: WindowRule[]): Promise<{ ok: true } | { ok: false; retryAfterMs: number }>
}

export interface KillSwitch {
  on: boolean
  message: string
  updatedAt?: number
}

export interface ConfigStore {
  killSwitch(): Promise<KillSwitch>
  setKillSwitch(value: KillSwitch): Promise<void>
  pool(): Promise<PoolDocument | null>
  setPool(doc: PoolDocument): Promise<void>
  overrides(): Promise<PoolOverrides>
  setOverrides(value: PoolOverrides): Promise<void>
}

export interface Account {
  id: string
  githubId: number
  login: string
  avatarUrl?: string
  status: 'active' | 'suspended'
  statusReason?: string
  createdAt: number
  lastSignInAt: number
}

export interface Session {
  id: string
  accountId: string
  deviceHash: string
  refreshHash: string
  /** The refresh token this one replaced, accepted again briefly in case the client never saw the rotation. */
  previousHash: string | null
  rotatedAt: number | null
  createdAt: number
  /** The family's hard end. */
  expiresAt: number
  /** The current refresh token's end, pushed out on each rotation. */
  refreshExpiresAt: number
  lastUsedAt: number
  revokedAt: number | null
  revokedReason: string | null
  client: string | null
}

export interface GitHubIdentity {
  id: number
  login: string
  avatarUrl?: string
}

export interface AccountStore {
  /** Creates the account on first sign-in, or updates its login and avatar. */
  upsertFromGitHub(identity: GitHubIdentity, now: number, newId: string): Promise<Account>
  getAccount(id: string): Promise<Account | null>
  findByGitHubId(githubId: number): Promise<Account | null>
  findByLogin(login: string): Promise<Account | null>
  setStatus(accountId: string, status: Account['status'], reason: string | null): Promise<void>

  /** True when the login is on the allowlist. The first sign-in binds the entry to that GitHub user id. */
  allowlisted(login: string, githubId: number): Promise<boolean>
  allow(login: string, now: number): Promise<void>
  disallow(login: string): Promise<void>
  listAllowed(): Promise<string[]>

  createSession(session: Session): Promise<void>
  /** The session whose current or previous refresh token has this hash. */
  findSession(refreshHash: string): Promise<{ session: Session; match: 'current' | 'previous' } | null>
  /** Rotates only if the current hash is still `expectedHash`; false when another request rotated it first. */
  rotateSession(
    sessionId: string,
    expectedHash: string,
    next: { refreshHash: string; previousHash: string; rotatedAt: number; refreshExpiresAt: number },
  ): Promise<boolean>
  revokeSession(sessionId: string, reason: string, now: number): Promise<void>
  /** Revokes every live session of an account and returns their ids. */
  revokeAccountSessions(accountId: string, reason: string, now: number): Promise<string[]>
  countLiveSessions(accountId: string, now: number): Promise<number>
  /** Deletes sessions that ended (revoked, past their hard end, or idle past their refresh token) before `olderThan`. */
  pruneSessions(olderThan: number): Promise<number>
}

export type LogValue = string | number | boolean | null | undefined

/** Structured, metadata-only logs. Never pass prompts, completions, tokens or keys. */
export interface Logger {
  event(name: string, fields?: Record<string, LogValue>): void
  error(name: string, error: unknown, fields?: Record<string, LogValue>): void
}

export const consoleLogger: Logger = {
  event(name, fields = {}) {
    console.log(JSON.stringify({ evt: name, ...fields }))
  },
  error(name, error, fields = {}) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    console.error(JSON.stringify({ evt: name, error: detail.slice(0, 500), ...fields }))
  },
}
