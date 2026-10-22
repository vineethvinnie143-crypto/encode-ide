import { providerTypeFor } from '@encode/providers'
import { freeVerdict, modelListUrl, parseModelList } from '@encode/router'
import { addressProblem, isLocalUrl } from '../../shared/models'
import type { ModelInfo, ModelProfile } from '../../shared/types'
import type { SettingsService } from './settings'

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1'
const CACHE_MS = 10 * 60 * 1000
const ANTHROPIC_VERSION = '2023-06-01'

function normalizeBase(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '')
}

/** What the models of one provider are listed with: Anthropic's API wants its own headers, the rest a bearer token. */
function listingHeaders(type: string, key: string): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (!key) return headers
  if (type === 'anthropic') {
    headers['x-api-key'] = key
    headers['anthropic-version'] = ANTHROPIC_VERSION
  } else {
    headers.authorization = `Bearer ${key}`
  }
  return headers
}

/** What went wrong with a request to a provider, in words that say what to do. */
function refusal(name: string, status: number, what: string): string {
  if (status === 401 || status === 403) return `${name} did not accept the key (HTTP ${status}). Copy the whole key again, and check that it belongs to ${name}.`
  if (status === 404) return `${name} has no ${what} at this address (HTTP 404). Check the base URL.`
  if (status === 429) return `${name} is limiting requests right now (HTTP 429). Try again in a minute.`
  if (status >= 500) return `${name} is having trouble (HTTP ${status}). Try again in a moment.`
  return `${name} answered HTTP ${status} when asked for its ${what}.`
}

/** A price per token as OpenRouter writes it, in dollars per million tokens for a person. */
function dollars(perToken: unknown): string {
  const n = Number(perToken)
  return Number.isFinite(n) ? `$${(n * 1_000_000).toFixed(2)}` : '?'
}

export class ModelsService {
  private cache: { at: number; models: ModelInfo[] } | null = null

  constructor(
    private readonly settings: SettingsService,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  /** OpenRouter's models. A model is free when OpenRouter promises it (the router's rule), not when one price reads zero. */
  async openRouter(freeOnly = false): Promise<ModelInfo[]> {
    const models = await this.fetchOpenRouter()
    return freeOnly ? models.filter((m) => m.free) : models
  }

  private async fetchOpenRouter(): Promise<ModelInfo[]> {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.models

    const res = await this.fetchImpl(`${OPENROUTER_BASE}/models`, {
      headers: { 'HTTP-Referer': 'https://eNCode.local', 'X-Title': 'eNCode IDE' },
    })
    if (!res.ok) throw new Error(refusal('OpenRouter', res.status, 'model list'))

    const json = (await res.json()) as { data?: Array<Record<string, unknown>> }
    const models: ModelInfo[] = (json.data ?? []).map((m) => {
      const id = String(m.id ?? '')
      const pricing = (m.pricing ?? {}) as Record<string, unknown>
      const free = freeVerdict(id, pricing).free
      const supported = Array.isArray(m.supported_parameters) ? (m.supported_parameters as unknown[]) : undefined
      return {
        id,
        name: String(m.name ?? id),
        contextLength: typeof m.context_length === 'number' ? (m.context_length as number) : undefined,
        free,
        pricing: free ? 'free' : `${dollars(pricing.prompt)} in · ${dollars(pricing.completion)} out / 1M tok`,
        ...(supported ? { tools: supported.includes('tools') } : {}),
      }
    })

    models.sort((a, b) => Number(Boolean(b.free)) - Number(Boolean(a.free)) || a.name.localeCompare(b.name))
    this.cache = { at: Date.now(), models }
    return models
  }

  private profileOf(profileId: string): ModelProfile | undefined {
    return this.settings.raw().profiles.find((p) => p.id === profileId)
  }

  async provider(profileId: string): Promise<ModelInfo[]> {
    const profile = this.profileOf(profileId)
    if (!profile) throw new Error('Unknown model profile')

    if (profile.kind === 'openrouter') {
      return this.fetchOpenRouter()
    }
    if (profile.kind === 'demo') {
      return [{ id: 'eNCode-demo', name: 'eNCode demo agent (offline)', free: true }]
    }
    if (!profile.baseUrl.trim()) throw new Error('This connection has no base URL yet.')
    // The key is sent with this request: it must not go anywhere the router would not send it.
    const problem = addressProblem(profile.baseUrl)
    if (problem) throw new Error(`${profile.name}: ${problem}`)

    const baseUrl = normalizeBase(profile.baseUrl)
    const provider = { type: providerTypeFor(baseUrl), baseUrl }
    let res: Response
    try {
      res = await this.fetchImpl(modelListUrl(provider), { headers: listingHeaders(provider.type, this.settings.keyFor(profile.id)) })
    } catch (error) {
      throw new Error(`Could not reach ${profile.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!res.ok) throw new Error(refusal(profile.name, res.status, 'model list'))
    const local = isLocalUrl(baseUrl)
    return parseModelList(await res.json(), provider)
      .map((entry): ModelInfo => ({
        id: entry.model,
        name: entry.name,
        // A guessed window would read as a fact here: the listing's own figures are for the router.
        ...(entry.capabilities.tools === false ? { tools: false } : {}),
        ...(local ? { free: true, pricing: 'runs on this computer' } : {}),
      }))
      .sort((a, b) => a.id.localeCompare(b.id))
  }

  /**
   * Whether the connection is reachable and the key accepted. OpenRouter's catalog is public, so a wrong key
   * would pass the listing: its /key endpoint is asked for instead.
   */
  async test(profileId: string): Promise<{ ok: boolean; message: string }> {
    const profile = this.profileOf(profileId)
    if (!profile) return { ok: false, message: 'Unknown model profile' }
    if (profile.kind === 'demo') return { ok: true, message: 'Offline demo model is always available.' }
    if (profile.kind === 'openrouter') {
      try {
        const models = await this.fetchOpenRouter()
        const summary = `${models.length} models, ${models.filter((m) => m.free).length} free`
        const key = this.settings.keyFor(profile.id)
        if (!key) return { ok: false, message: `OpenRouter is reachable (${summary}), but this connection has no key yet.` }
        const res = await this.fetchImpl(`${OPENROUTER_BASE}/key`, {
          headers: { authorization: `Bearer ${key}`, 'HTTP-Referer': 'https://eNCode.local', 'X-Title': 'eNCode IDE' },
        })
        if (!res.ok) return { ok: false, message: refusal('OpenRouter', res.status, 'key information') }
        return { ok: true, message: `OpenRouter accepted the key · ${summary}` }
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) }
      }
    }
    if (!profile.baseUrl.trim()) return { ok: false, message: 'Set a base URL first.' }
    try {
      const models = await this.provider(profileId)
      return {
        ok: true,
        message: models.length ? `Connected · ${models.length} models available` : 'Connected (model list unavailable)',
      }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  }
}
