/**
 * The wire contract between eNCode clients and the free-tier gateway
 * (apps/gateway). Both sides import it, so paths, virtual model ids, header
 * names and error codes cannot drift apart. It has no dependencies and runs in
 * Node, Electron and the Workers runtime.
 *
 * docs/gateway-protocol.md describes the protocol in prose, with examples.
 */

export const GATEWAY_API_VERSION = 1

export const GatewayPaths = {
  chatCompletions: '/v1/chat/completions',
  models: '/v1/models',
  status: '/v1/status',
  me: '/v1/me',
  deviceStart: '/v1/auth/device/start',
  devicePoll: '/v1/auth/device/poll',
  refresh: '/v1/auth/refresh',
  logout: '/v1/auth/logout',
} as const

/** The only model ids the gateway accepts. It picks the real `:free` model behind each one. */
export const VirtualModels = {
  main: 'encode/free-main',
  fast: 'encode/free-fast',
} as const

export type VirtualModelId = (typeof VirtualModels)[keyof typeof VirtualModels]

export const VIRTUAL_MODEL_IDS: readonly VirtualModelId[] = [VirtualModels.main, VirtualModels.fast]

/** The router roles each virtual model serves. GET /v1/models repeats them as `roles`. */
export const VIRTUAL_MODEL_ROLES: Readonly<Record<VirtualModelId, readonly string[]>> = {
  [VirtualModels.main]: ['main', 'planner', 'reviewer'],
  [VirtualModels.fast]: ['explore', 'summarizer', 'utility'],
}

export function isVirtualModelId(value: unknown): value is VirtualModelId {
  return typeof value === 'string' && (VIRTUAL_MODEL_IDS as readonly string[]).includes(value)
}

export const GatewayHeaders = {
  /** On every response: quote it in bug reports. */
  requestId: 'x-encode-request-id',
  /** On non-streaming chat responses: the real model that answered. A stream names it in each chunk's `model`. */
  model: 'x-encode-model',
  /** On chat responses: requests this account has left today. */
  quotaRemaining: 'x-encode-quota-remaining',
  /** On chat responses: when the daily quota resets, in epoch milliseconds. */
  quotaReset: 'x-encode-quota-reset',
  /** On requests: `<app>/<version>`, for example `desktop/0.1.0`. */
  client: 'x-encode-client',
} as const

/** Sent while the gateway connects to a model or fails over, before the first chunk. Clients count it as liveness. */
export const SSE_KEEPALIVE = ': keepalive\n\n'

/** Starts the comment line that names the model about to stream. */
export const SSE_MODEL_COMMENT = ': encode-model '

/**
 * The chat request fields the gateway forwards. Everything else a client
 * sends is dropped, because fields such as `models`, `provider`, `plugins` or
 * `transforms` could route a request to a paid model or a paid feature.
 */
export const CHAT_REQUEST_FIELDS = [
  'model',
  'messages',
  'tools',
  'tool_choice',
  'parallel_tool_calls',
  'temperature',
  'top_p',
  'max_tokens',
  'stop',
  'seed',
  'response_format',
  'reasoning',
  'stream',
  'stream_options',
] as const

export type GatewayErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'permission_error'
  | 'not_found_error'
  | 'rate_limit_error'
  | 'service_unavailable_error'
  | 'upstream_error'
  | 'api_error'

/** What a client does about an error. */
export type GatewayErrorAction =
  /** Get a new access token and retry once. */
  | 'refresh'
  /** The session is gone: ask the user to sign in again. */
  | 'sign_in'
  /** Retry after `retry_after` seconds. */
  | 'wait'
  /** The free tier cannot serve this account until `retry_after`: use the next provider in the role list. */
  | 'next_tier'
  /** A transient gateway or upstream failure: back off, then use the next tier. */
  | 'backoff'
  /** The client is older than the gateway serves. */
  | 'update'
  /** The request itself is wrong, so sending it again fails again. */
  | 'fix'

