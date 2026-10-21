import {
  GatewayHeaders,
  GatewayPaths,
  VIRTUAL_MODEL_IDS,
  VIRTUAL_MODEL_ROLES,
  VirtualModels,
  compareVersions,
  parseClientHeader,
  type ModelListResponse,
  type StatusResponse,
  type VirtualModelInfo,
} from '@encode/gateway-protocol'
import { handleAdmin } from './admin'
import { authenticate, deviceStart, devicePoll, logout, me, refresh, type AuthDeps } from './auth'
import type { GatewayConfig } from './config'
import type { ControlStatus, KeySnapshot } from './control'
import { randomToken } from './crypto'
import { GatewayError, retryAfterSeconds } from './errors'
import type { GitHubClient } from './github'
import { clientAddress, json } from './http'
import { buildPools, describeModel, parseCatalog, type PoolDocument } from './pool'
import type { AccountStore, AddressLimiterPort, ConfigStore, ControlPort, KillSwitch, Logger, UserQuotaPort } from './ports'
import { handleChat, type ChatDeps, type RequestContext } from './proxy'
import { DAY, HOUR, SECOND } from './time'
import type { TokenService } from './tokens'

export interface GatewayDeps {
  config: GatewayConfig
  tokens: TokenService
  accounts: AccountStore
  users: UserQuotaPort
  control: ControlPort
  addresses: AddressLimiterPort
  store: ConfigStore
  github: GitHubClient | null
  /** Reaches OpenRouter. Separate from `webhookFetch` so tests can tell the two apart. */
  upstreamFetch: typeof fetch
  webhookFetch: typeof fetch
  log: Logger
  now: () => number
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>
}

export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void
}

const STATUS_CACHE_MS = 15 * SECOND
const POOL_SYNC_MS = HOUR
const SESSION_RETENTION_MS = 30 * DAY

/**
 * OpenRouter's GET /api/v1/key answer, reduced to what the budget and the
 * spend alert need. Null when it is not a key answer at all; `free` is null
 * when it lacks the free-request counters, and the spend check still runs.
 */
export function parseKeyInfo(json: unknown): KeySnapshot | null {
  const data = (json as { data?: Record<string, unknown> } | null)?.data
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const counters = data.free_model_daily_requests as Record<string, unknown> | undefined
  const number = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null)
  const limit = number(counters?.limit)
  const used = number(counters?.used)
  const free = limit === null || used === null ? null : { limit, used, remaining: number(counters?.remaining) ?? Math.max(0, limit - used) }
  return {
    free,
    creditsUsedToday: Math.max(0, number(data.usage_daily) ?? 0),
    creditLimit: number(data.limit),
    creditLimitRemaining: number(data.limit_remaining),
  }
}

function withHeaders(response: Response, headers: Record<string, string>): Response {
  const merged = new Headers(response.headers)
  for (const [name, value] of Object.entries(headers)) merged.set(name, value)
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: merged })
}

function errorResponse(error: GatewayError): Response {
  const headers: Record<string, string> = {}
  if (error.retryAfterMs !== undefined) headers['retry-after'] = String(retryAfterSeconds(error.retryAfterMs))
  return json(error.toBody(), error.status, headers)
}

export class Gateway {
  private readonly chatDeps: ChatDeps
  private readonly authDeps: AuthDeps
  private statusCache: { at: number; value: ControlStatus } | null = null

  constructor(private readonly deps: GatewayDeps) {
    this.chatDeps = {
      config: deps.config,
      upstreamFetch: deps.upstreamFetch,
      users: deps.users,
      control: deps.control,
      store: deps.store,
      tokens: deps.tokens,
      log: deps.log,
      now: deps.now,
      sleep: deps.sleep,
      newId: () => randomToken(12),
      fairShare: { scale: 1, at: 0 },
    }
    this.authDeps = {
      config: deps.config,
      tokens: deps.tokens,
      accounts: deps.accounts,
      github: deps.github,
      addresses: deps.addresses,
      users: deps.users,
      log: deps.log,
      now: deps.now,
      newId: (prefix) => `${prefix}_${randomToken(16)}`,
    }
  }

  async fetch(request: Request, execution: ExecutionContextLike): Promise<Response> {
    const requestId = `req_${randomToken(12)}`
    const ctx: RequestContext = { requestId, waitUntil: (promise) => execution.waitUntil(promise) }
    let response: Response
    try {
      response = await this.route(request, ctx)
    } catch (error) {
      if (error instanceof GatewayError) {
        response = errorResponse(error)
      } else {
        this.deps.log.error('request_failed', error, { rid: requestId })
        response = errorResponse(new GatewayError('internal_error', 'The gateway hit an internal error. Retry in a moment.', 5_000))
      }
    }
    return withHeaders(response, { [GatewayHeaders.requestId]: requestId })
  }

