import type { PoolDocument, PoolOverrides } from '../core/pool'
import type { Account, AccountStore, ConfigStore, GitHubIdentity, KillSwitch, Session } from '../core/ports'

/** Accounts, sessions and the allowlist in D1 (schema: migrations/). Every statement is prepared; nothing is interpolated. */
export class D1AccountStore implements AccountStore {
  constructor(private readonly db: D1Database) {}

  async upsertFromGitHub(identity: GitHubIdentity, now: number, newId: string): Promise<Account> {
    const row = await this.db
      .prepare(
        `INSERT INTO accounts (id, github_id, login, login_lower, avatar_url, status, created_at, last_sign_in_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6, ?6)
         ON CONFLICT (github_id) DO UPDATE SET
           login = excluded.login,
           login_lower = excluded.login_lower,
           avatar_url = excluded.avatar_url,
           last_sign_in_at = excluded.last_sign_in_at
         RETURNING *`,
      )
      .bind(newId, identity.id, identity.login, identity.login.toLowerCase(), identity.avatarUrl ?? null, now)
      .first<AccountRow>()
    if (!row) throw new Error('account upsert returned no row')
    return toAccount(row)
  }

  async getAccount(id: string): Promise<Account | null> {
    const row = await this.db.prepare('SELECT * FROM accounts WHERE id = ?1').bind(id).first<AccountRow>()
    return row ? toAccount(row) : null
  }

  async findByGitHubId(githubId: number): Promise<Account | null> {
    const row = await this.db.prepare('SELECT * FROM accounts WHERE github_id = ?1').bind(githubId).first<AccountRow>()
    return row ? toAccount(row) : null
  }

  async findByLogin(login: string): Promise<Account | null> {
    // A login can pass between people after a rename; the most recent sign-in holds it now.
    const row = await this.db
      .prepare('SELECT * FROM accounts WHERE login_lower = ?1 ORDER BY last_sign_in_at DESC LIMIT 1')
      .bind(login.toLowerCase())
      .first<AccountRow>()
    return row ? toAccount(row) : null
  }

  async setStatus(accountId: string, status: Account['status'], reason: string | null): Promise<void> {
    await this.db.prepare('UPDATE accounts SET status = ?2, status_reason = ?3 WHERE id = ?1').bind(accountId, status, reason).run()
  }

  async allowlisted(login: string, githubId: number): Promise<boolean> {
    const key = login.toLowerCase()
    const [, result] = await this.db.batch([
      this.db.prepare('UPDATE allowlist SET github_id = ?2 WHERE login_lower = ?1 AND github_id IS NULL').bind(key, githubId),
      this.db.prepare('SELECT github_id FROM allowlist WHERE login_lower = ?1').bind(key),
    ])
    const row = (result.results as Array<{ github_id: number | null }>)[0]
    return row !== undefined && row.github_id === githubId
  }

  async allow(login: string, now: number): Promise<void> {
    await this.db
      .prepare('INSERT INTO allowlist (login_lower, github_id, added_at) VALUES (?1, NULL, ?2) ON CONFLICT (login_lower) DO NOTHING')
      .bind(login.toLowerCase(), now)
      .run()
  }

  async disallow(login: string): Promise<void> {
    await this.db.prepare('DELETE FROM allowlist WHERE login_lower = ?1').bind(login.toLowerCase()).run()
  }

  async listAllowed(): Promise<string[]> {
    const { results } = await this.db.prepare('SELECT login_lower FROM allowlist ORDER BY login_lower').all<{ login_lower: string }>()
    return results.map((row) => row.login_lower)
  }

