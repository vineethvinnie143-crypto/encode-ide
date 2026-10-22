/**
 * How a failed model call is classified, in one place for every adapter and
 * for the router's failover policy: what went wrong, whether waiting helps
 * (and until when), and, for a prompt that is too long, the numbers compaction
 * needs.
 */

export type TransportErrorKind =
  /** The key is missing, wrong or revoked: this provider cannot be used until it is fixed. */
  | 'auth'
  /** Out of credit (HTTP 402, a negative balance). */
  | 'payment'
  /** Too many requests for now; `retryAt` says when, if the server did. */
  | 'rate-limit'
  /** A daily or plan quota is spent; `retryAt` is its reset, if known. */
  | 'quota'
  | 'overloaded'
  | 'server'
  | 'timeout'
  /** The connection failed or dropped. */
  | 'network'
  /** The prompt does not fit the model's context window. */
  | 'context-overflow'
  /** The endpoint lacks something the request needs: streaming, tools, images. */
  | 'unsupported'
  | 'not-found'
  | 'content-filter'
  | 'invalid-request'
  /** The response broke the protocol: malformed JSON, a stream that ended early. */
  | 'protocol'

export interface TransportErrorDetails {
  status?: number
  /** Epoch ms after which a retry may succeed. */
  retryAt?: number
  /** For context-overflow: the window the server reported, and the prompt size it counted. */
  window?: number
  used?: number
  /** For unsupported: what is missing. */
  feature?: 'stream' | 'tools' | 'images'
  /**
   * For rate-limit and quota: whom the limit binds. `account` is the whole key
   * (OpenRouter's free-model caps, a gateway quota), so every model behind it
   * waits; `model` (or unset) is this model alone, typically its upstream.
   */
  scope?: 'model' | 'account'
  /** The provider's own error code (OpenRouter's error_type, the gateway's code), for special cases and logs. */
  code?: string
  /** For a server tool the API refused: the APIs that do take it, as the provider names them (`responses`, `anthropic-messages`). */
  apis?: readonly string[]
  cause?: unknown
}

export class TransportError extends Error {
  readonly kind: TransportErrorKind
  readonly status?: number
  readonly retryAt?: number
  readonly window?: number
  readonly used?: number
  readonly feature?: 'stream' | 'tools' | 'images'
  readonly scope?: 'model' | 'account'
  readonly code?: string
  readonly apis?: readonly string[]

  constructor(kind: TransportErrorKind, message: string, details: TransportErrorDetails = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause })
    this.name = 'TransportError'
    this.kind = kind
    this.status = details.status
    this.retryAt = details.retryAt
    this.window = details.window
    this.used = details.used
    this.feature = details.feature
    this.scope = details.scope
    this.code = details.code
    this.apis = details.apis
  }
}

export function isTransportError(error: unknown): error is TransportError {
  return error instanceof TransportError
}

export type HeaderSource = Headers | Record<string, string | string[] | undefined>

function header(headers: HeaderSource | undefined, name: string): string | undefined {
  if (!headers) return undefined
  if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name) ?? undefined
  const record = headers as Record<string, string | string[] | undefined>
  let value = Object.hasOwn(record, name) ? record[name] : undefined
  if (value === undefined) {
    const lower = name.toLowerCase()
    const key = Object.keys(record).find((candidate) => candidate.toLowerCase() === lower)
    value = key === undefined ? undefined : record[key]
  }
  return Array.isArray(value) ? value[0] : value
}

/** "1s", "6m0s", "20ms", "1h2m3.5s" (OpenAI's reset headers) in ms. */
function parseDuration(text: string): number | undefined {
  const units: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1000, ms: 1 }
  let total = 0
  let matched = ''
  for (const match of text.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
    total += Number(match[1]) * units[match[2]]
    matched += match[0]
  }
  return matched && matched === text.replace(/\s+/g, '') ? total : undefined
}

