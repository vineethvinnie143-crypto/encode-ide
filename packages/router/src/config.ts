import type { ModelFamily, ProviderType } from '@encode/providers'
import { FREE_POOL, parseModelRef, PROVIDER_ID } from './refs'

/**
 * The router's settings: which providers exist, which models each role uses,
 * and the limits failover works within. They come from the user's settings
 * file, so parseRouterConfig treats them as untrusted: anything invalid is
 * dropped with a problem the settings UI can show, and the rest still works.
 *
 *   {
 *     "providers": { "openrouter": { "type": "openrouter" }, "anthropic": { "type": "anthropic" } },
 *     "freeOnly":  false,
 *     "roles":     { "main": ["openrouter:qwen/qwen3-coder", "@free"], "utility": ["@free"] },
 *     "tools":     { "WebFetch": { "role": "utility" } },
 *     "agents":    { "security-review": { "role": "reviewer" } }
 *   }
 */

export const PROVIDER_TYPES: readonly ProviderType[] = ['openai-compatible', 'openrouter', 'anthropic']

export const MODEL_FAMILIES: readonly ModelFamily[] = ['anthropic', 'openai', 'google', 'deepseek', 'qwen', 'moonshot', 'zhipu', 'mistral', 'meta', 'xai', 'other']

export interface ProviderConfig {
  id: string
  /** Which adapter speaks to it. An OpenAI-compatible provider at openrouter.ai becomes `openrouter`. */
  type: ProviderType
  /** Endpoint root without a trailing slash, e.g. https://openrouter.ai/api/v1. */
  baseUrl: string
  /** Whether requests need a key. Off by default only for servers on this machine. */
  needsKey: boolean
  /** Every model of this provider costs the user nothing (eNCode's gateway). Such providers can serve `@free`. */
  free: boolean
}

export type EditFormat = 'replace' | 'patch'

/** What the user knows better than the catalog, per model. */
export interface ModelOverride {
  name?: string
  family?: ModelFamily
  contextWindow?: number
  maxOutputTokens?: number
  tools?: boolean
  parallelTools?: boolean
  images?: boolean
  /** Reads PDFs as documents. */
  documents?: boolean
  /** Emits reasoning, so its first token may come late. */
  reasoning?: boolean
  /** Takes explicit prompt-cache breakpoints. */
  promptCache?: boolean
  editFormat?: EditFormat
}

/** Where a tool or a subagent sends its model calls: another role, or its own model list. */
export interface Assignment {
  role?: string
  models?: string[]
}

export interface RouterLimits {
  /** Models switched to after failures, before the request pauses. */
  maxFailovers: number
  /** Time spent failing, from the first failure, before the request pauses. */
  maxFailoverMs: number
  /** Attempts per request whatever they cost, so nothing can loop forever. */
  maxAttempts: number
  /** No first token in this time aborts the attempt. */
  firstTokenMs: number
  /** The same for models that reason before they answer. */
  reasoningFirstTokenMs: number
  /** The same for servers on this machine, which may first have to load the model. */
  localFirstTokenMs: number
  /** How long keepalives can hold the first token off: each one buys time, up to this from the start. */
  keepaliveFirstTokenMs: number
  /** Silence this long after the first token aborts the attempt. */
  idleMs: number
  /** How long keepalives alone can keep a started reply alive, counted from its last content. */
  keepaliveIdleMs: number
  /** First cooldown after a failure; it doubles with each further failure. */
  cooldownMs: number
  maxCooldownMs: number
}

export interface FreePoolConfig {
  /** Providers whose free models form `@free`, in order of preference. Default: OpenRouter and free providers. */
  providers: string[]
  /** OpenRouter allows 20 free requests a minute per account; pacing keeps under it. */
  requestsPerMinute: number
  /** Further free models OpenRouter may try server-side before the first byte (its `models` parameter). */
  serverFallbacks: number
  /** OpenRouter's `provider.data_collection`: `deny` keeps prompts away from endpoints that train on them. */
  dataCollection: 'allow' | 'deny'
  /** Model ids never used; `*` matches any run of characters. */
  exclude: string[]
  /** Free models with a smaller window are left out of the pool. */
  minContextWindow: number
  /** A wait for a free request slot up to this long beats moving on to the next tier. */
  maxPacingWaitMs: number
}

