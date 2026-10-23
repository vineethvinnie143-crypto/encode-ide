import { inferEditFormat, inferFamily, inferReasoning, type CatalogEntry } from './registry'

/**
 * OpenRouter's account API, which the router reads but never sends prompts
 * to: the model catalog (registry sync and the free pool) and the key's
 * free-request quota. Everything goes through an injected fetch, so this runs
 * in the agent host, the CLI and a Workers gateway alike.
 */

export type Fetch = (input: string, init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
}>

/** The free tier as OpenRouter counts it for one key. */
export interface FreeQuota {
  /** Free-model requests used, allowed and left in the current UTC day. */
  used: number
  limit: number
  remaining: number
  /** When the daily count starts over: the next midnight UTC, epoch ms. */
  resetAt: number
  /** Credits left on the key, or null when the key has no credit limit. */
  creditsRemaining?: number | null
}

const MAX_CATALOG_PAGES = 10

/** OpenRouter quotes prices per token as strings; the registry keeps USD per million tokens (rounded off float noise). */
function perMillion(value: unknown): number | undefined {
  const n = typeof value === 'string' && value.trim() ? Number(value) : typeof value === 'number' ? value : Number.NaN
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1e12) / 1e6 : undefined
}

/** Fields of a `pricing` object that are not prices: a discount is a fraction off the price, not something charged. */
const NOT_A_PRICE = new Set(['discount'])

/** Zero as OpenRouter writes it, a string or a number. A price that cannot be read is not zero. */
function isZeroPrice(value: unknown): boolean {
  const n = typeof value === 'string' && value.trim() ? Number(value) : typeof value === 'number' ? value : Number.NaN
  return n === 0
}

/** A pricing value for a message: short, and never more than the value itself says. */
function shown(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value.length > 24 ? `${value.slice(0, 24)}…` : value)
  if (typeof value === 'number') return String(value)
  return value === null ? 'null' : typeof value
}

export interface FreeVerdict {
  free: boolean
  /** Why the model is not free; empty when it is. */
  reasons: string[]
}

/**
 * Whether OpenRouter promises that calling the model costs nothing. Only a
 * `:free` id carries that promise (a model priced at zero today can be
 * priced tomorrow), and every price OpenRouter quotes for it must be zero: not
 * only the prompt and completion tokens but also a price per request, per
 * image, per web search, for reasoning and for the cache. A price that is
 * missing, unreadable or one this code has never heard of counts against the
 * model, so a new kind of charge cannot slip through as free.
 */
export function freeVerdict(id: string, pricing: Record<string, unknown>): FreeVerdict {
  const reasons: string[] = []
  if (!id.endsWith(':free')) reasons.push('its id does not end in :free')
  for (const name of ['prompt', 'completion']) if (pricing[name] === undefined) reasons.push(`no ${name} price is listed`)
  for (const [name, value] of Object.entries(pricing)) {
    if (!NOT_A_PRICE.has(name) && !isZeroPrice(value)) reasons.push(`its ${name} price is ${shown(value)}, not zero`)
  }
  return { free: reasons.length === 0, reasons: reasons.slice(0, 8) }
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

const MODEL_ID = /^[\x21-\x7e]{1,256}$/

/**
 * Catalog entries from a /models response. Models that cannot answer in text
 * are left out, and so is anything malformed: the response is untrusted input.
 */
export function parseOpenRouterCatalog(json: unknown): CatalogEntry[] {
  const data = (json as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) return []
  const out: CatalogEntry[] = []
  const seen = new Set<string>()
  for (const raw of data) {
    if (!raw || typeof raw !== 'object') continue
    const m = raw as Record<string, unknown>
    const id = typeof m.id === 'string' ? m.id.trim() : ''
    if (!MODEL_ID.test(id) || seen.has(id)) continue

    const architecture = (m.architecture ?? {}) as Record<string, unknown>
    const outputs = strings(architecture.output_modalities)
    if (outputs.length && !outputs.includes('text')) continue
    const inputs = strings(architecture.input_modalities)

    const top = (m.top_provider ?? {}) as Record<string, unknown>
    const contextWindow = positiveInt(top.context_length) ?? positiveInt(m.context_length)
    if (!contextWindow) continue
    const limits = (m.per_request_limits ?? {}) as Record<string, unknown>
    const maxOutputTokens = Math.min(
      positiveInt(top.max_completion_tokens) ?? positiveInt(limits.completion_tokens) ?? Math.min(16_384, Math.floor(contextWindow / 4)),
      contextWindow,
    )

    const pricing = (m.pricing ?? {}) as Record<string, unknown>
    const input = perMillion(pricing.prompt)
    const output = perMillion(pricing.completion)
    if (input === undefined || output === undefined) continue
    const params = new Set(strings(m.supported_parameters))
    const tools = params.has('tools')
    const family = inferFamily(id)
    const created = positiveInt(m.created)
    const expires = typeof m.expiration_date === 'string' ? Date.parse(m.expiration_date) : Number.NaN

    seen.add(id)
    out.push({
      model: id,
      name: typeof m.name === 'string' && m.name.trim() ? m.name.trim().slice(0, 200) : id,
      family,
      contextWindow,
      maxOutputTokens,
      capabilities: {
        tools,
        parallelTools: tools,
        images: inputs.includes('image'),
        documents: inputs.includes('file'),
        reasoning: inferReasoning(id, params.has('reasoning') || params.has('include_reasoning')),
        // Explicit cache breakpoints cost a cache write (Anthropic, Gemini); automatic caching only discounts reads.
        promptCache: pricing.input_cache_write !== undefined,
      },
      editFormat: inferEditFormat(family, id),
      price: { input, output },
      free: freeVerdict(id, pricing).free,
      created: created ? created * 1000 : undefined,
      expiresAt: Number.isFinite(expires) ? expires : undefined,
      roles: Array.isArray(m.roles) ? strings(m.roles).slice(0, 20) : undefined,
    })
  }
  return out
}

/** The next midnight UTC after `now`, when OpenRouter's daily free count starts over. */
export function nextUtcMidnight(now: number): number {
  const date = new Date(now)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1)
}

