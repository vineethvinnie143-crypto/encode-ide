import { GatewayPaths, VirtualModels, type SessionTokens } from '@encode/gateway-protocol'
import { Gateway } from '../core/app'
import { parseConfig, type GatewayConfig, type GatewayEnvVars } from '../core/config'
import { GitHubClient } from '../core/github'
import { buildPools, type CatalogModel, type PoolDocument } from '../core/pool'
import { TokenService } from '../core/tokens'
import { MemoryAccounts, MemoryAddresses, MemoryConfigStore, MemoryControl, MemoryLogger, MemoryUsers } from './memory'

/**
 * A whole gateway in memory for tests: the real core, in-memory ports, a
 * fake clock, and scripted stand-ins for OpenRouter, GitHub and the alert
 * webhook. Nothing here touches the network.
 */

export const START = Date.UTC(2026, 9, 21, 9, 0, 0)
export const DEVICE_ID = 'device_0123456789abcdefghijklmnopqrstuv'
export const OPENROUTER_KEY = 'sk-or-v1-test-key-never-leaves-the-gateway'
export const ADMIN_TOKEN = 'admin-token-for-tests-0123456789abcdef'

export const TEST_ENV: GatewayEnvVars = {
  ENVIRONMENT: 'production',
  OPENROUTER_API_KEY: OPENROUTER_KEY,
  GATEWAY_SECRET: 'gateway-secret-for-tests-0123456789abcdef',
  ADMIN_TOKEN,
  ALERT_WEBHOOK_URL: 'https://hooks.example.test/alerts',
  GITHUB_CLIENT_ID: 'Iv1.testclient01',
  APP_URL: 'https://encode.example.test',
  OPENROUTER_BASE_URL: 'https://openrouter.example.test/api/v1',
  GITHUB_BASE_URL: 'https://github.example.test',
  GITHUB_API_BASE_URL: 'https://api.github.example.test',
  SIGNUP_MODE: 'open',
  MIN_GITHUB_ACCOUNT_AGE_DAYS: '0',
}

function model(id: string, context: number, tools: boolean, extra: Partial<CatalogModel> = {}): CatalogModel {
  return { id, name: id, created: 1_760_000_000, context, maxOutput: 8_192, tools, images: false, reasoning: false, ...extra }
}

/** The free models the fake OpenRouter lists. */
export const CATALOG: CatalogModel[] = [
  model('acme/big:free', 131_072, true, { created: 1_760_000_300 }),
  model('acme/medium:free', 65_536, true, { created: 1_760_000_200 }),
  model('beta/vision:free', 65_536, true, { created: 1_760_000_100, images: true }),
  model('gamma/small:free', 32_768, false, { created: 1_760_000_400 }),
]

/** The same models as OpenRouter's /models endpoint would describe them. */
export function catalogJson(models: readonly CatalogModel[] = CATALOG): unknown {
  return {
    data: models.map((entry) => ({
      id: entry.id,
      name: entry.name,
      created: entry.created,
      context_length: entry.context,
      pricing: { prompt: '0', completion: '0', request: '0', image: '0' },
      architecture: { input_modalities: entry.images ? ['text', 'image'] : ['text'], output_modalities: ['text'] },
      top_provider: { context_length: entry.context, max_completion_tokens: entry.maxOutput },
      supported_parameters: [...(entry.tools ? ['tools', 'tool_choice'] : []), ...(entry.reasoning ? ['reasoning'] : []), 'max_tokens'],
    })),
  }
}

export function poolDocument(models: readonly CatalogModel[] = CATALOG, now = START): PoolDocument {
  return { v: 1, updatedAt: now, models: [...models], pools: buildPools(models) }
}

const encoder = new TextEncoder()

export function chunk(modelId: string, delta: Record<string, unknown>, finish: string | null = null, extra: Record<string, unknown> = {}) {
  return { id: 'gen-test', object: 'chat.completion.chunk', created: 1_760_000_000, model: modelId, choices: [{ index: 0, delta, finish_reason: finish }], ...extra }
}

/** The events of a normal streamed answer: a role-only delta, the text in two parts, the finish, then usage. */
export function answerEvents(modelId: string, text: string, usage = { prompt_tokens: 120, completion_tokens: 30 }): unknown[] {
  const half = Math.ceil(text.length / 2)
  return [
    chunk(modelId, { role: 'assistant', content: '' }),
    chunk(modelId, { content: text.slice(0, half) }),
    chunk(modelId, { content: text.slice(half) }),
    chunk(modelId, {}, 'stop'),
    { ...chunk(modelId, {}), choices: [], usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens } },
  ]
}

/** An SSE body from events (objects become `data:` lines, strings are sent as they are), ending with [DONE] unless told not to. */
export function sseBody(events: readonly unknown[], done = true): string {
  const lines = events.map((event) => (typeof event === 'string' ? event : `data: ${JSON.stringify(event)}\n\n`))
  return lines.join('') + (done ? 'data: [DONE]\n\n' : '')
}