export interface RouterConfig {
  providers: Record<string, ProviderConfig>
  /** Role name → ordered model refs; each later entry is the fallback for the ones before it. */
  roles: Record<string, string[]>
  tools: Record<string, Assignment>
  agents: Record<string, Assignment>
  models: Record<string, ModelOverride>
  /**
   * Only free models may take a call. A model that is not free is never sent
   * a request, whatever a role lists and however far failover goes, so nothing
   * can be billed. What counts as free is the registry's call: on OpenRouter a
   * `:free` id with every price at zero, on a provider marked `free` all models.
   */
  freeOnly: boolean
  freePool: FreePoolConfig
  limits: RouterLimits
}

export interface ConfigProblem {
  /** Where in the settings, e.g. `roles.main[1]`. */
  path: string
  message: string
}

export const BUILT_IN_ROLES = ['main', 'explore', 'planner', 'reviewer', 'summarizer', 'utility'] as const

/** A role left unconfigured uses the list of the role it falls back to; `main` ends every chain. */
export const ROLE_FALLBACK: Readonly<Record<string, string>> = {
  explore: 'main',
  planner: 'main',
  reviewer: 'main',
  summarizer: 'utility',
  utility: 'main',
}

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'
const ANTHROPIC_BASE_URL = 'https://api.anthropic.com'

export const DEFAULT_LIMITS: Readonly<RouterLimits> = {
  maxFailovers: 3,
  maxFailoverMs: 90_000,
  maxAttempts: 12,
  firstTokenMs: 20_000,
  reasoningFirstTokenMs: 60_000,
  localFirstTokenMs: 180_000,
  keepaliveFirstTokenMs: 120_000,
  idleMs: 60_000,
  keepaliveIdleMs: 300_000,
  cooldownMs: 5_000,
  maxCooldownMs: 15 * 60_000,
}

const DEFAULT_FREE_POOL: Readonly<Omit<FreePoolConfig, 'providers'>> = {
  requestsPerMinute: 20,
  serverFallbacks: 2,
  dataCollection: 'allow',
  exclude: [],
  minContextWindow: 16_000,
  maxPacingWaitMs: 15_000,
}

/** With no providers configured, OpenRouter is assumed, so `@free` works as soon as its key exists. */
export const DEFAULT_PROVIDERS: Readonly<Record<string, ProviderConfig>> = {
  openrouter: { id: 'openrouter', type: 'openrouter', baseUrl: OPENROUTER_BASE_URL, needsKey: true, free: false },
}

// ------------------------------------------------------------------ helpers

type Json = Record<string, unknown>

function isObject(value: unknown): value is Json {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** Own enumerable entries, never anything inherited or a prototype-polluting key. */
function entries(value: Json): Array<[string, unknown]> {
  return Object.keys(value)
    .filter((key) => key !== '__proto__' && key !== 'constructor' && key !== 'prototype')
    .map((key) => [key, value[key]])
}

/** A record without a prototype, so a key such as `toString` is just a key. */
function record<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return LOOPBACK_HOSTS.has(host) || host.endsWith('.localhost') || /^127\.\d+\.\d+\.\d+$/.test(host)
  } catch {
    return false
  }
}

/**
 * An endpoint root eNCode may send keys to: https anywhere, plain http only to
 * this machine, no credentials, query or fragment. Returns it without a
 * trailing slash, or a reason it is refused.
 */