interface ErrorSpec {
  readonly status: number
  readonly type: GatewayErrorType
  readonly action: GatewayErrorAction
}

export const GATEWAY_ERRORS = {
  invalid_request: { status: 400, type: 'invalid_request_error', action: 'fix' },
  model_not_found: { status: 400, type: 'invalid_request_error', action: 'fix' },
  request_too_large: { status: 413, type: 'invalid_request_error', action: 'fix' },
  unsupported_media_type: { status: 415, type: 'invalid_request_error', action: 'fix' },
  not_found: { status: 404, type: 'not_found_error', action: 'fix' },
  method_not_allowed: { status: 405, type: 'invalid_request_error', action: 'fix' },
  auth_required: { status: 401, type: 'authentication_error', action: 'sign_in' },
  invalid_token: { status: 401, type: 'authentication_error', action: 'sign_in' },
  token_expired: { status: 401, type: 'authentication_error', action: 'refresh' },
  invalid_grant: { status: 401, type: 'authentication_error', action: 'sign_in' },
  account_suspended: { status: 403, type: 'permission_error', action: 'next_tier' },
  account_not_eligible: { status: 403, type: 'permission_error', action: 'next_tier' },
  signup_closed: { status: 403, type: 'permission_error', action: 'next_tier' },
  client_outdated: { status: 426, type: 'invalid_request_error', action: 'update' },
  rate_limited: { status: 429, type: 'rate_limit_error', action: 'wait' },
  concurrency_limited: { status: 429, type: 'rate_limit_error', action: 'wait' },
  free_tier_busy: { status: 429, type: 'rate_limit_error', action: 'wait' },
  daily_quota_exhausted: { status: 429, type: 'rate_limit_error', action: 'next_tier' },
  token_quota_exhausted: { status: 429, type: 'rate_limit_error', action: 'next_tier' },
  free_tier_exhausted: { status: 503, type: 'service_unavailable_error', action: 'next_tier' },
  service_disabled: { status: 503, type: 'service_unavailable_error', action: 'next_tier' },
  upstream_unavailable: { status: 503, type: 'upstream_error', action: 'backoff' },
  upstream_error: { status: 502, type: 'upstream_error', action: 'backoff' },
  upstream_timeout: { status: 504, type: 'upstream_error', action: 'backoff' },
  internal_error: { status: 500, type: 'api_error', action: 'backoff' },
} as const satisfies Record<string, ErrorSpec>

export type GatewayErrorCode = keyof typeof GATEWAY_ERRORS

export interface GatewayErrorDetail {
  message: string
  type: GatewayErrorType
  code: GatewayErrorCode
  /** Seconds until a retry can succeed, when the gateway knows. */
  retry_after?: number
}

/** The JSON body of every error response, and of the in-band chunk that ends a failed stream. */
export interface GatewayErrorBody {
  error: GatewayErrorDetail
}

export function isGatewayErrorCode(value: unknown): value is GatewayErrorCode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(GATEWAY_ERRORS, value)
}

/** What to do about an error code. Codes this build does not know are treated as transient. */
export function errorAction(code: string): GatewayErrorAction {
  return isGatewayErrorCode(code) ? GATEWAY_ERRORS[code].action : 'backoff'
}

/**
 * The gateway error inside a parsed JSON body or stream chunk, or undefined
 * when there is none. Upstream errors relayed mid-stream carry numeric codes,
 * so they are not gateway errors and come back undefined.
 */
export function readGatewayError(json: unknown): GatewayErrorDetail | undefined {
  if (!json || typeof json !== 'object') return undefined
  const error = (json as { error?: unknown }).error
  if (!error || typeof error !== 'object') return undefined
  const { code, message, type, retry_after: retryAfter } = error as Record<string, unknown>
  if (!isGatewayErrorCode(code)) return undefined
  return {
    code,
    message: typeof message === 'string' ? message : code,
    type: typeof type === 'string' ? (type as GatewayErrorType) : GATEWAY_ERRORS[code].type,
    ...(typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter >= 0 ? { retry_after: retryAfter } : {}),
  }
}

