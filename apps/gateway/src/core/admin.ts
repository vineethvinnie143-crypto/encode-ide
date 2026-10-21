import { VIRTUAL_MODEL_IDS, isVirtualModelId, type VirtualModelId } from '@encode/gateway-protocol'
import type { GatewayConfig } from './config'
import { secretsEqual } from './crypto'
import { GatewayError } from './errors'
import { isFreeModelId } from './firewall'
import { bearerToken, json, readJson } from './http'
import { buildPools, type PoolOverrides } from './pool'
import type { AccountStore, ConfigStore, ControlPort, Logger, UserQuotaPort } from './ports'
import { SECOND } from './time'

/**
 * The operator's API under /admin. It exists only when ADMIN_TOKEN is set,
 * answers 404 otherwise, and compares the token in constant time. Every
 * action is logged by name, never with request bodies.
 */

export interface AdminDeps {
  config: GatewayConfig
  accounts: AccountStore
  users: UserQuotaPort
  control: ControlPort
  store: ConfigStore
  log: Logger
  now: () => number
  syncPool: () => Promise<{ models: number }>
  logId: (accountId: string) => Promise<string>
}

const LOGIN = /^[A-Za-z0-9-]{1,39}$/

function notFound(): GatewayError {
  return new GatewayError('not_found', 'Not found.')
}

function list(value: unknown, path: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 500 || !value.every(isFreeModelId)) {
    throw new GatewayError('invalid_request', `${path} must be a list of :free model ids.`)
  }
  return value as string[]
}

function parseOverrides(value: unknown): PoolOverrides {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GatewayError('invalid_request', 'Send an object.')
  const raw = value as Record<string, unknown>
  const pin: Partial<Record<VirtualModelId, string[]>> = {}
  if (raw.pin !== undefined) {
    if (!raw.pin || typeof raw.pin !== 'object' || Array.isArray(raw.pin)) throw new GatewayError('invalid_request', 'pin must be an object.')
    for (const [id, models] of Object.entries(raw.pin)) {
      if (!isVirtualModelId(id)) throw new GatewayError('invalid_request', `pin.${id} is not a virtual model.`)
      pin[id] = list(models, `pin.${id}`)
    }
  }
  if (raw.approvedOnly !== undefined && typeof raw.approvedOnly !== 'boolean') throw new GatewayError('invalid_request', 'approvedOnly must be a boolean.')
  return { block: list(raw.block, 'block'), pin, approvedOnly: raw.approvedOnly === true, approved: list(raw.approved, 'approved') }
}