export function normalizeBaseUrl(text: string): { url: string } | { error: string } {
  let url: URL
  try {
    url = new URL(text.trim())
  } catch {
    return { error: 'is not a URL' }
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { error: 'must start with https://' }
  if (url.protocol === 'http:' && !isLoopbackUrl(url.href)) {
    return { error: 'must use https:// unless the server runs on this machine' }
  }
  if (url.username || url.password) return { error: 'must not contain a user name or password; keys go in the keychain' }
  if (url.search || url.hash) return { error: 'must not have a query or fragment' }
  return { url: `${url.origin}${url.pathname}`.replace(/\/+$/, '') }
}

function clampNumber(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
  path: string,
  problems: ConfigProblem[],
): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    problems.push({ path, message: 'must be a number' })
    return fallback
  }
  if (value < min || value > max) {
    problems.push({ path, message: `must be between ${min} and ${max}` })
    return Math.min(max, Math.max(min, value))
  }
  return Math.round(value)
}

function bool(value: unknown, fallback: boolean, path: string, problems: ConfigProblem[]): boolean {
  if (value === undefined) return fallback
  if (typeof value === 'boolean') return value
  problems.push({ path, message: 'must be true or false' })
  return fallback
}

/**
 * The free-only switch. It guards against spending money, so a value that
 * cannot be read turns it on: the worst that happens is a model is refused,
 * with a message, instead of a charge nobody expected.
 */
function parseFreeOnly(value: unknown, problems: ConfigProblem[]): boolean {
  if (value === undefined) return false
  if (typeof value === 'boolean') return value
  problems.push({ path: 'freeOnly', message: 'must be true or false; free-only mode stays on until it is' })
  return true
}

function stringList(value: unknown, path: string, problems: ConfigProblem[]): string[] {
  if (value === undefined) return []
  const list = typeof value === 'string' ? [value] : value
  if (!Array.isArray(list)) {
    problems.push({ path, message: 'must be a list of strings' })
    return []
  }
  const out: string[] = []
  list.forEach((item, index) => {
    if (typeof item === 'string' && item.trim()) out.push(item.trim())
    else problems.push({ path: `${path}[${index}]`, message: 'must be a non-empty string' })
  })
  return out
}

// ---------------------------------------------------------------- sections

function parseProviders(input: unknown, problems: ConfigProblem[]): Record<string, ProviderConfig> {
  const providers = record<ProviderConfig>()
  if (input === undefined) {
    for (const [id, provider] of Object.entries(DEFAULT_PROVIDERS)) providers[id] = { ...provider }
    return providers
  }
  if (!isObject(input)) {
    problems.push({ path: 'providers', message: 'must be an object of providers by id' })
    return providers
  }
  for (const [id, raw] of entries(input)) {
    const path = `providers.${id}`
    if (!PROVIDER_ID.test(id)) {
      problems.push({ path, message: 'a provider id is a letter followed by letters, digits, - or _' })
      continue
    }
    if (!isObject(raw)) {
      problems.push({ path, message: 'must be an object such as { "type": "openai-compatible", "baseUrl": "…" }' })
      continue
    }
    let type = (typeof raw.type === 'string' ? raw.type.trim() : '') as ProviderType
    if (!PROVIDER_TYPES.includes(type)) {
      problems.push({ path: `${path}.type`, message: `must be one of ${PROVIDER_TYPES.join(', ')}` })
      continue
    }
    const fixedBase = type === 'anthropic' ? ANTHROPIC_BASE_URL : type === 'openrouter' ? OPENROUTER_BASE_URL : ''
    const baseText = typeof raw.baseUrl === 'string' && raw.baseUrl.trim() ? raw.baseUrl : fixedBase
    if (!baseText) {
      problems.push({ path: `${path}.baseUrl`, message: 'is required for this provider type' })
      continue
    }
    const base = normalizeBaseUrl(baseText)
    if ('error' in base) {
      problems.push({ path: `${path}.baseUrl`, message: base.error })
      continue
    }
    // OpenRouter speaks the OpenAI format, but its own adapter adds server-side fallbacks and data policy.
    if (type === 'openai-compatible' && new URL(base.url).hostname.toLowerCase() === 'openrouter.ai') type = 'openrouter'
    providers[id] = {
      id,
      type,
      baseUrl: base.url,
      needsKey: bool(raw.needsKey, !isLoopbackUrl(base.url), `${path}.needsKey`, problems),
      free: bool(raw.free, false, `${path}.free`, problems),
    }
  }
  return providers
}

