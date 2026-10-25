/**
 * When old tool output is shortened, and how, for the model the next request goes to (ADR 0130).
 *
 * Every step sends the whole prompt again, and shortening an old output makes it smaller from then on. But a provider
 * caches the prompt only up to the first message that changed, so a rewrite sends everything after that point again
 * at the full price, or at the price of writing the cache. Whether that pays depends on the provider's prices, which
 * range from a cached token at 2% of an uncached one to no cache at all. So there are three profiles:
 *
 * - `bound`: the model reasons and its provider refuses that reasoning after a rewrite (Claude, Gemini). Below the
 *   summary's limit, old output is shortened only as a request starts, so the reasoning of the request's tool-call loop
 *   survives, and then in bulk: two steps stay whole, the rest is cut to 800 characters.
 * - `rolling`: a cache, and a rewrite costs only the tail sent again (DeepSeek, OpenAI, Grok, Kimi, Qwen, GLM). A
 *   step's output is shortened soon after it leaves the recent steps, so the rewrite sits near the end and little is
 *   sent again: a command's or a page's output stays whole for one step, what the model finds code by and edits from
 *   (Read, Grep, Glob, LSP) for three. Shortening starts at 16,000 tokens rather than 32,000, and the model's own
 *   reasoning in the current request survives the rewrite.
 * - `uncached`: the price list discounts nothing. The same rolling rule, since every token is paid in full on every
 *   step.
 *
 * Below the limit, a rewrite is made when it pays: the tokens it saves, read from the cache on the next STEPS_AHEAD
 * requests, cost more than the tail sent again does now. Today's rule (a saving of a tenth of the window) still
 * shortens too, so no prompt grows longer than it did. The whole of each output is kept in the session's folder.
 */
import type { CacheTerms } from '@encode/providers'
import { ELIDE_AT, ELIDE_FLOOR, ELIDE_LIMIT } from './compaction'

export type ShorteningProfile = 'bound' | 'rolling' | 'uncached'

/**
 * How many steps of the most recent stay whole: the output of a tool of LOCATING_TOOLS by `reads`, every other by
 * `steps`. `files`: the latest Read of each file in the request being worked on also stays whole, until the file is
 * edited, as the model edits from it.
 */
export interface Recency {
  steps: number
  reads: number
  files?: boolean
}

export interface ShorteningPolicy {
  profile: ShorteningProfile
  recent: Recency
  /** What an old output is cut to, in characters. */
  limit: number
  /** Below the summary's limit, shorten only as a request starts. */
  atRequestStart: boolean
  /** No shortening below this many tokens, or `share` of the window, whichever is more. */
  floor: number
  share: number
  terms: CacheTerms
}

/** A price list whose cached token costs this share of an uncached one or more has, in effect, no cache. */
export const UNCACHED_READ = 0.9
/**
 * How many more requests a shortened prompt is expected to be sent on: as many as the conversation has had steps, as a
 * conversation that has gone on long tends to go on (a Lindy estimate), within these bounds.
 */
export const MIN_STEPS_AHEAD = 4
export const MAX_STEPS_AHEAD = 40

export function stepsAhead(steps: number): number {
  return Math.min(MAX_STEPS_AHEAD, Math.max(MIN_STEPS_AHEAD, Math.floor(steps)))
}
/** A rewrite for less than this changes the prompt the model has been reading for too little. */
export const MIN_SAVING_TOKENS = 1_000
/** Where a rewrite costs little, shortening starts at this size (or ROLLING_AT of the window, whichever is more). */
export const ROLLING_FLOOR = 16_000
export const ROLLING_AT = 0.1
/** What the bound profile cuts an old output to. */
export const BOUND_LIMIT = 800

/** What is assumed when the client cannot tell: a cache, at the price most providers charge. */
const UNKNOWN_TERMS: CacheTerms = { read: 0.1, write: 1, boundThinking: false, source: 'family' }

export function shorteningPolicy(cache: CacheTerms | undefined): ShorteningPolicy {
  const terms = cache ?? UNKNOWN_TERMS
  if (terms.boundThinking) return { profile: 'bound', recent: { steps: 2, reads: 2, files: true }, limit: BOUND_LIMIT, atRequestStart: true, floor: ELIDE_FLOOR, share: ELIDE_AT, terms }
  const rolling = { recent: { steps: 1, reads: 3, files: true }, limit: ELIDE_LIMIT, atRequestStart: false, floor: ROLLING_FLOOR, terms }
  if (terms.read >= UNCACHED_READ) return { profile: 'uncached', ...rolling, share: 0 }
  return { profile: 'rolling', ...rolling, share: ROLLING_AT }
}

/**
 * Whether a rewrite that saves `saved` tokens and sends `tail` tokens again (from the first message it changes to the
 * end) pays over `ahead` more requests. `cold`: the cache has expired, so the whole prompt is sent again anyway and the
 * rewrite costs nothing.
 */
export function rewritePays(saved: number, tail: number, ahead: number, terms: Pick<CacheTerms, 'read' | 'write'>, cold = false): boolean {
  if (saved < MIN_SAVING_TOKENS) return false
  if (cold) return true
  return saved * terms.read * ahead >= tail * Math.max(0, terms.write - terms.read)
}
