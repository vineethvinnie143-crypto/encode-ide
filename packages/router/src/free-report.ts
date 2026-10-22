import type { Clock } from './clock'
import { defaultRouterConfig, OPENROUTER_BASE_URL, type FreePoolConfig } from './config'
import { HealthTracker } from './health'
import { freeVerdict, parseOpenRouterCatalog } from './openrouter'
import { FreePool } from './pool'
import { ModelRegistry, type CatalogEntry } from './registry'

/**
 * A way to check, with your own eyes, that the free pool costs nothing: which
 * models `@free` would try first, with every price OpenRouter lists for each
 * as the response wrote it, and a second reading of the response that must
 * agree with the first. The classification is code; this shows its working.
 */

export interface FreePick {
  rank: number
  model: string
  name: string
  contextWindow: number
  tools: boolean
  /** Every price OpenRouter lists for the model, as written. */
  pricing: Record<string, string>
}

export interface FreeReport {
  /** Models the catalog lists, and how many of them count as free. */
  listed: number
  free: number
  /** What `@free` would try for the role, best first. */
  picks: FreePick[]
  /** Free models the pool does not offer, and why: too small a window, retired, excluded in settings. */
  notInPool: Array<{ model: string; reason: string }>
  /** Models that look free (a :free id, or zero prompt and completion prices) but are not provably so, and why. */
  leftOut: Array<{ model: string; reasons: string[] }>
  /** Everything that contradicts "every free model costs nothing". Empty when the check holds. */
  problems: string[]
}

type Pricing = Record<string, unknown>

/** Each listed model's pricing, straight from the response. */
function rawPricing(json: unknown): Map<string, Pricing> {
  const data = (json as { data?: unknown } | null)?.data
  const out = new Map<string, Pricing>()
  if (!Array.isArray(data)) return out
  for (const item of data) {
    if (!item || typeof item !== 'object') continue
    const { id, pricing } = item as { id?: unknown; pricing?: unknown }
    if (typeof id !== 'string') continue
    out.set(id.trim(), pricing && typeof pricing === 'object' && !Array.isArray(pricing) ? (pricing as Pricing) : {})
  }
  return out
}

function written(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value)
  return text.length > 40 ? `${text.slice(0, 40)}…` : text
}

/**
 * Checks every entry the registry would call free against the response it
 * came from, price by price. Returns what contradicts it: an entry marked
 * free that the response prices, or that the response does not mention.
 */
export function auditFreeEntries(entries: readonly Pick<CatalogEntry, 'model' | 'free' | 'price'>[], json: unknown): string[] {
  const raw = rawPricing(json)
  const problems: string[] = []
  for (const entry of entries) {
    if (!entry.free) continue
    const pricing = raw.get(entry.model)
    if (!pricing) {
      problems.push(`${entry.model} counts as free, but the response lists no prices for it.`)
      continue
    }
    const verdict = freeVerdict(entry.model, pricing)
    if (!verdict.free) problems.push(`${entry.model} counts as free, but ${verdict.reasons.join(', and ')}.`)
    else if (entry.price.input !== 0 || entry.price.output !== 0) problems.push(`${entry.model} counts as free, but eNCode holds a price of $${entry.price.input} in and $${entry.price.output} out per million tokens for it.`)
  }
  return problems
}

export interface FreeReportOptions {
  /** The role to rank the pool for. Default `main`. */
  role?: string
  /** How many picks to list. Default 10. */
  limit?: number
  freePool?: FreePoolConfig
  /** Epoch ms, for ranking by age. Default: now. */
  now?: number
}

/** The free models `@free` would try, from a saved or fresh OpenRouter /models response, with the evidence that each is free. */
export function freeReport(json: unknown, options: FreeReportOptions = {}): FreeReport {
  const now = options.now ?? Date.now()
  const role = options.role ?? 'main'
  const freePool = options.freePool ?? defaultRouterConfig().freePool
  const clock: Clock = { now: () => now, setTimeout: () => undefined, clearTimeout: () => undefined }

  const entries = parseOpenRouterCatalog(json)
  const registry = new ModelRegistry()
  registry.setProviders({ openrouter: { type: 'openrouter', baseUrl: OPENROUTER_BASE_URL, free: false } })
  registry.setCatalog('openrouter', entries, now)
  const pool = new FreePool(registry, new HealthTracker(clock), clock)
  const raw = rawPricing(json)

  const members = pool.members('openrouter', role, freePool)
  const picks = members
    .slice(0, Math.max(0, options.limit ?? 10))
    .map((info, index): FreePick => ({
      rank: index + 1,
      model: info.model,
      name: info.name,
      contextWindow: info.contextWindow,
      tools: info.capabilities.tools,
      pricing: Object.fromEntries(Object.entries(raw.get(info.model) ?? {}).map(([name, value]) => [name, written(value)])),
    }))

  const zero = (value: unknown) => typeof value === 'string' && value.trim() !== '' && Number(value) === 0
  const leftOut = [...raw]
    .filter(([model, pricing]) => (model.endsWith(':free') || (zero(pricing.prompt) && zero(pricing.completion))) && !freeVerdict(model, pricing).free)
    .map(([model, pricing]) => ({ model, reasons: freeVerdict(model, pricing).reasons }))

  const notInPool = registry
    .list('openrouter')
    .filter((info) => info.free)
    .flatMap((info) => {
      const reason = pool.exclusion(info, freePool)
      return reason ? [{ model: info.model, reason }] : []
    })

  const free = entries.filter((entry) => entry.free).length
  const problems = auditFreeEntries(entries, json)
  if (!entries.length) problems.push('The response lists no usable models.')
  else if (!free) problems.push('No model in the response counts as free, so the free pool would be empty.')
  else if (!members.length) problems.push('Free models are listed, but the pool offers none of them.')
  return { listed: entries.length, free, picks, notInPool, leftOut, problems }
}