export function sseResponse(events: readonly unknown[], done = true): Response {
  return new Response(sseBody(events, done), { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

export function errorResponse(status: number, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: { code: status, message } }), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

/** A stream the test writes to by hand, for timing and disconnect cases. */
export function controlledStream(): { response: Response; send(event: unknown): void; close(): void; fail(): void; cancelled: Promise<void> } {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let onCancel!: () => void
  const cancelled = new Promise<void>((resolve) => (onCancel = resolve))
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
    },
    cancel() {
      onCancel()
    },
  })
  return {
    response: new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    send(event) {
      try {
        controller.enqueue(encoder.encode(typeof event === 'string' ? event : `data: ${JSON.stringify(event)}\n\n`))
      } catch {
        /* already cancelled */
      }
    },
    close() {
      try {
        controller.close()
      } catch {
        /* already closed */
      }
    },
    fail() {
      try {
        controller.error(new Error('connection reset'))
      } catch {
        /* already closed */
      }
    },
    cancelled,
  }
}

export type ChatHandler = (body: Record<string, unknown>, signal: AbortSignal | undefined) => Response | Promise<Response>

type FetchInput = Parameters<typeof fetch>[0]

function requestUrl(input: FetchInput): URL {
  return new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
}

export class FakeOpenRouter {
  readonly chats: Array<{ body: Record<string, unknown>; headers: Headers }> = []
  readonly calls: string[] = []
  /** Handlers for the next chat requests, in order; the default answers from the first model offered. */
  readonly script: ChatHandler[] = []
  catalog: unknown = catalogJson()
  key: unknown = {
    data: { free_model_daily_requests: { limit: 1000, used: 0, remaining: 1000 }, usage_daily: 0, limit: null, limit_remaining: null },
  }
  keyStatus = 200