  async createSession(session: Session): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO sessions (id, account_id, device_hash, refresh_hash, previous_hash, rotated_at, created_at, expires_at,
           refresh_expires_at, last_used_at, revoked_at, revoked_reason, client)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
      )
      .bind(
        session.id,
        session.accountId,
        session.deviceHash,
        session.refreshHash,
        session.previousHash,
        session.rotatedAt,
        session.createdAt,
        session.expiresAt,
        session.refreshExpiresAt,
        session.lastUsedAt,
        session.revokedAt,
        session.revokedReason,
        session.client,
      )
      .run()
  }

  async findSession(refreshHash: string): Promise<{ session: Session; match: 'current' | 'previous' } | null> {
    const row = await this.db
      .prepare('SELECT * FROM sessions WHERE refresh_hash = ?1 OR previous_hash = ?1 LIMIT 1')
      .bind(refreshHash)
      .first<SessionRow>()
    if (!row) return null
    return { session: toSession(row), match: row.refresh_hash === refreshHash ? 'current' : 'previous' }
  }

  async rotateSession(
    sessionId: string,
    expectedHash: string,
    next: { refreshHash: string; previousHash: string; rotatedAt: number; refreshExpiresAt: number },
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE sessions SET refresh_hash = ?3, previous_hash = ?4, rotated_at = ?5, refresh_expires_at = ?6, last_used_at = ?7
         WHERE id = ?1 AND refresh_hash = ?2 AND revoked_at IS NULL`,
      )
      .bind(sessionId, expectedHash, next.refreshHash, next.previousHash, next.rotatedAt, next.refreshExpiresAt, Date.now())
      .run()
    return result.meta.changes === 1
  }

  async revokeSession(sessionId: string, reason: string, now: number): Promise<void> {
    await this.db
      .prepare('UPDATE sessions SET revoked_at = ?2, revoked_reason = ?3 WHERE id = ?1 AND revoked_at IS NULL')
      .bind(sessionId, now, reason)
      .run()
  }

  async revokeAccountSessions(accountId: string, reason: string, now: number): Promise<string[]> {
    const { results } = await this.db
      .prepare('UPDATE sessions SET revoked_at = ?2, revoked_reason = ?3 WHERE account_id = ?1 AND revoked_at IS NULL AND expires_at > ?2 RETURNING id')
      .bind(accountId, now, reason)
      .all<{ id: string }>()
    return results.map((row) => row.id)
  }

  async countLiveSessions(accountId: string, now: number): Promise<number> {
    const row = await this.db
      .prepare('SELECT COUNT(*) AS live FROM sessions WHERE account_id = ?1 AND revoked_at IS NULL AND expires_at > ?2')
      .bind(accountId, now)
      .first<{ live: number }>()
    return row?.live ?? 0
  }

  async pruneSessions(olderThan: number): Promise<number> {
    const result = await this.db
      .prepare('DELETE FROM sessions WHERE MIN(COALESCE(revoked_at, expires_at), refresh_expires_at) < ?1')
      .bind(olderThan)
      .run()
    return result.meta.changes
  }
}

interface AccountRow {
  id: string
  github_id: number
  login: string
  avatar_url: string | null
  status: Account['status']
  status_reason: string | null
  created_at: number
  last_sign_in_at: number
}

interface SessionRow {
  id: string
  account_id: string
  device_hash: string
  refresh_hash: string
  previous_hash: string | null
  rotated_at: number | null
  created_at: number
  expires_at: number
  refresh_expires_at: number
  last_used_at: number
  revoked_at: number | null
  revoked_reason: string | null
  client: string | null
}

function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    githubId: row.github_id,
    login: row.login,
    ...(row.avatar_url ? { avatarUrl: row.avatar_url } : {}),
    status: row.status,
    ...(row.status_reason ? { statusReason: row.status_reason } : {}),
    createdAt: row.created_at,
    lastSignInAt: row.last_sign_in_at,
  }
}

function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    accountId: row.account_id,
    deviceHash: row.device_hash,
    refreshHash: row.refresh_hash,
    previousHash: row.previous_hash,
    rotatedAt: row.rotated_at,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    refreshExpiresAt: row.refresh_expires_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    revokedReason: row.revoked_reason,
    client: row.client,
  }
}

const KEYS = { kill: 'kill-switch', pool: 'pool', overrides: 'pool-overrides' } as const

/**
 * The kill switch and the free pool in KV, which every location reads
 * quickly and an operator can change from the dashboard. Reads are cached in
 * the isolate for a few seconds on top of KV's own edge cache, so a change
 * reaches every location within about a minute.
 */
export class KvConfigStore implements ConfigStore {
  private readonly cache = new Map<string, { at: number; value: unknown }>()

  constructor(
    private readonly kv: KVNamespace,
    private readonly ttlMs = 10_000,
  ) {}

  private async read<T>(key: string, fallback: T): Promise<T> {
    const now = Date.now()
    const cached = this.cache.get(key)
    if (cached && now - cached.at < this.ttlMs) return cached.value as T
    const value = (await this.kv.get<T>(key, { type: 'json', cacheTtl: 60 })) ?? fallback
    this.cache.set(key, { at: now, value })
    return value
  }

  private async write(key: string, value: unknown): Promise<void> {
    await this.kv.put(key, JSON.stringify(value))
    this.cache.set(key, { at: Date.now(), value })
  }

  killSwitch(): Promise<KillSwitch> {
    return this.read<KillSwitch>(KEYS.kill, { on: false, message: '' })
  }

  setKillSwitch(value: KillSwitch): Promise<void> {
    return this.write(KEYS.kill, value)
  }

  pool(): Promise<PoolDocument | null> {
    return this.read<PoolDocument | null>(KEYS.pool, null)
  }

  setPool(doc: PoolDocument): Promise<void> {
    return this.write(KEYS.pool, doc)
  }

  overrides(): Promise<PoolOverrides> {
    return this.read<PoolOverrides>(KEYS.overrides, {})
  }

  setOverrides(value: PoolOverrides): Promise<void> {
    return this.write(KEYS.overrides, value)
  }
}
