import { ANTHROPIC_VERSION } from '@encode/providers'
import type { ProviderConfig } from './config'
import type { Fetch } from './openrouter'
import { defaultModel, type CatalogEntry } from './registry'

/**
 * A provider's GET /models list, from a key-holding provider (BYOK) or from
 * eNCode's gateway. Most servers list only ids; some add limits and
 * capabilities under various names (vLLM's max_model_len, the gateway's
 * context_length, supports_tools and roles), and those win over the model
 * table's defaults. Anthropic's list has the same shape with its own headers.
 */

function positiveInt(...values: unknown[]): number | undefined {
  for (const value of values) if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value)
  return undefined
}

function flag(...values: unknown[]): boolean | undefined {
  for (const value of values) if (typeof value === 'boolean') return value
  return undefined
}

const MODEL_ID = /^[\x21-\x7e]{1,256}$/

export function parseModelList(json: unknown, provider: Pick<ProviderConfig, 'type' | 'baseUrl'>): CatalogEntry[] {
  const data = (json as { data?: unknown; models?: unknown } | null)?.data ?? (json as { models?: unknown } | null)?.models
  if (!Array.isArray(data)) return []
  const out: CatalogEntry[] = []
  const seen = new Set<string>()
  for (const raw of data) {
    if (!raw || typeof raw !== 'object') continue
    const m = raw as Record<string, unknown>
    const id = typeof m.id === 'string' ? m.id.trim() : ''
    if (!MODEL_ID.test(id) || seen.has(id)) continue
    seen.add(id)
    const base = defaultModel(provider, id)
    const capabilities = (m.capabilities ?? {}) as Record<string, unknown>
    const top = (m.top_provider ?? {}) as Record<string, unknown>
    const contextWindow = positiveInt(m.context_length, m.context_window, m.max_context_length, m.max_model_len, top.context_length, m.max_input_tokens) ?? base.contextWindow
    const maxOutputTokens = Math.min(positiveInt(m.max_output_tokens, m.max_completion_tokens, top.max_completion_tokens) ?? base.maxOutputTokens, contextWindow)
    const tools = flag(m.supports_tools, capabilities.tools, capabilities.function_calling) ?? base.capabilities.tools
    const name = [m.name, m.display_name].find((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    const created = typeof m.created === 'number' && m.created > 0 ? m.created * 1000 : typeof m.created_at === 'string' ? Date.parse(m.created_at) : Number.NaN
    out.push({
      ...base,
      name: name ? name.trim().slice(0, 200) : id,
      contextWindow,
      maxOutputTokens,
      capabilities: {
        ...base.capabilities,
        tools,
        parallelTools: flag(m.supports_parallel_tools, capabilities.parallel_tool_calls) ?? tools,
        images: flag(m.supports_images, m.supports_vision, capabilities.vision) ?? base.capabilities.images,
        reasoning: flag(m.supports_reasoning, capabilities.reasoning) ?? base.capabilities.reasoning,
      },
      created: Number.isFinite(created) ? created : undefined,
      roles: Array.isArray(m.roles) ? m.roles.filter((role): role is string => typeof role === 'string').slice(0, 20) : undefined,
    })
  }
  return out
}

/** Where a provider lists its models: Anthropic's root takes /v1 like its messages endpoint does. */
export function modelListUrl(provider: Pick<ProviderConfig, 'type' | 'baseUrl'>): string {
  const base = provider.baseUrl.replace(/\/+$/, '')
  if (provider.type !== 'anthropic') return `${base}/models`
  return `${/\/v1$/.test(base) ? base : `${base}/v1`}/models?limit=1000`
}

/** Fetches a provider's model list with its key. */
export async function fetchModelList(options: {
  fetch: Fetch
  provider: Pick<ProviderConfig, 'type' | 'baseUrl'>
  apiKey?: string
  signal?: AbortSignal
}): Promise<CatalogEntry[]> {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (options.provider.type === 'anthropic') {
    headers['anthropic-version'] = ANTHROPIC_VERSION
    if (options.apiKey) headers['x-api-key'] = options.apiKey
  } else if (options.apiKey) {
    headers.authorization = `Bearer ${options.apiKey}`
  }
  const response = await options.fetch(modelListUrl(options.provider), { headers, signal: options.signal })
  if (!response.ok) throw new Error(`The model list answered HTTP ${response.status}.`)
  return parseModelList(await response.json(), options.provider)
}