/** A model list entry that names a configured provider (or `@free`), else null with a problem recorded. */
function checkRef(ref: string, providers: Record<string, ProviderConfig>, path: string, problems: ConfigProblem[]): string | null {
  if (ref === FREE_POOL) return ref
  const parsed = parseModelRef(ref)
  if (!parsed) {
    problems.push({ path, message: `"${ref}" is not "<provider>:<model id>" or "${FREE_POOL}"` })
    return null
  }
  if (!providers[parsed.provider]) {
    problems.push({ path, message: `no provider "${parsed.provider}" is configured` })
    return null
  }
  return `${parsed.provider}:${parsed.model}`
}

function parseRoles(input: unknown, providers: Record<string, ProviderConfig>, problems: ConfigProblem[]): Record<string, string[]> {
  const roles = record<string[]>()
  if (input === undefined) return roles
  if (!isObject(input)) {
    problems.push({ path: 'roles', message: 'must map role names to model lists' })
    return roles
  }
  for (const [role, raw] of entries(input)) {
    const path = `roles.${role}`
    if (!PROVIDER_ID.test(role)) {
      problems.push({ path, message: 'a role name is a letter followed by letters, digits, - or _' })
      continue
    }
    const refs = stringList(raw, path, problems)
      .map((ref, index) => checkRef(ref, providers, `${path}[${index}]`, problems))
      .filter((ref): ref is string => ref !== null)
    const unique = [...new Set(refs)]
    if (unique.length) roles[role] = unique
    else problems.push({ path, message: 'has no usable models, so it falls back to another role' })
  }
  return roles
}

function parseAssignments(
  input: unknown,
  section: 'tools' | 'agents',
  providers: Record<string, ProviderConfig>,
  problems: ConfigProblem[],
): Record<string, Assignment> {
  const out = record<Assignment>()
  if (input === undefined) return out
  if (!isObject(input)) {
    problems.push({ path: section, message: 'must map names to { "role": … } or { "models": […] }' })
    return out
  }
  for (const [name, raw] of entries(input)) {
    const path = `${section}.${name}`
    // Shorthand: a string is a role name, or a single model.
    const value = typeof raw === 'string' ? (parseModelRef(raw) || raw === FREE_POOL ? { models: [raw] } : { role: raw }) : raw
    if (!isObject(value)) {
      problems.push({ path, message: 'must be { "role": "<role>" } or { "models": ["<provider>:<model>"] }' })
      continue
    }
    const assignment: Assignment = {}
    if (value.role !== undefined) {
      if (typeof value.role === 'string' && PROVIDER_ID.test(value.role)) assignment.role = value.role
      else problems.push({ path: `${path}.role`, message: 'must be a role name' })
    }
    const listed = value.models ?? value.model
    if (listed !== undefined) {
      const models = stringList(listed, `${path}.models`, problems)
        .map((ref, index) => checkRef(ref, providers, `${path}.models[${index}]`, problems))
        .filter((ref): ref is string => ref !== null)
      if (models.length) assignment.models = [...new Set(models)]
    }
    if (assignment.role || assignment.models) out[name] = assignment
  }
  return out
}

const EDIT_FORMATS: readonly EditFormat[] = ['replace', 'patch']

