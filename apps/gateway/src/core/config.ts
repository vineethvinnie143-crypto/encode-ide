/**
 * The gateway's configuration, read from Worker variables and secrets. Every
 * value is checked once per isolate; a missing secret or a malformed number
 * stops the gateway from serving instead of running with a guessed default.
 */

/** Variables and secrets as the runtime hands them over (see wrangler.jsonc and DEPLOY.md). */
export interface GatewayEnvVars {
  ENVIRONMENT?: string
  OPENROUTER_API_KEY?: string
  GATEWAY_SECRET?: string
  GATEWAY_SECRET_PREVIOUS?: string
  ADMIN_TOKEN?: string
  ALERT_WEBHOOK_URL?: string
  GITHUB_CLIENT_ID?: string
  APP_URL?: string
  APP_TITLE?: string
  KILL_SWITCH?: string
  KILL_SWITCH_MESSAGE?: string
  OPENROUTER_BASE_URL?: string
  GITHUB_BASE_URL?: string
  GITHUB_API_BASE_URL?: string
  SIGNUP_MODE?: string
  ALLOWED_GITHUB_LOGINS?: string
  MIN_GITHUB_ACCOUNT_AGE_DAYS?: string
  MIN_CLIENT_VERSION?: string
  USER_REQUESTS_PER_MINUTE?: string
  USER_REQUESTS_PER_DAY?: string
  USER_INPUT_TOKENS_PER_DAY?: string
  USER_OUTPUT_TOKENS_PER_DAY?: string
  USER_MAX_CONCURRENT?: string
  USER_REFUNDS_PER_DAY?: string
  GLOBAL_REQUESTS_PER_DAY?: string
  GLOBAL_REQUESTS_PER_MINUTE?: string
  MAX_BODY_BYTES?: string
  MAX_OUTPUT_TOKENS?: string
  DEFAULT_OUTPUT_TOKENS?: string
  UPSTREAM_FALLBACK_MODELS?: string
}

export type SignupMode = 'open' | 'allowlist' | 'closed'

export interface UserLimits {
  requestsPerMinute: number
  requestsPerDay: number
  inputTokensPerDay: number
  outputTokensPerDay: number
  maxConcurrent: number
  /** Requests a day handed back after upstream failures; more would let one account drain the shared budget. */
  refundsPerDay: number
  /** A lease outlives any request, so a crashed request frees its slot by itself. */
  leaseTtlMs: number
  /** Multiplier on daily limits while an account is flagged for machine-speed use. */
  flaggedScale: number
  /** Distinct active hours out of the last 24 that flag an account as running around the clock. */
  flagActiveHours: number
  /** Distinct minutes within an hour spent at the per-minute limit that flag an account as scripted. */
  flagSaturatedMinutes: number
}

export interface GlobalLimits {
  /** Our own ceiling on free requests a day, below OpenRouter's so personal use of the account keeps headroom. */
  requestsPerDay: number
  /** Upstream starts per rolling minute, below OpenRouter's account-wide 20. */
  requestsPerMinute: number
  /** Below this fraction of the daily budget left, per-account limits shrink toward a fair share. */
  fairShareStart: number
  /** Per-account limits never shrink below this fraction. */
  fairShareFloor: number
  /** The longest a request waits in line for an upstream slot before it gets free_tier_busy. */
  maxQueueWaitMs: number
}

export interface UpstreamLimits {
  /** Time to the first content chunk on one attempt. */
  firstEventTimeoutMs: number
  /** The same for models that think before they answer. */
  reasoningFirstEventTimeoutMs: number
  /** Total time spent before the first content chunk, across failovers. Under the client's 60 s. */
  preStreamBudgetMs: number
  /** Silence mid-stream before the gateway gives up on the upstream. */
  idleTimeoutMs: number
  /** The longest a single request may run. */
  maxDurationMs: number
  maxAttempts: number
  /** `:free` models offered to OpenRouter per attempt, for its own fallback before the first byte. */
  fallbackModels: number
  keepaliveMs: number
}

export interface RequestLimits {
  maxBodyBytes: number
  maxOutputTokens: number
  defaultOutputTokens: number
  maxMessages: number
  maxTools: number
}