/** The free-tier part of a GET /key response, or null when it carries none. */
export function parseKeyInfo(json: unknown, now: number): FreeQuota | null {
  const data = (json as { data?: unknown } | null)?.data as Record<string, unknown> | undefined
  if (!data || typeof data !== 'object') return null
  const daily = data.free_model_daily_requests as Record<string, unknown> | undefined
  const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined)
  const limit = num(daily?.limit)
  const used = num(daily?.used)
  const remaining = num(daily?.remaining)
  if (limit === undefined || (used === undefined && remaining === undefined)) return null
  const credits = data.limit_remaining
  return {
    limit,
    used: used ?? Math.max(0, limit - (remaining ?? 0)),
    remaining: remaining ?? Math.max(0, limit - (used ?? 0)),
    resetAt: nextUtcMidnight(now),
    creditsRemaining: credits === null ? null : num(credits),
  }
}

function sameOrigin(next: string, base: string): string | null {
  try {
    const url = new URL(next, base)
    return url.origin === new URL(base).origin ? url.href : null
  } catch {
    return null
  }
}

/**
 * Fetches the whole catalog, following pagination links on the same origin.
 * The catalog is public, so no key is sent with it.
 */
export async function fetchOpenRouterCatalog(options: { fetch: Fetch; baseUrl: string; signal?: AbortSignal }): Promise<CatalogEntry[]> {
  const entries: CatalogEntry[] = []
  let url: string | null = `${options.baseUrl}/models`
  for (let page = 0; url && page < MAX_CATALOG_PAGES; page++) {
    const response = await options.fetch(url, { headers: { accept: 'application/json' }, signal: options.signal })
    if (!response.ok) throw new Error(`The model catalog answered HTTP ${response.status}.`)
    const json = await response.json()
    entries.push(...parseOpenRouterCatalog(json))
    const next = (json as { links?: { next?: unknown } } | null)?.links?.next
    url = typeof next === 'string' && next ? sameOrigin(next, url) : null
  }
  const seen = new Set<string>()
  return entries.filter((entry) => !seen.has(entry.model) && Boolean(seen.add(entry.model)))
}

/** The key's free-request quota, or null when OpenRouter does not report one. */
export async function fetchFreeQuota(options: {
  fetch: Fetch
  baseUrl: string
  apiKey: string
  now: number
  signal?: AbortSignal
}): Promise<FreeQuota | null> {
  const response = await options.fetch(`${options.baseUrl}/key`, {
    headers: { accept: 'application/json', authorization: `Bearer ${options.apiKey}` },
    signal: options.signal,
  })
  if (!response.ok) throw new Error(`The key endpoint answered HTTP ${response.status}.`)
  return parseKeyInfo(await response.json(), options.now)
}
