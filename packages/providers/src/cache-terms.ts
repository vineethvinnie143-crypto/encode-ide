/**
 * What a provider's prompt cache charges for a model, as shares of its normal input price (ADR 0130). The agent's
 * compaction decides from these whether rewriting the prompt pays: a cached token costs from 2% of an uncached one to
 * all of it, and writing one costs from nothing more to a quarter more.
 */
import type { ModelFamily } from './messages'

export interface CacheTerms {
  /** A token read from the cache, over an uncached one: 0.1 for Claude, 1 where nothing is cached. */
  read: number
  /** A token written to the cache, over an uncached one: 1.25 for Claude's five-minute cache, 1 where writing costs nothing more. */
  write: number
  /** The model reasons, and its provider refuses that reasoning after a prompt it was not written under (Claude, Gemini). */
  boundThinking: boolean
  /** How long a cached prompt lasts unread, where the provider says. */
  ttlMs?: number
  /** Where the shares came from: the model's price list, or what its family's providers usually charge. */
  source: 'price' | 'family'
}

/** Claude's prompt cache lasts five minutes unless a request asks for the hour (ADR 0128). */
export const CLAUDE_CACHE_TTL_MS = 5 * 60_000

/** What each family's providers usually charge for a cached token, and for writing one. Unknown hosts: half. */
const FAMILY: Record<ModelFamily, { read: number; write: number }> = {
  anthropic: { read: 0.1, write: 1.25 },
  openai: { read: 0.25, write: 1 },
  google: { read: 0.25, write: 1 },
  deepseek: { read: 0.1, write: 1 },
  qwen: { read: 0.2, write: 1 },
  moonshot: { read: 0.25, write: 1 },
  zhipu: { read: 0.2, write: 1 },
  xai: { read: 0.25, write: 1 },
  minimax: { read: 0.1, write: 1 },
  mistral: { read: 0.5, write: 1 },
  meta: { read: 0.5, write: 1 },
  other: { read: 0.5, write: 1 },
}

/** Families whose reasoning a provider checks against the prompt it was written under: Claude's signatures, Gemini's thought signatures. */
export const BINDS_THINKING: ReadonlySet<ModelFamily> = new Set(['anthropic', 'google'])

export interface CachePrice {
  /** USD per million uncached input tokens. */
  input: number
  /** USD per million tokens read from the cache; absent when the price list names none. */
  cacheRead?: number
  /** USD per million tokens written to it; absent when writing costs nothing more. */
  cacheWrite?: number
}

/** A share, clamped and rounded off float noise (0.3 / 3 is 0.09999999999999999). */
const share = (value: number, min: number, max: number) => Math.round(Math.min(max, Math.max(min, value)) * 10_000) / 10_000

/**
 * The terms for a model. A price list that names an input price speaks for itself: no cache price in it means nothing
 * is discounted. Without one (a free model, a direct provider, an OpenRouter preset) the family's usual terms stand.
 */
export function cacheTermsOf(model: { family: ModelFamily; reasoning: boolean; price?: CachePrice }): CacheTerms {
  const { family, price } = model
  const boundThinking = model.reasoning && BINDS_THINKING.has(family)
  const ttl = family === 'anthropic' ? { ttlMs: CLAUDE_CACHE_TTL_MS } : {}
  if (price && Number.isFinite(price.input) && price.input > 0) {
    const read = price.cacheRead !== undefined && Number.isFinite(price.cacheRead) ? share(price.cacheRead / price.input, 0, 1) : 1
    const write = price.cacheWrite !== undefined && Number.isFinite(price.cacheWrite) ? share(price.cacheWrite / price.input, 1, 4) : 1
    return { read, write, boundThinking, ...ttl, source: 'price' }
  }
  return { ...FAMILY[family], boundThinking, ...ttl, source: 'family' }
}