export interface AccountInfo {
  /** The gateway's own account id. It never changes, unlike a GitHub login. */
  id: string
  login: string
  avatar_url?: string
}

export interface DeviceStartRequest {
  /** A random id the client creates once per install and keeps in the keychain. 32 to 128 base64url characters. */
  device_id: string
}

export interface DeviceStartResponse {
  device_code: string
  /** Show this to the user, who enters it at `verification_uri`. */
  user_code: string
  verification_uri: string
  /** Seconds until the codes expire. */
  expires_in: number
  /** Seconds to wait between polls. */
  interval: number
}

export interface DevicePollRequest {
  device_code: string
  device_id: string
}

export interface SessionTokens {
  access_token: string
  token_type: 'Bearer'
  /** Seconds the access token stays valid. */
  expires_in: number
  /** Single use: each refresh returns a new one. */
  refresh_token: string
  /** Seconds the refresh token stays valid if it is not used. */
  refresh_expires_in: number
  account: AccountInfo
}

export type DevicePollResponse =
  | { status: 'pending'; interval: number }
  | { status: 'slow_down'; interval: number }
  | { status: 'denied' }
  | { status: 'expired' }
  | ({ status: 'complete' } & SessionTokens)

export interface RefreshRequest {
  refresh_token: string
  device_id: string
}

export interface LogoutRequest {
  refresh_token: string
  device_id: string
}

export interface QuotaSnapshot {
  requests: { used: number; limit: number; remaining: number }
  input_tokens: { used: number; limit: number }
  output_tokens: { used: number; limit: number }
  requests_per_minute: number
  concurrent_streams: number
  /** The next daily reset (UTC midnight), in epoch milliseconds. */
  reset_at: number
}

export interface MeResponse {
  account: AccountInfo
  quota: QuotaSnapshot
}

export interface StatusResponse {
  service: 'encode-gateway'
  api_version: number
  free_tier: {
    available: boolean
    /** Set when the free tier is off or running low. Show it as a banner. */
    message?: string
    /** When it is expected back, in epoch milliseconds, if known. */
    available_at?: number
  }
  /** The oldest client version the gateway serves, when it enforces one. */
  min_client_version?: string
  /** What free providers may do with prompts. Show it before the first free request. */
  data_policy: string
}

export interface VirtualModelInfo {
  id: VirtualModelId
  object: 'model'
  owned_by: 'encode'
  name: string
  roles: readonly string[]
  /** The smallest context window among the models the gateway would try first. */
  context_length: number
  max_output_tokens: number
  supports_tools: boolean
  supports_images: boolean
  /** False while no free model is available behind this id. */
  available: boolean
}

export interface ModelListResponse {
  object: 'list'
  data: VirtualModelInfo[]
}

const VERSION = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-([0-9A-Za-z.-]{1,64}))?$/

/** Compares two `major.minor.patch[-pre]` versions; a pre-release sorts before its release. Null when either does not parse. */
export function compareVersions(a: string, b: string): number | null {
  const left = VERSION.exec(a)
  const right = VERSION.exec(b)
  if (!left || !right) return null
  for (let index = 1; index <= 3; index++) {
    const difference = Number(left[index]) - Number(right[index])
    if (difference) return Math.sign(difference)
  }
  if (left[4] === right[4]) return 0
  if (left[4] === undefined) return 1
  if (right[4] === undefined) return -1
  return left[4] < right[4] ? -1 : 1
}

const CLIENT = /^([a-z][a-z0-9-]{0,31})\/(\S{1,80})$/

export function formatClientHeader(app: string, version: string): string {
  return `${app}/${version}`
}

/** Splits an `x-encode-client` value into app and version, or null when it is malformed. */
export function parseClientHeader(value: string | null | undefined): { app: string; version: string } | null {
  const match = value ? CLIENT.exec(value.trim()) : null
  return match ? { app: match[1], version: match[2] } : null
}