export interface GatewayConfig {
  environment: 'production' | 'development'
  openRouterBaseUrl: string
  openRouterKey: string
  githubBaseUrl: string
  githubApiBaseUrl: string
  /** Null leaves sign-in off. */
  githubClientId: string | null
  appUrl: string | null
  appTitle: string
  secret: string
  previousSecret: string | null
  /** Null leaves the admin API off. */
  adminToken: string | null
  alertWebhookUrl: string | null
  killSwitch: { on: boolean; message: string }
  minClientVersion: string | null
  signup: { mode: SignupMode; allowedLogins: string[]; minAccountAgeDays: number }
  tokens: { accessTtlSeconds: number; refreshTtlSeconds: number; sessionMaxSeconds: number; refreshGraceSeconds: number }
  signIn: { startsPerIpPerHour: number; pollsPerIpPerMinute: number; refreshesPerIpPerMinute: number }
  user: UserLimits
  global: GlobalLimits
  upstream: UpstreamLimits
  request: RequestLimits
  alerts: { quotaFraction: number; modelErrorRate: number; minSamples: number }
  dataPolicy: string
}

export type ConfigResult = { ok: true; config: GatewayConfig } | { ok: false; problems: string[] }

export const DATA_POLICY =
  'Free models are served by providers that may log prompts and use them for training. Do not send code or data you cannot share; use your own key for private work.'

const DEFAULT_KILL_MESSAGE = 'The eNCode free tier is paused. Your own keys still work.'
const MINUTE = 60_000