/** A reset header's value as epoch ms: seconds or ms since the epoch, an HTTP or ISO date, or a duration. */
function parseReset(value: string, now: number): number | undefined {
  const text = value.trim()
  if (!text) return undefined
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const number = Number(text)
    if (number > 1e12) return number // epoch ms
    if (number > 1e9) return number * 1000 // epoch seconds
    return now + number * 1000 // seconds from now
  }
  const duration = parseDuration(text)
  if (duration !== undefined) return now + duration
  const date = Date.parse(text)
  return Number.isNaN(date) ? undefined : date
}

const RESET_HEADERS: ReadonlyArray<[reset: string, remaining?: string]> = [
  ['x-ratelimit-reset-requests', 'x-ratelimit-remaining-requests'],
  ['x-ratelimit-reset-tokens', 'x-ratelimit-remaining-tokens'],
  ['anthropic-ratelimit-requests-reset', 'anthropic-ratelimit-requests-remaining'],
  ['anthropic-ratelimit-tokens-reset', 'anthropic-ratelimit-tokens-remaining'],
  ['anthropic-ratelimit-input-tokens-reset', 'anthropic-ratelimit-input-tokens-remaining'],
  ['anthropic-ratelimit-output-tokens-reset', 'anthropic-ratelimit-output-tokens-remaining'],
  ['x-ratelimit-reset', 'x-ratelimit-remaining'],
]

/**
 * When a rate-limited call may be retried, as epoch ms: Retry-After first
 * (the server's own answer), else the reset of the limit that is spent, else
 * the latest reset the server announced.
 */
export function retryAtFrom(headers: HeaderSource | undefined, now = Date.now()): number | undefined {
  const ms = header(headers, 'retry-after-ms')
  if (ms && /^\d+(?:\.\d+)?$/.test(ms.trim())) return now + Number(ms)
  const after = header(headers, 'retry-after')
  if (after) {
    const text = after.trim()
    if (/^\d+(?:\.\d+)?$/.test(text)) return now + Number(text) * 1000
    const date = Date.parse(text)
    if (!Number.isNaN(date)) return date
  }
  let spent: number | undefined
  let latest: number | undefined
  for (const [resetName, remainingName] of RESET_HEADERS) {
    const value = header(headers, resetName)
    if (!value) continue
    const at = parseReset(value, now)
    if (at === undefined || at <= now) continue
    latest = Math.max(latest ?? at, at)
    const remaining = remainingName ? header(headers, remainingName) : undefined
    if (remaining !== undefined && Number(remaining) <= 0) spent = Math.max(spent ?? at, at)
  }
  return spent ?? latest
}

const OVERFLOW =
  /maximum context length|context[ _-]?(?:length|window)[ _-]?exceeded|context_length_exceeded|prompt is too long|too large for model|exceeds the maximum number of tokens|exceeds the available context|greater than the context length|reduce the length of the messages|input is too long|too many (?:input )?tokens/i