function parseModels(input: unknown, providers: Record<string, ProviderConfig>, problems: ConfigProblem[]): Record<string, ModelOverride> {
  const out = record<ModelOverride>()
  if (input === undefined) return out
  if (!isObject(input)) {
    problems.push({ path: 'models', message: 'must map "<provider>:<model>" to model settings' })
    return out
  }
  for (const [ref, raw] of entries(input)) {
    const path = `models.${ref}`
    const key = checkRef(ref, providers, path, problems)
    if (!key || key === FREE_POOL) continue
    if (!isObject(raw)) {
      problems.push({ path, message: 'must be an object such as { "contextWindow": 32000 }' })
      continue
    }
    const override: ModelOverride = {}
    if (raw.name !== undefined) {
      if (typeof raw.name === 'string' && raw.name.trim()) override.name = raw.name.trim().slice(0, 200)
      else problems.push({ path: `${path}.name`, message: 'must be a non-empty string' })
    }
    if (raw.family !== undefined) {
      const family = typeof raw.family === 'string' ? (raw.family.trim().toLowerCase() as ModelFamily) : undefined
      if (family && MODEL_FAMILIES.includes(family)) override.family = family
      else problems.push({ path: `${path}.family`, message: `must be one of ${MODEL_FAMILIES.join(', ')}` })
    }
    if (raw.contextWindow !== undefined) {
      override.contextWindow = clampNumber(raw.contextWindow, 1_000, 20_000_000, 0, `${path}.contextWindow`, problems) || undefined
    }
    if (raw.maxOutputTokens !== undefined) {
      override.maxOutputTokens = clampNumber(raw.maxOutputTokens, 256, 2_000_000, 0, `${path}.maxOutputTokens`, problems) || undefined
    }
    for (const flag of ['tools', 'parallelTools', 'images', 'documents', 'reasoning', 'promptCache'] as const) {
      // An unreadable flag is left out, not read as false: the catalog's answer stands.
      if (typeof raw[flag] === 'boolean') override[flag] = raw[flag] as boolean
      else if (raw[flag] !== undefined) problems.push({ path: `${path}.${flag}`, message: 'must be true or false' })
    }
    if (raw.editFormat !== undefined) {
      if (EDIT_FORMATS.includes(raw.editFormat as EditFormat)) override.editFormat = raw.editFormat as EditFormat
      else problems.push({ path: `${path}.editFormat`, message: `must be one of ${EDIT_FORMATS.join(', ')}` })
    }
    out[key] = override
  }
  return out
}

function parseFreePool(input: unknown, providers: Record<string, ProviderConfig>, problems: ConfigProblem[]): FreePoolConfig {
  const raw = isObject(input) ? input : {}
  if (input !== undefined && !isObject(input)) problems.push({ path: 'freePool', message: 'must be an object' })
  const path = 'freePool'
  let poolProviders: string[]
  if (raw.providers !== undefined) {
    poolProviders = stringList(raw.providers, `${path}.providers`, problems).filter((id, index) => {
      if (providers[id]) return true
      problems.push({ path: `${path}.providers[${index}]`, message: `no provider "${id}" is configured` })
      return false
    })
  } else {
    // The user's own OpenRouter account first, then providers that are free by nature (eNCode's gateway).
    const all = Object.values(providers)
    poolProviders = [...all.filter((provider) => provider.type === 'openrouter'), ...all.filter((provider) => provider.type !== 'openrouter' && provider.free)].map(
      (provider) => provider.id,
    )
  }
  const dataCollection = raw.dataCollection === undefined ? DEFAULT_FREE_POOL.dataCollection : raw.dataCollection
  if (dataCollection !== 'allow' && dataCollection !== 'deny') {
    problems.push({ path: `${path}.dataCollection`, message: 'must be "allow" or "deny"' })
  }
  return {
    providers: [...new Set(poolProviders)],
    requestsPerMinute: clampNumber(raw.requestsPerMinute, 1, 600, DEFAULT_FREE_POOL.requestsPerMinute, `${path}.requestsPerMinute`, problems),
    serverFallbacks: clampNumber(raw.serverFallbacks, 0, 3, DEFAULT_FREE_POOL.serverFallbacks, `${path}.serverFallbacks`, problems),
    dataCollection: dataCollection === 'deny' ? 'deny' : 'allow',
    exclude: stringList(raw.exclude, `${path}.exclude`, problems),
    minContextWindow: clampNumber(raw.minContextWindow, 0, 2_000_000, DEFAULT_FREE_POOL.minContextWindow, `${path}.minContextWindow`, problems),
    maxPacingWaitMs: clampNumber(raw.maxPacingWaitMs, 0, 60_000, DEFAULT_FREE_POOL.maxPacingWaitMs, `${path}.maxPacingWaitMs`, problems),
  }
}