  readonly fetch = (async (input: FetchInput, init?: RequestInit) => {
    const url = requestUrl(input)
    const headers = new Headers(init?.headers)
    this.calls.push(`${init?.method ?? 'GET'} ${url.pathname}`)
    if (url.pathname === '/api/v1/models') return Response.json(this.catalog)
    if (url.pathname === '/api/v1/key') return this.keyStatus === 200 ? Response.json(this.key) : new Response('no', { status: this.keyStatus })
    if (url.pathname === '/api/v1/chat/completions') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      this.chats.push({ body, headers })
      const handler = this.script.shift()
      if (handler) return handler(body, init?.signal ?? undefined)
      return sseResponse(answerEvents(String(body.model), `Hello from ${String(body.model)}`))
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch
}

export class FakeGitHub {
  user: Record<string, unknown> = {
    id: 1001,
    login: 'octocat',
    type: 'User',
    created_at: '2015-01-01T00:00:00Z',
    avatar_url: 'https://avatars.example.test/u/1001',
  }
  /** Answers for the next token polls, in order; the default grants a token. */
  readonly polls: Array<Record<string, unknown>> = []
  readonly calls: string[] = []
  readonly tokensSeen: string[] = []

  readonly fetch = (async (input: FetchInput, init?: RequestInit) => {
    const url = requestUrl(input)
    this.calls.push(url.pathname)
    if (url.pathname === '/login/device/code') {
      return Response.json({
        device_code: 'device-code-0123456789',
        user_code: 'WDJB-MJHT',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 5,
      })
    }
    if (url.pathname === '/login/oauth/access_token') return Response.json(this.polls.shift() ?? { access_token: 'gho_test_token', token_type: 'bearer', scope: '' })
    if (url.pathname === '/user') {
      this.tokensSeen.push(new Headers(init?.headers).get('authorization') ?? '')
      return Response.json(this.user)
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch
}

export interface HarnessOptions {
  env?: Partial<GatewayEnvVars>
  /** Adjusts the parsed configuration, for limits no variable sets. */
  tweak?: (config: GatewayConfig) => void
  /** The free pool to start with; null starts with none. */
  pool?: readonly CatalogModel[] | null
}

export interface FetchOptions {
  method?: string
  json?: unknown
  body?: RequestInit['body']
  token?: string
  headers?: Record<string, string>
  ip?: string
  signal?: AbortSignal
}

export class Harness {
  readonly clock = { now: START }
  readonly openrouter = new FakeOpenRouter()
  readonly github = new FakeGitHub()
  readonly webhooks: Array<{ url: string; body: Record<string, unknown> }> = []
  readonly pending: Array<Promise<unknown>> = []
  readonly log = new MemoryLogger()
  readonly store = new MemoryConfigStore()
  readonly accounts = new MemoryAccounts()
  readonly addresses: MemoryAddresses
  readonly users: MemoryUsers
  readonly control: MemoryControl
  readonly gateway: Gateway

  private constructor(
    readonly config: GatewayConfig,
    readonly tokens: TokenService,
  ) {
    const now = () => this.clock.now
    this.addresses = new MemoryAddresses(now)
    this.users = new MemoryUsers(config, now)
    this.control = new MemoryControl(config, now)
    this.gateway = new Gateway({
      config,
      tokens,
      accounts: this.accounts,
      users: this.users,
      control: this.control,
      addresses: this.addresses,
      store: this.store,
      github: config.githubClientId
        ? new GitHubClient({ baseUrl: config.githubBaseUrl, apiBaseUrl: config.githubApiBaseUrl, clientId: config.githubClientId }, this.github.fetch)
        : null,
      upstreamFetch: this.openrouter.fetch,
      webhookFetch: (async (input: FetchInput, init?: RequestInit) => {
        this.webhooks.push({ url: requestUrl(input).href, body: JSON.parse(String(init?.body)) as Record<string, unknown> })
        return new Response('ok')
      }) as typeof fetch,
      log: this.log,
      now,
      sleep: async (ms, signal) => {
        if (!signal?.aborted) this.clock.now += ms
      },
    })
  }

  static async create(options: HarnessOptions = {}): Promise<Harness> {
    const parsed = parseConfig({ ...TEST_ENV, ...options.env })
    if (!parsed.ok) throw new Error(`test configuration is invalid: ${parsed.problems.join('; ')}`)
    options.tweak?.(parsed.config)
    const tokens = await TokenService.create(parsed.config.secret, parsed.config.previousSecret, parsed.config.tokens.accessTtlSeconds)
    const harness = new Harness(parsed.config, tokens)
    const pool = options.pool === undefined ? CATALOG : options.pool
    if (pool) harness.store.doc = poolDocument(pool, harness.clock.now)
    return harness
  }

  advance(ms: number): void {
    this.clock.now += ms
  }

  request(path: string, options: FetchOptions = {}): Request {
    const headers = new Headers(options.headers)
    let body = options.body
    if (options.json !== undefined) {
      if (!headers.has('content-type')) headers.set('content-type', 'application/json')
      body = JSON.stringify(options.json)
    }
    if (options.token) headers.set('authorization', `Bearer ${options.token}`)
    if (!headers.has('cf-connecting-ip')) headers.set('cf-connecting-ip', options.ip ?? '203.0.113.7')
    const method = options.method ?? (body !== undefined ? 'POST' : 'GET')
    return new Request(`https://gateway.example.test${path}`, { method, headers, ...(body !== undefined ? { body } : {}), ...(options.signal ? { signal: options.signal } : {}) })
  }

  fetch(path: string, options: FetchOptions = {}): Promise<Response> {
    return this.gateway.fetch(this.request(path, options), { waitUntil: (promise) => void this.pending.push(promise) })
  }

  /** Waits for background work the gateway handed to waitUntil: stream pumps, reports, cancellations. */
  async idle(): Promise<void> {
    while (this.pending.length) await Promise.allSettled(this.pending.splice(0))
  }

  async signIn(user: Partial<{ id: number; login: string; type: string; created_at: string }> = {}, deviceId = DEVICE_ID): Promise<SessionTokens> {
    this.github.user = { ...this.github.user, ...user }
    const start = await this.fetch(GatewayPaths.deviceStart, { json: { device_id: deviceId } })
    if (start.status !== 200) throw new Error(`device start answered ${start.status}: ${await start.text()}`)
    const { device_code: deviceCode } = (await start.json()) as { device_code: string }
    const poll = await this.fetch(GatewayPaths.devicePoll, { json: { device_code: deviceCode, device_id: deviceId } })
    const body = (await poll.json()) as { status?: string } & SessionTokens
    if (poll.status !== 200 || body.status !== 'complete') throw new Error(`device poll answered ${poll.status}: ${JSON.stringify(body)}`)
    return body
  }

  chat(token: string, body: Record<string, unknown>, options: Omit<FetchOptions, 'json' | 'token'> = {}): Promise<Response> {
    return this.fetch(GatewayPaths.chatCompletions, { ...options, json: { model: VirtualModels.main, messages: [{ role: 'user', content: 'Hi' }], ...body }, token })
  }
}

/** The `data:` payloads and comments of an SSE body, in order. */
export function readSse(text: string): { comments: string[]; events: unknown[]; done: boolean } {
  const comments: string[] = []
  const events: unknown[] = []
  let done = false
  for (const block of text.split('\n\n')) {
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) comments.push(line.slice(1).trim())
      else if (line.startsWith('data: [DONE]')) done = true
      else if (line.startsWith('data:')) events.push(JSON.parse(line.slice(5)))
    }
  }
  return { comments, events, done }
}