const WINDOW_PATTERNS = [
  /maximum context length is ([\d,]+)/i,
  /([\d,]+) maximum context length/i,
  /tokens? > ([\d,]+) maximum/i,
  /maximum number of tokens allowed \(([\d,]+)\)/i,
  /context (?:length|window) (?:of|is) ([\d,]+)/i,
]
const USED_PATTERNS = [
  // "you requested 9000 tokens (7568 in the messages, 1432 in the completion)": the prompt is the first part, not the sum.
  /\(([\d,]+) in the (?:messages|prompt|input)/i,
  /(?:you requested(?: about)?|resulted in) ([\d,]+) tokens/i,
  /prompt is too long: ([\d,]+) tokens/i,
  /input token count \(([\d,]+)\)/i,
  /prompt contains ([\d,]+) tokens/i,
]

function firstNumber(text: string, patterns: readonly RegExp[]): number | undefined {
  for (const pattern of patterns) {
    const match = pattern.exec(text)
    if (!match) continue
    const value = Number(match[1].replace(/,/g, ''))
    if (Number.isFinite(value) && value >= 512 && value <= 100_000_000) return value
  }
  return undefined
}

/**
 * Reads a provider's error text. Null unless it says the prompt is longer
 * than the model's window; otherwise the window and the prompt's size, when
 * the text names them.
 */
export function contextOverflow(message: string): { window?: number; used?: number } | null {
  if (!OVERFLOW.test(message)) return null
  return { window: firstNumber(message, WINDOW_PATTERNS), used: firstNumber(message, USED_PATTERNS) }
}

const STREAM_UNSUPPORTED = /stream(?:ing)?\b[^.]{0,40}\b(?:not (?:be )?supported|unsupported|not available|not allowed|disabled)|does not support stream|unsupported (?:parameter|value)[^.]{0,40}\bstream/i
const TOOLS_UNSUPPORTED =
  /(?:tools?|tool[ _]use|tool[ _]calling|function[ _]calling)\b[^.]{0,40}\b(?:not (?:be )?supported|unsupported|not available)|does not support (?:tools|tool use|tool calling|function calling)|no endpoints found that support tool use/i
const IMAGES_UNSUPPORTED = /(?:image|vision)[^.]{0,40}\b(?:not supported|unsupported)|does not support (?:image|vision)|no endpoints found that support image input/i
const FILTERED = /moderation|flagged|content (?:policy|filter|management)|safety (?:system|filter)/i
const QUOTA = /free-models-per-day|daily (?:limit|quota)|quota (?:exceeded|exhausted)|insufficient_quota|exceeded your current quota/i

/**
 * OpenRouter adds tools of its own to a request: a preset (`@preset/slug`) that has server tools
 * switched on carries them into every call made through it. Some run only on the Responses and
 * Anthropic Messages APIs, and the chat-completions API, which is what eNCode speaks to
 * OpenRouter, then refuses the whole request: "Tool 'openrouter:shell' is not available for the
 * 'chat-completions' API. It is only supported for: responses, anthropic-messages." The key and
 * the model are fine; the preset's tool list is not, and only its owner can change that.
 */
const SERVER_TOOL_REFUSED = /\bTool '(openrouter:[a-z0-9_.-]{1,40})' is not available for the '([a-z-]{1,30})' API/i
/** "It is only supported for: responses, anthropic-messages." */
const SERVER_TOOL_APIS = /\bonly supported for:\s*([a-z-]{1,30}(?:\s*,\s*[a-z-]{1,30}){0,5})/i
/** The `code` of the error that says so (the status is 400, which alone says nothing). */
export const SERVER_TOOL_REFUSED_CODE = 'server_tool_unsupported'

interface ErrorDetail {
  /** The error's type (Anthropic's error.type, OpenAI's error.type). */
  type?: string
  /** Its string code (OpenAI's error.code, the gateway's code). */
  code?: string
  message: string
  /** OpenRouter's metadata: limit_source, reason, resets_at, error_type, provider_code… */
  metadata?: Record<string, unknown>
  /** A retry_after field in the body, in seconds (eNCode's gateway sends one). */
  retryAfter?: number
}

/** The message inside a JSON error body ({error: {message}}, {error: "…"}, {message}), else the body itself. */
function errorDetail(body: string): ErrorDetail {
  const text = body.trim()
  if (text.startsWith('{')) {
    try {
      const json = JSON.parse(text) as Record<string, unknown>
      const error = json.error
      if (typeof error === 'string') return { message: error }
      if (error && typeof error === 'object') {
        const record = error as Record<string, unknown>
        const message = typeof record.message === 'string' ? record.message : text
        const metadata = record.metadata && typeof record.metadata === 'object' ? (record.metadata as Record<string, unknown>) : undefined
        // OpenRouter nests the upstream provider's own error in metadata.raw.
        const raw = metadata?.raw
        const extra = typeof raw === 'string' && raw && !message.includes(raw) ? ` (${raw})` : ''
        const type = typeof record.type === 'string' ? record.type : undefined
        const code = typeof record.code === 'string' ? record.code : undefined
        const retryAfter = typeof record.retry_after === 'number' && Number.isFinite(record.retry_after) && record.retry_after >= 0 ? record.retry_after : undefined
        return { type, code, message: message + extra, metadata, retryAfter }
      }
      if (typeof json.message === 'string') return { message: json.message }
    } catch {
      // Not JSON after all.
    }
  }
  return { message: text }
}

/** Collapses whitespace, caps the length, and masks anything that looks like a key. */
export function errorSnippet(text: string, max = 600): string {
  const clean = text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b(sk|rk|pk|key|or|ant)-[A-Za-z0-9_-]{8,}/g, '$1-…')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer …')
  return clean.length > max ? `${clean.slice(0, max)}…` : clean
}

