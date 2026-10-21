import type { QuotaSnapshot } from '@encode/gateway-protocol'
import { Gateway } from '../core/app'
import type { GatewayConfig } from '../core/config'
import type { Admission, Alert, AttemptReport, ControlStatus, DayMetrics, KeySnapshot } from '../core/control'
import { GatewayError } from '../core/errors'
import { GitHubClient } from '../core/github'
import { json } from '../core/http'
import { consoleLogger, type AddressLimiterPort, type ControlPort, type UserQuotaPort } from '../core/ports'
import { TokenService } from '../core/tokens'
import type { AcquireInput, AcquireResult, ReleaseInput, WindowRule } from '../core/user-quota'
import { configFor, type Env } from './env'
import { D1AccountStore, KvConfigStore } from './stores'

export { AddressLimiterObject, ControlObject, UserQuotaObject } from './objects'

/**
 * The Cloudflare Worker: it wires the host-agnostic gateway in src/core to
 * Durable Objects, D1 and KV, and runs the cron job. One Gateway is built per
 * isolate and reused across requests.
 */

class DurableUsers implements UserQuotaPort {
  constructor(private readonly namespace: Env['USER_QUOTA']) {}

  private stub(accountId: string) {
    return this.namespace.getByName(accountId)
  }

  async acquire(accountId: string, input: AcquireInput): Promise<AcquireResult> {
    return (await this.stub(accountId).acquire(input)) as AcquireResult
  }

  async release(accountId: string, input: ReleaseInput): Promise<void> {
    await this.stub(accountId).release(input)
  }

  async snapshot(accountId: string, scale: number, sessionId: string): Promise<QuotaSnapshot | null> {
    return (await this.stub(accountId).snapshot(scale, sessionId)) as QuotaSnapshot | null
  }

  async revokeSession(accountId: string, sessionId: string, until: number): Promise<void> {
    await this.stub(accountId).revokeSession(sessionId, until)
  }

  async setSuspended(accountId: string, suspended: boolean): Promise<void> {
    await this.stub(accountId).setSuspended(suspended)
  }

  async clearFlag(accountId: string): Promise<void> {
    await this.stub(accountId).clearFlag()
  }
}

class DurableControl implements ControlPort {
  constructor(private readonly namespace: Env['CONTROL']) {}

  private get stub() {
    return this.namespace.getByName('global')
  }

  async admit(input: { firstAttempt: boolean; newActiveUser: boolean }): Promise<Admission> {
    return (await this.stub.admit(input)) as Admission
  }

  async cancel(slot: number): Promise<void> {
    await this.stub.cancel(slot)
  }

  async report(report: AttemptReport): Promise<void> {
    await this.stub.report(report)
  }

  async status(): Promise<ControlStatus> {
    return (await this.stub.status()) as ControlStatus
  }

  async updateKey(snapshot: KeySnapshot): Promise<void> {
    await this.stub.updateKey(snapshot)
  }

  async flagged(logId: string, reason: string): Promise<void> {
    await this.stub.flagged(logId, reason)
  }

  async takeAlerts(): Promise<Alert[]> {
    return (await this.stub.takeAlerts()) as Alert[]
  }

  async metrics(days: number): Promise<DayMetrics[]> {
    return (await this.stub.metrics(days)) as DayMetrics[]
  }

  async latency(): Promise<Record<string, number>> {
    return (await this.stub.latency()) as Record<string, number>
  }
}

class DurableAddresses implements AddressLimiterPort {
  constructor(private readonly namespace: Env['ADDRESS_LIMITER']) {}

  async hit(bucket: string, rules: WindowRule[]): Promise<{ ok: true } | { ok: false; retryAfterMs: number }> {
    return (await this.namespace.getByName(bucket).hit(rules)) as { ok: true } | { ok: false; retryAfterMs: number }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })
}

async function build(env: Env, config: GatewayConfig): Promise<Gateway> {
  const tokens = await TokenService.create(config.secret, config.previousSecret, config.tokens.accessTtlSeconds)
  const upstreamFetch: typeof fetch = (input, init) => fetch(input, init)
  return new Gateway({
    config,
    tokens,
    accounts: new D1AccountStore(env.DB),
    users: new DurableUsers(env.USER_QUOTA),
    control: new DurableControl(env.CONTROL),
    addresses: new DurableAddresses(env.ADDRESS_LIMITER),
    store: new KvConfigStore(env.CONFIG),
    github: config.githubClientId
      ? new GitHubClient({ baseUrl: config.githubBaseUrl, apiBaseUrl: config.githubApiBaseUrl, clientId: config.githubClientId }, upstreamFetch)
      : null,
    upstreamFetch,
    webhookFetch: upstreamFetch,
    log: consoleLogger,
    now: Date.now,
    sleep,
  })
}

const gateways = new WeakMap<Env, Promise<Gateway>>()
let reported = false

/** The isolate's gateway, or null when the configuration is invalid. The problems are logged once, never returned. */
function gatewayFor(env: Env): Promise<Gateway> | null {
  const result = configFor(env)
  if (!result.ok) {
    if (!reported) {
      reported = true
      consoleLogger.event('config_invalid', { problems: result.problems.join('; ') })
    }
    return null
  }
  let gateway = gateways.get(env)
  if (!gateway) {
    gateway = build(env, result.config)
    gateways.set(env, gateway)
  }
  return gateway
}

function unavailable(): Response {
  const error = new GatewayError('internal_error', 'The eNCode gateway is not configured correctly.', 60_000)
  return json(error.toBody(), error.status, { 'retry-after': '60' })
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const gateway = gatewayFor(env)
    if (!gateway) return unavailable()
    return (await gateway).fetch(request, ctx)
  },

  async scheduled(_controller, env, ctx): Promise<void> {
    const gateway = gatewayFor(env)
    if (gateway) ctx.waitUntil(gateway.then((instance) => instance.scheduled()))
  },
} satisfies ExportedHandler<Env>
