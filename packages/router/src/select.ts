import type { Requirements } from '@encode/providers'
import type { Clock } from './clock'
import type { ProviderConfig, RouterConfig } from './config'
import type { FreeTier } from './free-tier'
import type { HealthTracker } from './health'
import type { KeySource } from './keys'
import type { FreePool } from './pool'
import { FREE_POOL, parseModelRef } from './refs'
import type { ModelInfo, ModelRegistry } from './registry'

/**
 * Which models may take a call, in the order to try them. A role's list is
 * expanded (`@free` becomes the ranked free pool), then every entry that
 * cannot take this call right now is set aside with the reason: a model that
 * is not free while only free models are enabled, no key, a blocked provider,
 * a cooldown, a closed free tier, missing tools or vision, or a window too
 * small for the prompt plus room to answer. The reasons tell the router
 * whether to wait, compact or pause when nothing is left.
 */

export interface Candidate {
  info: ModelInfo
  provider: ProviderConfig
  /** Came from `@free`. */
  fromPool: boolean
  /** The model's breaker is half-open: this call decides whether it recovered. */
  probe: boolean
  /** Wait this long for a free request slot before sending. */
  delayMs: number
  /** The output budget of this call: the request's, within the model's limit and what the window leaves. */
  maxOutputTokens: number
  /** Further free models OpenRouter may try server-side before the first byte. */
  serverFallbacks: string[]
}

export type SkipReason =
  | 'not-free'
  | 'no-key'
  | 'no-adapter'
  | 'provider-blocked'
  | 'paid-blocked'
  | 'free-closed'
  | 'pacing'
  | 'cooling'
  | 'context'
  | 'tools'
  | 'images'
  | 'expired'
  | 'tried'

export interface Skip {
  key: string
  reason: SkipReason
  message: string
  /** When the reason lifts by itself, epoch ms. */
  until?: number
  /** The model's window, for a context skip. */
  window?: number
}

export interface SelectionContext {
  config: RouterConfig
  registry: ModelRegistry
  health: HealthTracker
  pool: FreePool
  freeTier(provider: string): FreeTier | undefined
  keys: KeySource
  hasAdapter(type: string): boolean
  clock: Clock
}

export interface SelectionRequest {
  role: string
  refs: readonly string[]
  requirements: Requirements
  /** The model this session used last: first among equals, and its token estimate needs no margin. */
  sticky?: string
  /** Model keys, and provider scopes (`provider:<id>`), already ruled out for this request. */
  exclude?: ReadonlySet<string>
  /** After a model refused the prompt as too long: only windows larger than this. */
  minWindow?: number
}

/** Prompt estimates are calibrated on the session's model; another model's tokenizer may count more. */
export const ESTIMATE_MARGIN = 1.1
/** A candidate must leave this much room to answer, or the request's whole budget if that is smaller. */
export const MIN_OUTPUT_TOKENS = 1_024

/** The provider's scope keys in the health tracker's blocks. */
export const scopes = {
  provider: (id: string) => `provider:${id}`,
  paid: (id: string) => `paid:${id}`,
}

/** Why free-only mode refuses a model. A model no catalog lists is unproven rather than known to be paid, and the message says so. */
export function notFreeMessage(model: string, listed: boolean): string {
  return listed
    ? `${model} is not a free model, and only free models are enabled`
    : `${model} is not in the provider's list of free models (which may not have loaded yet), and only free models are enabled`
}

/** The role's model list, with `@free` replaced by the pool's ranked members and duplicates dropped. */
export function expandRefs(ctx: SelectionContext, request: Pick<SelectionRequest, 'role' | 'refs' | 'sticky'>): Array<{ info: ModelInfo; provider: ProviderConfig; fromPool: boolean }> {
  const seen = new Set<string>()
  const out: Array<{ info: ModelInfo; provider: ProviderConfig; fromPool: boolean }> = []
  const add = (info: ModelInfo, provider: ProviderConfig, fromPool: boolean) => {
    if (seen.has(info.key)) return
    seen.add(info.key)
    out.push({ info, provider, fromPool })
  }
  for (const ref of request.refs) {
    if (ref === FREE_POOL) {
      for (const id of ctx.config.freePool.providers) {
        const provider = ctx.config.providers[id]
        if (!provider) continue
        for (const info of ctx.pool.members(id, request.role, ctx.config.freePool, request.sticky)) add(info, provider, true)
      }
      continue
    }
    const parsed = parseModelRef(ref)
    const provider = parsed && ctx.config.providers[parsed.provider]
    if (parsed && provider) add(ctx.registry.get(parsed.provider, parsed.model), provider, false)
  }
  return out
}