const ANTHROPIC_TYPES: Record<string, TransportErrorKind> = {
  authentication_error: 'auth',
  permission_error: 'auth',
  billing_error: 'payment',
  not_found_error: 'not-found',
  rate_limit_error: 'rate-limit',
  overloaded_error: 'overloaded',
  api_error: 'server',
  timeout_error: 'timeout',
  request_too_large: 'context-overflow',
}

/**
 * eNCode's gateway codes. Its quotas bind the signed-in user, not one model,
 * so they are account-wide; token_expired asks the client to refresh its token
 * and retry once, which the code tells apart from a revoked one.
 */
const GATEWAY_CODES: Record<string, { kind: TransportErrorKind; scope?: 'account' }> = {
  token_expired: { kind: 'auth' },
  invalid_token: { kind: 'auth' },
  rate_limited: { kind: 'rate-limit', scope: 'account' },
  concurrency_limited: { kind: 'rate-limit', scope: 'account' },
  daily_quota_exhausted: { kind: 'quota', scope: 'account' },
  free_tier_exhausted: { kind: 'quota', scope: 'account' },
  service_disabled: { kind: 'quota', scope: 'account' },
  upstream_unavailable: { kind: 'server' },
  model_not_found: { kind: 'not-found' },
}

/** A table entry for a code from a response body; never an inherited property such as "constructor". */
function lookup<T>(table: Record<string, T>, key: string | undefined): T | undefined {
  return key !== undefined && Object.hasOwn(table, key) ? table[key] : undefined
}

/** OpenRouter's platform limits bind the whole key; a reset this far away is the daily cap, not the minute's. */
const DAILY_RESET_AFTER_MS = 2 * 60_000

/**
 * OpenRouter repeats a platform limit's X-RateLimit-* headers in the body,
 * under error.metadata.headers. They are untrusted like the rest of the body,
 * so only string and number values are kept.
 */
function bodyHeaders(metadata: Record<string, unknown>): Record<string, string> | undefined {
  const raw = metadata.headers
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(name)) continue
    if (typeof value === 'string') out[name] = value.slice(0, 64)
    else if (typeof value === 'number' && Number.isFinite(value)) out[name] = String(value)
  }
  return Object.keys(out).length ? out : undefined
}

function finiteNumber(value: unknown): number | undefined {
  const number = typeof value === 'string' && value.trim() ? Number(value) : value
  return typeof number === 'number' && Number.isFinite(number) ? number : undefined
}

function kindFromText(message: string): Pick<TransportErrorDetails, 'feature' | 'window' | 'used'> & { kind?: TransportErrorKind } {
  const overflow = contextOverflow(message)
  if (overflow) return { kind: 'context-overflow', ...overflow }
  if (STREAM_UNSUPPORTED.test(message)) return { kind: 'unsupported', feature: 'stream' }
  if (TOOLS_UNSUPPORTED.test(message)) return { kind: 'unsupported', feature: 'tools' }
  if (IMAGES_UNSUPPORTED.test(message)) return { kind: 'unsupported', feature: 'images' }
  return {}
}

/**
 * Classifies a failed HTTP response from any provider. `body` is the raw
 * response text; the message keeps a short, key-free excerpt of it.
 */
