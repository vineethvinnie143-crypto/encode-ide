/**
 * How much of what a model read came from its provider's prompt cache (ADR 0128). On a provider that caches, almost
 * everything a long conversation sends again is cached, so a low share is money: requests that land on another
 * provider, a prefix that changes, a cache that expired. Settings > Usage and the diagnostics report say it the same way.
 */
import type { SessionUsage, UsageTally } from './types'

/** Below this share of the tokens read, the cache is missing more than it should. */
export const CACHE_LOW = 0.8
/** Calls before the share says anything: the first requests of every conversation write the cache rather than read it. */
export const CACHE_MIN_CALLS = 20

/**
 * `few`: too few calls to judge. `none`: no cached tokens reported at all (a provider that does not cache, or does not
 * say). `low`: under CACHE_LOW. `good`: at or above it.
 */
export type CacheVerdict = 'few' | 'none' | 'low' | 'good'

type Counted = Pick<UsageTally, 'calls' | 'inputTokens' | 'cachedTokens'>

/** The share of the tokens read that came from the cache, 0 to 1; null when nothing was read. */
export function cacheShare(tally: Pick<UsageTally, 'inputTokens' | 'cachedTokens'>): number | null {
  return tally.inputTokens > 0 ? Math.min(1, tally.cachedTokens / tally.inputTokens) : null
}

export function cacheVerdict(tally: Counted): CacheVerdict {
  const share = cacheShare(tally)
  if (share === null || tally.calls < CACHE_MIN_CALLS) return 'few'
  if (tally.cachedTokens === 0) return 'none'
  return share < CACHE_LOW ? 'low' : 'good'
}

/** "97%", or "—" when nothing was read. */
export function cachePercent(tally: Pick<UsageTally, 'inputTokens' | 'cachedTokens'>): string {
  const share = cacheShare(tally)
  return share === null ? '—' : `${Math.floor(share * 100)}%`
}

/** One sentence on a verdict that needs one; null for the others. */
export function cacheAdvice(verdict: CacheVerdict): string | null {
  if (verdict === 'none') return 'No cached tokens were reported: this provider may not cache, or may not say.'
  if (verdict === 'low')
    return `Less than ${CACHE_LOW * 100}% of what was read came from the cache. Requests may be landing on different providers (an OpenRouter preset with a fixed provider order does that), or the conversation is being rewritten often.`
  return null
}

export interface CacheRow extends Counted {
  model: string
  verdict: CacheVerdict
}

/** "2026-10-19": the local day `days - 1` days before `today`, the first of a range of `days` that ends with it. */
export function firstDay(today: Date, days: number): string {
  const first = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days - 1))
  return `${first.getFullYear()}-${String(first.getMonth() + 1).padStart(2, '0')}-${String(first.getDate()).padStart(2, '0')}`
}

/** Each model's calls in the `days` days that end with `today` (this computer's clock), the most read first. */
export function cacheByModel(sessions: readonly SessionUsage[], range: { today: Date; days: number }): CacheRow[] {
  const since = firstDay(range.today, range.days)
  const models = new Map<string, Counted>()
  for (const session of sessions) {
    for (const [day, used] of Object.entries(session.days)) {
      if (day < since) continue
      for (const [model, tally] of Object.entries(used.models)) {
        const into = models.get(model) ?? { calls: 0, inputTokens: 0, cachedTokens: 0 }
        into.calls += tally.calls
        into.inputTokens += tally.inputTokens
        into.cachedTokens += tally.cachedTokens
        models.set(model, into)
      }
    }
  }
  return [...models]
    .map(([model, tally]) => ({ model, ...tally, verdict: cacheVerdict(tally) }))
    .sort((a, b) => b.inputTokens - a.inputTokens || a.model.localeCompare(b.model))
}
