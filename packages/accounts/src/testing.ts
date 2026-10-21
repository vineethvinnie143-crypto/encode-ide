import { GATEWAY_ERRORS, GatewayPaths, type GatewayErrorCode } from '@encode/gateway-protocol'
import { Accounts, type AccountsOptions } from './accounts'
import { MemorySecretStore } from './store'

/** Test doubles for the accounts package: a scripted gateway, a manual clock and stores that misbehave. Not exported from the package. */

export const BASE = 'https://gateway.test'

export interface Call {
  method: string
  path: string
  headers: Headers
  body: Record<string, any> | undefined
  token: string | null
  redirect: RequestInit['redirect']
}

export type Handler = (call: Call) => Response | Promise<Response>

export function reply(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

/** An error answer in the gateway's own format. */
export function refusal(code: GatewayErrorCode, message = `Message for ${code}.`, retryAfter?: number): Response {
  const spec = GATEWAY_ERRORS[code]
  const headers: Record<string, string> = retryAfter === undefined ? {} : { 'retry-after': String(retryAfter) }
  return reply({ error: { message, type: spec.type, code, ...(retryAfter === undefined ? {} : { retry_after: retryAfter }) } }, spec.status, headers)
}

/** A fetch that answers from queues: each path takes its handlers in order, and the last one repeats. */
export class ScriptedGateway {
  readonly calls: Call[] = []
  private readonly handlers = new Map<string, Handler[]>()

  on(path: string, ...handlers: Array<Handler | Response>): this {
    this.handlers.set(path, handlers.map((handler) => (typeof handler === 'function' ? handler : () => handler.clone())))
    return this
  }

  callsTo(path: string): Call[] {
    return this.calls.filter((call) => call.path === path)
  }

  readonly fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url)
    const headers = new Headers(init?.headers)
    const text = typeof init?.body === 'string' ? init.body : undefined
    const authorization = headers.get('authorization')
    const call: Call = {
      method: init?.method ?? 'GET',
      path: url.pathname,
      headers,
      body: text ? (JSON.parse(text) as Record<string, any>) : undefined,
      token: authorization?.startsWith('Bearer ') ? authorization.slice(7) : null,
      redirect: init?.redirect,
    }
    this.calls.push(call)
    const queue = this.handlers.get(url.pathname)
    if (!queue) return refusal('not_found')
    const handler = queue.length > 1 ? queue.shift()! : queue[0]
    const { signal } = init ?? {}
    if (!signal) return handler(call)
    // Like a real fetch, a request that is aborted while it waits for an answer fails at once.
    return new Promise<Response>((resolve, reject) => {
      const abort = () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }))
      if (signal.aborted) return abort()
      signal.addEventListener('abort', abort, { once: true })
      Promise.resolve()
        .then(() => handler(call))
        .then(resolve, reject)
        .finally(() => signal.removeEventListener('abort', abort))
    })
  }) as typeof fetch
}

/** An answer that never comes, until the request is aborted. */
export function hang(): Handler {
  return () => new Promise<Response>(() => undefined)
}

/** Throws like fetch does when the network is down. */
export function networkDown(): Handler {
  return () => {
    throw new TypeError('fetch failed')
  }
}

export class Clock {
  constructor(public time = Date.UTC(2026, 9, 21, 9)) {}
  readonly now = () => this.time
  advance(ms: number): void {
    this.time += ms
  }
  /** A sleep that moves the clock instead of waiting, and records how long it was asked to wait. */
  readonly naps: number[] = []
  readonly sleep = async (ms: number, signal?: AbortSignal): Promise<void> => {
    if (signal?.aborted) return
    this.naps.push(ms)
    this.time += ms
  }
}

let counter = 0

/** A gateway session answer; every call yields tokens that differ from the last. */
export function sessionBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const n = ++counter
  return {
    status: 'complete',
    access_token: `ea1.access${n}.signature${n}xxxxxxxx`,
    token_type: 'Bearer',
    expires_in: 3600,
    refresh_token: `er1_refresh${n}_${'x'.repeat(30)}`,
    refresh_expires_in: 30 * 86400,
    account: { id: 'acc_octocat0001', login: 'octocat', avatar_url: 'https://avatars.example.test/u/1' },
    ...overrides,
  }
}

export const startBody = {
  device_code: 'device-code-0001',
  user_code: 'WDJB-MJHT',
  verification_uri: 'https://github.com/login/device',
  expires_in: 900,
  interval: 5,
}

/** A store whose operations can be made to fail, and which records what it was asked to do. */
export class SpyStore extends MemorySecretStore {
  readonly log: string[] = []
  failSet = false
  failGet = false
  failDelete = false

  override async get(name: string): Promise<string | undefined> {
    this.log.push(`get ${name}`)
    if (this.failGet) throw new Error('keychain locked')
    return super.get(name)
  }

  override async set(name: string, value: string): Promise<void> {
    this.log.push(`set ${name}`)
    if (this.failSet) throw new Error('keychain refused')
    return super.set(name, value)
  }

  override async delete(name: string): Promise<void> {
    this.log.push(`delete ${name}`)
    if (this.failDelete) throw new Error('keychain locked')
    return super.delete(name)
  }
}

export interface Setup {
  accounts: Accounts
  gateway: ScriptedGateway
  clock: Clock
  store: SpyStore
}

/** An Accounts wired to a scripted gateway, a manual clock and a spying store. Pass `store` or `gateway` to share them between instances. */
export function setup(shared: Partial<Pick<Setup, 'gateway' | 'clock' | 'store'>> & { options?: Partial<AccountsOptions> } = {}): Setup {
  const gateway = shared.gateway ?? new ScriptedGateway()
  const clock = shared.clock ?? new Clock()
  const store = shared.store ?? new SpyStore()
  const accounts = new Accounts({
    gatewayUrl: BASE,
    store,
    client: { app: 'desktop', version: '9.9.9' },
    fetch: gateway.fetch,
    now: clock.now,
    sleep: clock.sleep,
    ...shared.options,
  })
  return { accounts, gateway, clock, store }
}

/** A gateway that has accepted a sign-in, so tests can start from a signed-in session. */
export function signedIn(shared: Parameters<typeof setup>[0] = {}): Setup & { session: Record<string, any> } {
  const made = setup(shared)
  const session = sessionBody()
  made.gateway.on(GatewayPaths.deviceStart, reply(startBody)).on(GatewayPaths.devicePoll, reply(session))
  return Object.assign(made, { session })
}