export function classifyHttpFailure(status: number, headers: HeaderSource | undefined, body: string, now = Date.now()): TransportError {
  const detail = errorDetail(body)
  // Said in words of our own: the provider's text is also about "tools not available", which reads as a model without tool support.
  const serverTool = status === 400 ? SERVER_TOOL_REFUSED.exec(detail.message) : null
  if (serverTool) {
    const [, tool, api] = serverTool
    const apis = SERVER_TOOL_APIS.exec(detail.message)?.[1].split(',').map((name) => name.trim().toLowerCase()).filter(Boolean)
    return new TransportError(
      'invalid-request',
      `HTTP 400: OpenRouter added its ${tool} tool to this request, usually from a preset, and that tool does not work on the ${api} API that eNCode uses. Remove it from the preset on openrouter.ai (Settings, Presets), or use the model without the preset.`,
      { status, code: SERVER_TOOL_REFUSED_CODE, ...(apis?.length ? { apis } : {}) },
    )
  }
  const message = `HTTP ${status}${detail.message ? `: ${errorSnippet(detail.message)}` : ''}`
  const fromText = kindFromText(detail.message)
  const typed = lookup(ANTHROPIC_TYPES, detail.type)
  const gateway = lookup(GATEWAY_CODES, detail.code) ?? lookup(GATEWAY_CODES, detail.type)
  const metadata = detail.metadata ?? {}
  const limitSource = typeof metadata.limit_source === 'string' ? metadata.limit_source : undefined
  const code = detail.code ?? detail.type ?? (typeof metadata.error_type === 'string' ? metadata.error_type : undefined)
  const echoed = bodyHeaders(metadata)
  const limitHeader = (name: string) => header(headers, name) ?? header(echoed, name)
  const retryAt =
    retryAtFrom(headers, now) ?? retryAtFrom(echoed, now) ?? (detail.retryAfter !== undefined ? now + detail.retryAfter * 1000 : undefined)
  const make = (kind: TransportErrorKind, extra: TransportErrorDetails = {}) =>
    new TransportError(kind, message, { status, code, ...extra })

  if (fromText.kind === 'context-overflow' || typed === 'context-overflow' || status === 413) {
    return make('context-overflow', { window: fromText.window, used: fromText.used })
  }
  if (gateway) return make(gateway.kind, { retryAt, scope: gateway.scope })
  if (status === 401) return make('auth')
  if (status === 402) {
    // OpenRouter holds paid requests' cost while they run; a full in-flight budget clears by itself.
    if (limitSource === 'openrouter_in_flight_budget' && metadata.reason !== 'weight_exceeds_budget') {
      return make('rate-limit', { retryAt, scope: 'account' })
    }
    return make('payment', { scope: 'account' })
  }
  if (status === 403) {
    // A budget or guardrail spent its allowance: the key is fine, the money is not, until the window resets.
    if (limitSource) {
      const resetsAt = typeof metadata.resets_at === 'string' ? Date.parse(metadata.resets_at) : Number.NaN
      return make('payment', { scope: 'account', retryAt: Number.isNaN(resetsAt) ? undefined : resetsAt })
    }
    return make(FILTERED.test(detail.message) ? 'content-filter' : typed === 'payment' ? 'payment' : 'auth')
  }
  if (status === 429 || typed === 'rate-limit') {
    // Only OpenRouter's platform limits (its free-model caps) send X-RateLimit-*; an upstream's 429 does not.
    const limit = finiteNumber(limitHeader('x-ratelimit-limit'))
    const platform = limit !== undefined || limitHeader('x-ratelimit-reset') !== undefined
    const daily = QUOTA.test(detail.message) || (platform && limit !== undefined && limit >= 50 && retryAt !== undefined && retryAt - now > DAILY_RESET_AFTER_MS)
    return make(daily ? 'quota' : 'rate-limit', { retryAt, scope: platform ? 'account' : undefined })
  }
  if (status === 408) return make('timeout')
  if (status === 529 || typed === 'overloaded') return make('overloaded', { retryAt })
  if (fromText.kind === 'unsupported') return make('unsupported', { feature: fromText.feature })
  if (status === 405 || status === 415) return make('unsupported')
  if (status === 404) return make('not-found')
  if (status >= 500) return make(status === 503 && /overload|capacity/i.test(detail.message) ? 'overloaded' : 'server', { retryAt })
  if (typed) return make(typed, { retryAt })
  if (FILTERED.test(detail.message) && status === 400) return make('content-filter')
  return make('invalid-request')
}