export function parseConfig(env: GatewayEnvVars): ConfigResult {
  const problems: string[] = []
  const environment = env.ENVIRONMENT === 'development' ? 'development' : 'production'

  const text = (name: keyof GatewayEnvVars): string | null => {
    const value = env[name]?.trim()
    return value ? value : null
  }

  const integer = (name: keyof GatewayEnvVars, fallback: number, min: number, max: number): number => {
    const raw = text(name)
    if (raw === null) return fallback
    if (!/^\d+$/.test(raw)) {
      problems.push(`${name} must be a whole number`)
      return fallback
    }
    const value = Number(raw)
    if (value < min || value > max) problems.push(`${name} must be between ${min} and ${max}`)
    return value
  }

  const url = (name: keyof GatewayEnvVars, fallback: string | null): string | null => {
    const raw = text(name) ?? fallback
    if (raw === null) return null
    let parsed: URL
    try {
      parsed = new URL(raw)
    } catch {
      problems.push(`${name} is not a URL`)
      return fallback
    }
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
    const secure = parsed.protocol === 'https:' || (environment === 'development' && parsed.protocol === 'http:' && loopback)
    if (!secure) problems.push(`${name} must use https (plain http is allowed for loopback hosts in development only)`)
    if (parsed.username || parsed.password) problems.push(`${name} must not carry credentials`)
    return raw.replace(/\/+$/, '')
  }

  const secret = text('GATEWAY_SECRET')
  if (!secret || secret.length < 32) problems.push('GATEWAY_SECRET must be set to at least 32 random characters')
  const previousSecret = text('GATEWAY_SECRET_PREVIOUS')
  if (previousSecret !== null && previousSecret.length < 32) problems.push('GATEWAY_SECRET_PREVIOUS must be at least 32 characters')

  const openRouterKey = text('OPENROUTER_API_KEY')
  if (!openRouterKey) problems.push('OPENROUTER_API_KEY must be set')
  else if (!/^[\x21-\x7e]+$/.test(openRouterKey)) problems.push('OPENROUTER_API_KEY must be one line of printable ASCII')

  // An admin token too short to resist guessing leaves the admin API off rather than half-protected.
  const adminRaw = text('ADMIN_TOKEN')
  if (adminRaw !== null && adminRaw.length < 32) problems.push('ADMIN_TOKEN must be at least 32 characters when set')

  const mode = text('SIGNUP_MODE') ?? 'allowlist'
  if (mode !== 'open' && mode !== 'allowlist' && mode !== 'closed') problems.push('SIGNUP_MODE must be open, allowlist or closed')

  const githubClientId = text('GITHUB_CLIENT_ID')
  if (githubClientId !== null && !/^[A-Za-z0-9._-]{8,64}$/.test(githubClientId)) problems.push('GITHUB_CLIENT_ID does not look like a client id')

  const minClientVersion = text('MIN_CLIENT_VERSION')
  if (minClientVersion !== null && !/^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,64})?$/.test(minClientVersion)) {
    problems.push('MIN_CLIENT_VERSION must look like 1.2.3')
  }

  const requestsPerMinute = integer('GLOBAL_REQUESTS_PER_MINUTE', 18, 1, 1000)
  const maxOutputTokens = integer('MAX_OUTPUT_TOKENS', 16_384, 256, 262_144)
  const defaultOutputTokens = integer('DEFAULT_OUTPUT_TOKENS', 8_192, 256, 262_144)
  if (defaultOutputTokens > maxOutputTokens) problems.push('DEFAULT_OUTPUT_TOKENS must not exceed MAX_OUTPUT_TOKENS')

  const config: GatewayConfig = {
    environment,
    openRouterBaseUrl: url('OPENROUTER_BASE_URL', 'https://openrouter.ai/api/v1') ?? 'https://openrouter.ai/api/v1',
    openRouterKey: openRouterKey ?? '',
    githubBaseUrl: url('GITHUB_BASE_URL', 'https://github.com') ?? 'https://github.com',
    githubApiBaseUrl: url('GITHUB_API_BASE_URL', 'https://api.github.com') ?? 'https://api.github.com',
    githubClientId,
    appUrl: url('APP_URL', null),
    appTitle: (text('APP_TITLE') ?? 'eNCode').slice(0, 64),
    secret: secret ?? '',
    previousSecret,
    adminToken: adminRaw,
    alertWebhookUrl: url('ALERT_WEBHOOK_URL', null),
    killSwitch: {
      on: /^(1|true|on|yes)$/i.test(text('KILL_SWITCH') ?? ''),
      message: (text('KILL_SWITCH_MESSAGE') ?? DEFAULT_KILL_MESSAGE).slice(0, 280),
    },
    minClientVersion,
    signup: {
      mode: mode as SignupMode,
      allowedLogins: (text('ALLOWED_GITHUB_LOGINS') ?? '')
        .split(',')
        .map((login) => login.trim().toLowerCase())
        .filter(Boolean),
      minAccountAgeDays: integer('MIN_GITHUB_ACCOUNT_AGE_DAYS', 30, 0, 3650),
    },
    tokens: {
      accessTtlSeconds: 3600,
      refreshTtlSeconds: 30 * 86_400,
      sessionMaxSeconds: 180 * 86_400,
      refreshGraceSeconds: 120,
    },
    signIn: { startsPerIpPerHour: 10, pollsPerIpPerMinute: 30, refreshesPerIpPerMinute: 30 },
    user: {
      requestsPerMinute: integer('USER_REQUESTS_PER_MINUTE', 10, 1, 1000),
      requestsPerDay: integer('USER_REQUESTS_PER_DAY', 150, 1, 1_000_000),
      inputTokensPerDay: integer('USER_INPUT_TOKENS_PER_DAY', 8_000_000, 1000, 1_000_000_000),
      outputTokensPerDay: integer('USER_OUTPUT_TOKENS_PER_DAY', 800_000, 1000, 1_000_000_000),
      maxConcurrent: integer('USER_MAX_CONCURRENT', 2, 1, 32),
      refundsPerDay: integer('USER_REFUNDS_PER_DAY', 20, 0, 10_000),
      leaseTtlMs: 10 * MINUTE,
      flaggedScale: 0.25,
      flagActiveHours: 20,
      flagSaturatedMinutes: 30,
    },
    global: {
      requestsPerDay: integer('GLOBAL_REQUESTS_PER_DAY', 950, 1, 10_000_000),
      requestsPerMinute,
      fairShareStart: 0.5,
      fairShareFloor: 0.1,
      maxQueueWaitMs: 8_000,
    },
    upstream: {
      firstEventTimeoutMs: 20_000,
      reasoningFirstEventTimeoutMs: 40_000,
      preStreamBudgetMs: 50_000,
      idleTimeoutMs: 60_000,
      maxDurationMs: 9 * MINUTE,
      maxAttempts: 3,
      fallbackModels: integer('UPSTREAM_FALLBACK_MODELS', 3, 1, 3),
      keepaliveMs: 5_000,
    },
    request: {
      maxBodyBytes: integer('MAX_BODY_BYTES', 4 * 1024 * 1024, 16 * 1024, 32 * 1024 * 1024),
      maxOutputTokens,
      defaultOutputTokens,
      maxMessages: 4096,
      maxTools: 128,
    },
    alerts: { quotaFraction: 0.8, modelErrorRate: 0.1, minSamples: 20 },
    dataPolicy: DATA_POLICY,
  }

  return problems.length ? { ok: false, problems } : { ok: true, config }
}