  private async route(request: Request, ctx: RequestContext): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname
    if (path === '/admin' || path.startsWith('/admin/')) {
      return handleAdmin(request, url, {
        config: this.deps.config,
        accounts: this.deps.accounts,
        users: this.deps.users,
        control: this.deps.control,
        store: this.deps.store,
        log: this.deps.log,
        now: this.deps.now,
        syncPool: () => this.syncPool(),
        logId: (id) => this.deps.tokens.logId(id),
      })
    }

    const method = request.method
    const allow = (expected: string) => {
      if (method !== expected) throw new GatewayError('method_not_allowed', `Use ${expected} for ${path}.`)
    }
    switch (path) {
      case GatewayPaths.status:
        allow('GET')
        return this.status()
      case GatewayPaths.models:
        allow('GET')
        return this.models()
      case GatewayPaths.chatCompletions: {
        allow('POST')
        const kill = await this.killSwitch()
        if (kill.on) throw new GatewayError('service_disabled', kill.message, 15 * 60_000)
        this.checkClient(request)
        const claims = await authenticate(request, this.deps)
        return handleChat(request, claims, this.chatDeps, ctx)
      }
      case GatewayPaths.me: {
        allow('GET')
        const claims = await authenticate(request, this.deps)
        return me(claims, this.authDeps, this.chatDeps.fairShare.scale)
      }
      case GatewayPaths.deviceStart:
        allow('POST')
        this.checkClient(request)
        return deviceStart(request, this.authDeps, clientAddress(request))
      case GatewayPaths.devicePoll:
        allow('POST')
        this.checkClient(request)
        return devicePoll(request, this.authDeps, clientAddress(request), this.clientLabel(request))
      case GatewayPaths.refresh:
        allow('POST')
        this.checkClient(request)
        return refresh(request, this.authDeps, clientAddress(request))
      case GatewayPaths.logout:
        allow('POST')
        return logout(request, this.authDeps)
      default:
        throw new GatewayError('not_found', 'Not found.')
    }
  }

  private clientLabel(request: Request): string | null {
    const client = parseClientHeader(request.headers.get(GatewayHeaders.client))
    return client ? `${client.app}/${client.version}`.slice(0, 64) : null
  }

  /** A client older than MIN_CLIENT_VERSION is asked to update. A client that sends no version is served. */
  private checkClient(request: Request): void {
    const minimum = this.deps.config.minClientVersion
    if (!minimum) return
    const client = parseClientHeader(request.headers.get(GatewayHeaders.client))
    if (!client) return
    const order = compareVersions(client.version, minimum)
    if (order !== null && order < 0) {
      throw new GatewayError('client_outdated', `This version of eNCode is too old for the free tier. Update to ${minimum} or later.`)
    }
  }

  private async killSwitch(): Promise<KillSwitch> {
    if (this.deps.config.killSwitch.on) return { on: true, message: this.deps.config.killSwitch.message }
    try {
      return await this.deps.store.killSwitch()
    } catch (error) {
      this.deps.log.error('kill_switch_read_failed', error)
      return { on: false, message: '' }
    }
  }

  private async controlStatus(): Promise<ControlStatus | null> {
    const now = this.deps.now()
    if (this.statusCache && now - this.statusCache.at < STATUS_CACHE_MS) return this.statusCache.value
    try {
      const value = await this.deps.control.status()
      this.statusCache = { at: now, value }
      return value
    } catch (error) {
      this.deps.log.error('control_status_failed', error)
      return null
    }
  }

  private async status(): Promise<Response> {
    const [kill, control] = await Promise.all([this.killSwitch(), this.controlStatus()])
    let freeTier: StatusResponse['free_tier']
    if (kill.on) freeTier = { available: false, message: kill.message }
    else if (!control) freeTier = { available: false, message: 'The free tier cannot be reached right now.' }
    else {
      freeTier = {
        available: control.available,
        ...(control.message ? { message: control.message } : {}),
        ...(control.availableAt ? { available_at: control.availableAt } : {}),
      }
    }
    const body: StatusResponse = {
      service: 'encode-gateway',
      api_version: 1,
      free_tier: freeTier,
      ...(this.deps.config.minClientVersion ? { min_client_version: this.deps.config.minClientVersion } : {}),
      data_policy: this.deps.config.dataPolicy,
    }
    return json(body)
  }

  private async models(): Promise<Response> {
    const pool = await this.deps.store.pool()
    const { fallbackModels } = this.deps.config.upstream
    const data = VIRTUAL_MODEL_IDS.map((id): VirtualModelInfo => {
      const ids = pool?.pools[id] ?? []
      const all = pool ? ids.map((model) => describeModel(pool, model)).filter((model) => model !== undefined) : []
      const top = all.slice(0, fallbackModels)
      return {
        id,
        object: 'model',
        owned_by: 'encode',
        name: id === VirtualModels.main ? 'eNCode Free' : 'eNCode Free (fast)',
        roles: VIRTUAL_MODEL_ROLES[id],
        context_length: top.length ? Math.min(...top.map((model) => model.context)) : 0,
        max_output_tokens: Math.min(this.deps.config.request.maxOutputTokens, ...top.map((model) => model.maxOutput)),
        supports_tools: all.some((model) => model.tools),
        supports_images: all.some((model) => model.images),
        available: top.length > 0,
      }
    })
    return json({ object: 'list', data } satisfies ModelListResponse)
  }

  /** Rebuilds the free pool from OpenRouter's catalog. An empty or failed fetch keeps the pool as it was. */
  async syncPool(): Promise<{ models: number }> {
    const response = await this.deps.upstreamFetch(`${this.deps.config.openRouterBaseUrl}/models`, {
      headers: { accept: 'application/json', 'x-title': this.deps.config.appTitle },
      signal: AbortSignal.timeout(20_000),
    })
    if (!response.ok) throw new Error(`OpenRouter's model list answered ${response.status}`)
    const models = parseCatalog(await response.json())
    if (!models.length) {
      this.deps.log.event('pool_sync_empty')
      return { models: 0 }
    }
    const [overrides, latency] = await Promise.all([this.deps.store.overrides(), this.deps.control.latency().catch(() => ({}))])
    const doc: PoolDocument = { v: 1, updatedAt: this.deps.now(), models, pools: buildPools(models, overrides, latency) }
    await this.deps.store.setPool(doc)
    this.deps.log.event('pool_synced', {
      models: models.length,
      main: doc.pools[VirtualModels.main].length,
      fast: doc.pools[VirtualModels.fast].length,
    })
    return { models: models.length }
  }

  private async syncKey(): Promise<void> {
    const response = await this.deps.upstreamFetch(`${this.deps.config.openRouterBaseUrl}/key`, {
      headers: { authorization: `Bearer ${this.deps.config.openRouterKey}`, accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) {
      this.deps.log.event('key_sync_failed', { status: response.status })
      if (response.status === 401) await this.deps.control.report({ model: 'openrouter/key', outcome: 'unauthorized' })
      return
    }
    const snapshot = parseKeyInfo(await response.json())
    if (!snapshot) {
      this.deps.log.event('key_sync_unreadable')
      return
    }
    if (!snapshot.free) this.deps.log.event('key_sync_incomplete')
    await this.deps.control.updateKey(snapshot)
  }

  private async deliverAlerts(): Promise<void> {
    const alerts = await this.deps.control.takeAlerts()
    for (const alert of alerts) {
      this.deps.log.event('alert', { key: alert.key, severity: alert.severity, message: alert.message })
      const target = this.deps.config.alertWebhookUrl
      if (!target) continue
      const text = `[eNCode gateway] ${alert.severity.toUpperCase()}: ${alert.message}`
      try {
        // Slack reads `text` and Discord reads `content`; each ignores the other.
        await this.deps.webhookFetch(target, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text, content: text }),
          signal: AbortSignal.timeout(10_000),
        })
      } catch (error) {
        this.deps.log.error('alert_delivery_failed', error, { key: alert.key })
      }
    }
  }

  /** The cron: OpenRouter's counters, the free pool, alerts and old sessions. Each step runs even if another fails. */
  async scheduled(): Promise<void> {
    const steps: Array<[string, () => Promise<unknown>]> = [
      ['key_sync', () => this.syncKey()],
      [
        'pool_sync',
        async () => {
          const pool = await this.deps.store.pool()
          if (!pool || this.deps.now() - pool.updatedAt >= POOL_SYNC_MS) await this.syncPool()
        },
      ],
      ['alerts', () => this.deliverAlerts()],
      ['session_prune', () => this.deps.accounts.pruneSessions(this.deps.now() - SESSION_RETENTION_MS)],
    ]
    for (const [name, step] of steps) {
      try {
        await step()
      } catch (error) {
        this.deps.log.error(`${name}_failed`, error)
      }
    }
  }
}