/**
 * Classifies an error event inside a stream: Anthropic's `event: error`, or an
 * OpenAI-style `{error}` chunk. The HTTP status was 200, so the kind comes
 * from the error's type, code and text. Pass a string code (the gateway's
 * `upstream_unavailable`) as `type`, a numeric one as `code`, and a
 * `retry_after` field (seconds) in `extra`.
 */
export function classifyStreamError(
  type: string | undefined,
  message: string,
  code?: number,
  extra: { retryAfterSeconds?: number; now?: number } = {},
): TransportError {
  const text = errorSnippet(message || 'The provider reported an error mid-stream.')
  const now = extra.now ?? Date.now()
  const retryAt =
    extra.retryAfterSeconds !== undefined && Number.isFinite(extra.retryAfterSeconds) && extra.retryAfterSeconds >= 0
      ? now + extra.retryAfterSeconds * 1000
      : undefined
  const fromText = kindFromText(message)
  if (fromText.kind) return new TransportError(fromText.kind, text, { feature: fromText.feature, window: fromText.window, used: fromText.used, code: type })
  const gateway = lookup(GATEWAY_CODES, type)
  if (gateway) return new TransportError(gateway.kind, text, { retryAt, scope: gateway.scope, code: type, ...(code ? { status: code } : {}) })
  const typed = lookup(ANTHROPIC_TYPES, type)
  if (typed) return new TransportError(typed, text, { retryAt, code: type })
  if (code === 429) return new TransportError(QUOTA.test(message) ? 'quota' : 'rate-limit', text, { status: code, retryAt })
  if (code === 401 || code === 403) return new TransportError('auth', text, { status: code })
  if (code === 402) return new TransportError('payment', text, { status: code })
  if (code === 529) return new TransportError('overloaded', text, { status: code, retryAt })
  if (code && code >= 400 && code < 500) return new TransportError('invalid-request', text, { status: code })
  return new TransportError('server', text, code ? { status: code, retryAt } : { retryAt })
}

const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
])

/** Classifies a thrown fetch or socket error (not an HTTP status). */
export function classifyNetworkFailure(error: unknown, where: string): TransportError {
  if (error instanceof TransportError) return error
  let code: string | undefined
  let detail = error instanceof Error ? error.message : String(error)
  for (let current: unknown = error, depth = 0; current && depth < 4; current = (current as { cause?: unknown }).cause, depth++) {
    const candidate = (current as { code?: unknown }).code
    if (typeof candidate === 'string') {
      code = candidate
      if (current instanceof Error && current !== error) detail = `${detail}: ${current.message}`
      break
    }
  }
  const timeout = (code && /TIMEOUT/.test(code)) || (error instanceof Error && error.name === 'TimeoutError')
  const kind: TransportErrorKind = timeout ? 'timeout' : 'network'
  const known = code && NETWORK_CODES.has(code) ? ` (${code})` : ''
  return new TransportError(kind, `Could not reach ${where}${known}. ${errorSnippet(detail, 300)}`.trim(), { cause: error })
}

/** True when trying the same call again later can succeed without changing it. */
export function isTransient(error: TransportError): boolean {
  return (
    error.kind === 'rate-limit' ||
    error.kind === 'overloaded' ||
    error.kind === 'server' ||
    error.kind === 'timeout' ||
    error.kind === 'network' ||
    error.kind === 'protocol'
  )
}