export async function handleAdmin(request: Request, url: URL, deps: AdminDeps): Promise<Response> {
  const configured = deps.config.adminToken
  if (!configured) throw notFound()
  const presented = bearerToken(request)
  if (!presented || !(await secretsEqual(presented, configured))) {
    // The same answer as a missing route, so the API's existence is not confirmed to strangers.
    deps.log.event('admin_refused', { path: url.pathname.slice(0, 64) })
    throw notFound()
  }

  const parts = url.pathname.split('/').filter(Boolean).slice(1)
  const route = `${request.method} /${parts.map((part, index) => (parts[0] === 'accounts' && index === 1) || (parts[0] === 'allowlist' && index === 1) ? ':login' : part).join('/')}`
  const login = parts[1] ?? ''
  const action = (name: string, fields: Record<string, string | number | boolean> = {}) => deps.log.event('admin', { action: name, ...fields })

  const account = async () => {
    if (!LOGIN.test(login)) throw new GatewayError('invalid_request', 'That is not a GitHub login.')
    const found = await deps.accounts.findByLogin(login)
    if (!found) throw notFound()
    return found
  }

  switch (route) {
    case 'GET /status': {
      const [control, kill, pool] = await Promise.all([deps.control.status(), deps.store.killSwitch(), deps.store.pool()])
      return json({
        control,
        kill_switch: deps.config.killSwitch.on ? { ...deps.config.killSwitch, source: 'environment' } : kill,
        pool: pool
          ? { updated_at: pool.updatedAt, models: pool.models.length, pools: Object.fromEntries(VIRTUAL_MODEL_IDS.map((id) => [id, pool.pools[id] ?? []])) }
          : null,
      })
    }
    case 'PUT /kill-switch': {
      const { value } = await readJson(request, 4096)
      const body = value as Record<string, unknown> | null
      if (!body || typeof body.on !== 'boolean') throw new GatewayError('invalid_request', 'Send {"on": true|false, "message"?: string}.')
      const message = typeof body.message === 'string' && body.message.trim() ? body.message.trim().slice(0, 280) : deps.config.killSwitch.message
      await deps.store.setKillSwitch({ on: body.on, message, updatedAt: deps.now() })
      action('kill_switch', { on: body.on })
      return json({ on: body.on, message, note: 'KV changes reach every location within about a minute.' })
    }
    case 'GET /metrics': {
      const days = Math.max(1, Math.min(15, Number(url.searchParams.get('days') ?? '1') || 1))
      return json({ days: await deps.control.metrics(days) })
    }
    case 'GET /pool':
      return json({ pool: await deps.store.pool(), overrides: await deps.store.overrides() })
    case 'PUT /pool/overrides': {
      const { value } = await readJson(request, 64 * 1024)
      const overrides = parseOverrides(value)
      await deps.store.setOverrides(overrides)
      const pool = await deps.store.pool()
      if (pool) await deps.store.setPool({ ...pool, pools: buildPools(pool.models, overrides, await deps.control.latency()), updatedAt: deps.now() })
      action('pool_overrides', { blocked: overrides.block?.length ?? 0, approved_only: overrides.approvedOnly === true })
      return json({ overrides })
    }
    case 'POST /pool/sync': {
      const result = await deps.syncPool()
      action('pool_sync', { models: result.models })
      return json(result)
    }
    case 'GET /accounts/:login': {
      const found = await account()
      const [sessions, quota] = await Promise.all([
        deps.accounts.countLiveSessions(found.id, deps.now()),
        deps.users.snapshot(found.id, 1, ''),
      ])
      return json({ account: { ...found, log_id: await deps.logId(found.id) }, live_sessions: sessions, quota })
    }
    case 'POST /accounts/:login/suspend':
    case 'POST /accounts/:login/sign-out': {
      const found = await account()
      const suspend = route.endsWith('/suspend')
      let reason = 'admin'
      if (suspend) {
        const { value } = await readJson(request, 4096).catch(() => ({ value: {} }))
        const given = (value as Record<string, unknown> | null)?.reason
        reason = typeof given === 'string' && given.trim() ? given.trim().slice(0, 200) : 'suspended by an admin'
        await deps.accounts.setStatus(found.id, 'suspended', reason)
        await deps.users.setSuspended(found.id, true)
      }
      const now = deps.now()
      const revoked = await deps.accounts.revokeAccountSessions(found.id, suspend ? 'suspended' : 'admin_sign_out', now)
      const until = now + deps.config.tokens.accessTtlSeconds * SECOND
      await Promise.all(revoked.map((sessionId) => deps.users.revokeSession(found.id, sessionId, until)))
      action(suspend ? 'suspend' : 'sign_out', { uid: await deps.logId(found.id), sessions: revoked.length })
      return json({ login: found.login, status: suspend ? 'suspended' : found.status, sessions_revoked: revoked.length })
    }
    case 'POST /accounts/:login/unsuspend': {
      const found = await account()
      await deps.accounts.setStatus(found.id, 'active', null)
      await deps.users.setSuspended(found.id, false)
      action('unsuspend', { uid: await deps.logId(found.id) })
      return json({ login: found.login, status: 'active' })
    }
    case 'POST /accounts/:login/clear-flag': {
      const found = await account()
      await deps.users.clearFlag(found.id)
      action('clear_flag', { uid: await deps.logId(found.id) })
      return json({ login: found.login, flag: null })
    }
    case 'GET /allowlist':
      return json({ logins: await deps.accounts.listAllowed() })
    case 'POST /allowlist': {
      const { value } = await readJson(request, 4096)
      const given = (value as Record<string, unknown> | null)?.login
      if (typeof given !== 'string' || !LOGIN.test(given)) throw new GatewayError('invalid_request', 'Send {"login": "<github login>"}.')
      await deps.accounts.allow(given, deps.now())
      action('allow')
      return json({ login: given.toLowerCase(), allowed: true })
    }
    case 'DELETE /allowlist/:login': {
      if (!LOGIN.test(login)) throw new GatewayError('invalid_request', 'That is not a GitHub login.')
      await deps.accounts.disallow(login)
      action('disallow')
      return json({ login: login.toLowerCase(), allowed: false })
    }
    default:
      throw notFound()
  }
}
