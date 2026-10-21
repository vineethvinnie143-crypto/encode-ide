import { VIRTUAL_MODEL_IDS, VirtualModels, type VirtualModelId } from '@encode/gateway-protocol'
import { isFreeModelId } from './firewall'

/**
 * The free pool: which real `:free` models stand behind each virtual model.
 * It is rebuilt from OpenRouter's catalog on a schedule, never hard-coded, and
 * admins can pin, block or lock it down to approved models only.
 */

export interface CatalogModel {
  id: string
  name: string
  /** Seconds since the epoch the model was listed; newer free models tend to be stronger. */
  created: number
  context: number
  maxOutput: number
  tools: boolean
  images: boolean
  reasoning: boolean
}

export interface PoolOverrides {
  /** Never used, whatever the catalog says. */
  block?: string[]
  /** Tried first, in this order, for each virtual model. */
  pin?: Partial<Record<VirtualModelId, string[]>>
  /** When true, only `approved` models are used: for when evals vet every model first. */
  approvedOnly?: boolean
  approved?: string[]
}

export interface PoolDocument {
  v: 1
  updatedAt: number
  models: CatalogModel[]
  pools: Record<VirtualModelId, string[]>
}

interface PoolRule {
  requireTools: boolean
  minContext: number
  /** capability: largest context first; latency: fastest observed first. */
  order: 'capability' | 'latency'
}

export const POOL_RULES: Readonly<Record<VirtualModelId, PoolRule>> = {
  [VirtualModels.main]: { requireTools: true, minContext: 32_768, order: 'capability' },
  [VirtualModels.fast]: { requireTools: false, minContext: 16_384, order: 'latency' },
}

function zero(value: unknown): boolean {
  if (typeof value !== 'number' && typeof value !== 'string') return false
  const number = typeof value === 'number' ? value : value.trim() === '' ? Number.NaN : Number(value)
  return number === 0
}

/** Prompt and completion prices must be listed and zero; any other price listed must be zero too. */
function freePricing(pricing: unknown): boolean {
  if (!pricing || typeof pricing !== 'object' || Array.isArray(pricing)) return false
  const prices = pricing as Record<string, unknown>
  return zero(prices.prompt) && zero(prices.completion) && Object.values(prices).every((value) => value === null || zero(value))
}

/**
 * The free, routable models in an OpenRouter `/api/v1/models` response. A
 * model counts as free only when its id ends in `:free` and every price it
 * lists is zero, so a mislabeled entry cannot cost money.
 */
export function parseCatalog(json: unknown): CatalogModel[] {
  const data = (json as { data?: unknown })?.data
  if (!Array.isArray(data)) return []
  const out: CatalogModel[] = []
  for (const entry of data) {
    if (!entry || typeof entry !== 'object') continue
    const model = entry as Record<string, unknown>
    if (!isFreeModelId(model.id) || !freePricing(model.pricing)) continue
    const parameters = Array.isArray(model.supported_parameters) ? model.supported_parameters.map(String) : []
    const architecture = (model.architecture ?? {}) as Record<string, unknown>
    const inputs = Array.isArray(architecture.input_modalities) ? architecture.input_modalities.map(String) : []
    const top = (model.top_provider ?? {}) as Record<string, unknown>
    const context = Number(model.context_length ?? top.context_length ?? 0)
    if (!Number.isFinite(context) || context <= 0) continue
    const maxOutput = Number(top.max_completion_tokens ?? 0)
    out.push({
      id: model.id,
      name: typeof model.name === 'string' ? model.name.slice(0, 120) : model.id,
      created: Number.isFinite(Number(model.created)) ? Number(model.created) : 0,
      context: Math.floor(context),
      maxOutput: Number.isFinite(maxOutput) && maxOutput > 0 ? Math.floor(maxOutput) : Math.floor(context / 4),
      tools: parameters.includes('tools'),
      images: inputs.includes('image'),
      reasoning: parameters.includes('reasoning') || parameters.includes('include_reasoning'),
    })
  }
  return out
}

/** Each virtual model's candidates, best first. `latencyMs` is the observed median time to first token, when known. */
export function buildPools(
  models: readonly CatalogModel[],
  overrides: PoolOverrides = {},
  latencyMs: Readonly<Record<string, number>> = {},
): Record<VirtualModelId, string[]> {
  const blocked = new Set(overrides.block ?? [])
  const approved = new Set(overrides.approved ?? [])
  const usable = models.filter((model) => !blocked.has(model.id) && (!overrides.approvedOnly || approved.has(model.id)))
  const pools = {} as Record<VirtualModelId, string[]>
  for (const id of VIRTUAL_MODEL_IDS) {
    const rule = POOL_RULES[id]
    const eligible = usable.filter((model) => model.context >= rule.minContext && (!rule.requireTools || model.tools))
    const unknownLatency = 4_000
    eligible.sort((a, b) => {
      if (rule.order === 'latency') {
        const difference = (latencyMs[a.id] ?? unknownLatency) - (latencyMs[b.id] ?? unknownLatency)
        if (difference) return difference
      } else if (b.context !== a.context) {
        return b.context - a.context
      }
      return b.created - a.created || a.id.localeCompare(b.id)
    })
    const ranked = eligible.map((model) => model.id)
    const pins = (overrides.pin?.[id] ?? []).filter((pinned) => ranked.includes(pinned))
    pools[id] = [...new Set([...pins, ...ranked])]
  }
  return pools
}

export interface CandidateNeeds {
  tools: boolean
  images: boolean
  /** Estimated prompt tokens plus the output budget. */
  contextTokens: number
}

/**
 * Up to `count` models to try next, in pool order: ones already tried in this
 * request and ones that cannot serve it are skipped, and cooling models go
 * last. If every fitting model is cooling, the one that recovers soonest is
 * still offered, so a pool-wide blip slows requests down instead of failing them.
 */
export function pickCandidates(
  doc: PoolDocument,
  virtualModel: VirtualModelId,
  needs: CandidateNeeds,
  tried: ReadonlySet<string>,
  coolingUntil: Readonly<Record<string, number>>,
  now: number,
  count: number,
): string[] {
  const byId = new Map(doc.models.map((model) => [model.id, model]))
  const fitting = (doc.pools[virtualModel] ?? []).filter((id) => {
    const model = byId.get(id)
    if (!model || tried.has(id)) return false
    if (needs.tools && !model.tools) return false
    if (needs.images && !model.images) return false
    return model.context >= needs.contextTokens
  })
  const healthy = fitting.filter((id) => (coolingUntil[id] ?? 0) <= now)
  if (healthy.length) return healthy.slice(0, count)
  const soonest = [...fitting].sort((a, b) => (coolingUntil[a] ?? 0) - (coolingUntil[b] ?? 0))
  return soonest.slice(0, 1)
}

export function describeModel(doc: PoolDocument, id: string): CatalogModel | undefined {
  return doc.models.find((model) => model.id === id)
}
