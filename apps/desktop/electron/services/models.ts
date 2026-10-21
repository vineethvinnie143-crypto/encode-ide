import type { ModelInfo } from '../../shared/types'
import type { SettingsService } from './settings'

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1'
const CACHE_MS = 10 * 60 * 1000

function normalizeBase(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '')
}

export class ModelsService {
  private cache: { at: number; models: ModelInfo[] } | null = null

  constructor(private readonly settings: SettingsService) {}

  async openRouter(freeOnly = false): Promise<ModelInfo[]> {
    const models = await this.fetchOpenRouter()
    return freeOnly ? models.filter((m) => m.free) : models
  }

  private async fetchOpenRouter(): Promise<ModelInfo[]> {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.models

    const res = await fetch(`${OPENROUTER_BASE}/models`, {
      headers: { 'HTTP-Referer': 'https://eNCode.local', 'X-Title': 'eNCode IDE' },
    })
    if (!res.ok) throw new Error(`OpenRouter model catalog responded ${res.status}`)

    const json = (await res.json()) as { data?: Array<Record<string, unknown>> }
    const models: ModelInfo[] = (json.data ?? []).map((m) => {
      const id = String(m.id ?? '')
      const pricing = (m.pricing ?? {}) as Record<string, unknown>
      const promptPrice = Number(pricing.prompt ?? 0)
      const completionPrice = Number(pricing.completion ?? 0)
      const free = id.endsWith(':free') || (promptPrice === 0 && completionPrice === 0)
      const priceLabel = free
        ? 'free'
        : `$${promptPrice.toFixed(2)} in · $${completionPrice.toFixed(2)} out / 1M tok`
      return {
        id,
        name: String(m.name ?? id),
        contextLength: typeof m.context_length === 'number' ? (m.context_length as number) : undefined,
        free,
        pricing: priceLabel,
      }
    })

    models.sort((a, b) => Number(Boolean(b.free)) - Number(Boolean(a.free)) || a.name.localeCompare(b.name))
    this.cache = { at: Date.now(), models }
    return models
  }

  async provider(profileId: string): Promise<ModelInfo[]> {
    const profile = this.settings.raw().profiles.find((p) => p.id === profileId)
    if (!profile) throw new Error('Unknown model profile')

    if (profile.kind === 'openrouter') {
      return this.fetchOpenRouter()
    }
    if (profile.kind === 'demo') {
      return [{ id: 'eNCode-demo', name: 'eNCode demo agent (offline)', free: true }]
    }
    if (!profile.baseUrl) throw new Error('This profile has no base URL yet')

    const key = this.settings.keyFor(profile.id)
    const res = await fetch(`${normalizeBase(profile.baseUrl)}/models`, {
      headers: key ? { authorization: `Bearer ${key}` } : {},
    })
    if (!res.ok) throw new Error(`Provider responded ${res.status} ${res.statusText}`)
    const json = (await res.json()) as { data?: Array<Record<string, unknown>> }
    return (json.data ?? [])
      .map((m) => ({ id: String(m.id ?? ''), name: String(m.name ?? m.id ?? '') }))
      .filter((m) => Boolean(m.id))
      .sort((a, b) => a.id.localeCompare(b.id))
  }

  async test(profileId: string): Promise<{ ok: boolean; message: string }> {
    const profile = this.settings.raw().profiles.find((p) => p.id === profileId)
    if (!profile) return { ok: false, message: 'Unknown model profile' }
    if (profile.kind === 'demo') return { ok: true, message: 'Offline demo model is always available.' }
    if (profile.kind === 'openrouter') {
      try {
        const models = await this.fetchOpenRouter()
        return { ok: true, message: `Connected to OpenRouter · ${models.length} models, ${models.filter((m) => m.free).length} free` }
      } catch (err) {
        return { ok: false, message: (err as Error).message }
      }
    }
    if (!profile.baseUrl) return { ok: false, message: 'Set a base URL first.' }
    if (!profile.model) return { ok: false, message: 'Set a model id first.' }
    try {
      const models = await this.provider(profileId)
      return {
        ok: true,
        message: models.length ? `Connected · ${models.length} models available` : 'Connected (model list unavailable)',
      }
    } catch (err) {
      return { ok: false, message: (err as Error).message }
    }
  }
}