function parseLimits(input: unknown, problems: ConfigProblem[]): RouterLimits {
  const raw = isObject(input) ? input : {}
  if (input !== undefined && !isObject(input)) problems.push({ path: 'limits', message: 'must be an object' })
  const n = (key: keyof RouterLimits, min: number, max: number) =>
    clampNumber(raw[key], min, max, DEFAULT_LIMITS[key], `limits.${key}`, problems)
  const limits: RouterLimits = {
    maxFailovers: n('maxFailovers', 0, 20),
    maxFailoverMs: n('maxFailoverMs', 5_000, 30 * 60_000),
    maxAttempts: n('maxAttempts', 1, 50),
    firstTokenMs: n('firstTokenMs', 1_000, 10 * 60_000),
    reasoningFirstTokenMs: n('reasoningFirstTokenMs', 1_000, 20 * 60_000),
    localFirstTokenMs: n('localFirstTokenMs', 1_000, 30 * 60_000),
    keepaliveFirstTokenMs: n('keepaliveFirstTokenMs', 1_000, 20 * 60_000),
    idleMs: n('idleMs', 1_000, 20 * 60_000),
    keepaliveIdleMs: n('keepaliveIdleMs', 1_000, 60 * 60_000),
    cooldownMs: n('cooldownMs', 1_000, 60 * 60_000),
    maxCooldownMs: n('maxCooldownMs', 1_000, 24 * 60 * 60_000),
  }
  if (limits.maxCooldownMs < limits.cooldownMs) limits.maxCooldownMs = limits.cooldownMs
  return limits
}

/** Reads router settings. Never throws: problems are reported and the valid rest is used. */
export function parseRouterConfig(input: unknown): { config: RouterConfig; problems: ConfigProblem[] } {
  const problems: ConfigProblem[] = []
  const raw = isObject(input) ? input : {}
  if (input !== undefined && input !== null && !isObject(input)) problems.push({ path: '', message: 'router settings must be an object' })
  const providers = parseProviders(raw.providers, problems)
  const config: RouterConfig = {
    providers,
    roles: parseRoles(raw.roles, providers, problems),
    tools: parseAssignments(raw.tools, 'tools', providers, problems),
    agents: parseAssignments(raw.agents, 'agents', providers, problems),
    models: parseModels(raw.models, providers, problems),
    freeOnly: parseFreeOnly(raw.freeOnly, problems),
    freePool: parseFreePool(raw.freePool, providers, problems),
    limits: parseLimits(raw.limits, problems),
  }
  return { config, problems }
}

/** Settings with nothing configured: OpenRouter's free pool for every role. */
export function defaultRouterConfig(): RouterConfig {
  return parseRouterConfig({}).config
}

/**
 * The model list a call uses. A subagent's assignment wins over a tool's,
 * which wins over the role; a role nobody configured follows ROLE_FALLBACK
 * down to `main`, and with nothing configured at all the free pool serves.
 */
export function resolveModelList(config: RouterConfig, request: { role: string; tool?: string; agent?: string }): { role: string; refs: string[] } {
  const assigned = (request.agent !== undefined ? config.agents[request.agent] : undefined) ?? (request.tool !== undefined ? config.tools[request.tool] : undefined)
  if (assigned?.models?.length) return { role: assigned.role ?? request.role, refs: assigned.models }
  const role = assigned?.role ?? request.role
  const seen = new Set<string>()
  const next = (current: string) => (Object.hasOwn(ROLE_FALLBACK, current) ? ROLE_FALLBACK[current] : current === 'main' ? undefined : 'main')
  for (let current: string | undefined = role; current && !seen.has(current); current = next(current)) {
    seen.add(current)
    const refs = config.roles[current]
    if (refs?.length) return { role, refs }
  }
  return { role, refs: [FREE_POOL] }
}