export function selectCandidates(ctx: SelectionContext, request: SelectionRequest): { candidates: Candidate[]; skipped: Skip[] } {
  const now = ctx.clock.now()
  const candidates: Candidate[] = []
  const skipped: Skip[] = []
  const { requirements } = request

  for (const { info, provider, fromPool } of expandRefs(ctx, request)) {
    const skip = (reason: SkipReason, message: string, extra: Partial<Skip> = {}) => skipped.push({ key: info.key, reason, message, ...extra })

    // First of all: in free-only mode a model that is not free is never "tried", whatever else is true of it.
    if (ctx.config.freeOnly && !info.free) {
      skip('not-free', notFreeMessage(info.model, ctx.registry.listed(provider.id, info.model)))
      continue
    }
    if (request.exclude?.has(info.key) || request.exclude?.has(scopes.provider(provider.id))) {
      skip('tried', 'already tried for this request')
      continue
    }
    if (!ctx.hasAdapter(provider.type)) {
      skip('no-adapter', `no adapter speaks ${provider.type}`)
      continue
    }
    if (provider.needsKey && !ctx.keys.has(provider.id)) {
      skip('no-key', `no key for ${provider.id}`)
      continue
    }
    const providerBlock = ctx.health.blocked(scopes.provider(provider.id))
    if (providerBlock) {
      skip('provider-blocked', providerBlock.reason, { until: providerBlock.until })
      continue
    }
    if (!info.free) {
      const paidBlock = ctx.health.blocked(scopes.paid(provider.id))
      if (paidBlock) {
        skip('paid-blocked', paidBlock.reason, { until: paidBlock.until })
        continue
      }
    }
    if (info.expiresAt !== undefined && info.expiresAt <= now) {
      skip('expired', 'the provider retired this model')
      continue
    }
    if (requirements.tools && !info.capabilities.tools) {
      skip('tools', 'cannot call tools')
      continue
    }
    if (requirements.images && !info.capabilities.images) {
      skip('images', 'cannot read images')
      continue
    }

    const margin = info.key === request.sticky ? 1 : ESTIMATE_MARGIN
    // The epsilon keeps 110,000 × 1.1 at 121,000 rather than one token over it.
    const room = info.contextWindow - Math.ceil(requirements.promptTokens * margin - 1e-6)
    if (room < Math.min(requirements.maxOutputTokens, MIN_OUTPUT_TOKENS) || (request.minWindow !== undefined && info.contextWindow <= request.minWindow)) {
      skip('context', `the prompt does not fit its ${info.contextWindow}-token window`, { window: info.contextWindow })
      continue
    }

    let delayMs = 0
    if (info.free) {
      const tier = ctx.freeTier(provider.id)
      const closed = tier?.closure()
      if (closed) {
        skip('free-closed', closed.reason, { until: closed.until })
        continue
      }
      delayMs = tier?.delay() ?? 0
      if (delayMs > ctx.config.freePool.maxPacingWaitMs) {
        skip('pacing', 'the free tier allows only so many requests a minute', { until: now + delayMs })
        continue
      }
    }

    const availability = ctx.health.availability(info.key)
    if (!availability.available) {
      skip('cooling', availability.reason, { until: availability.until })
      continue
    }

    candidates.push({
      info,
      provider,
      fromPool,
      probe: availability.probe,
      delayMs,
      maxOutputTokens: Math.max(1, Math.min(requirements.maxOutputTokens, info.maxOutputTokens, room)),
      serverFallbacks: [],
    })
  }

  // OpenRouter tries further free models itself before the first byte, which saves a round trip per failure.
  // Only free models follow a free one, so a fallback can never be billed.
  const fallbacks = ctx.config.freePool.serverFallbacks
  if (fallbacks > 0) {
    candidates.forEach((candidate, index) => {
      if (!candidate.info.free || candidate.provider.type !== 'openrouter') return
      candidate.serverFallbacks = candidates
        .slice(index + 1)
        .filter((next) => next.info.free && next.provider.id === candidate.provider.id && !next.probe)
        .slice(0, fallbacks)
        .map((next) => next.info.model)
    })
  }
  return { candidates, skipped }
}
