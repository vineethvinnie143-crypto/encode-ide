import type { Clock } from './clock'
import type { FreePoolConfig } from './config'
import type { HealthTracker } from './health'
import type { ModelInfo, ModelRegistry } from './registry'

/**
 * The free pool behind `@free`: the free models of the pool's providers,
 * found at run time from their catalogs and never hard-coded, because the set
 * changes every few weeks.
 *
 * A model's place in the pool comes from its eval score for the role when
 * one exists, else a prior from its window and age; then from its health in
 * this session (success rate, speed, how often it is rate limited); then from
 * whether it passed the canary, a short tool-calling check run before it is
 * trusted. A model that failed the canary stays out for a week. Virtual
 * models that name their roles (the gateway's) serve those roles first and
 * the others only as a fallback.
 */

export type CanaryStatus = 'passed' | 'failed'

export interface CanaryRecord {
  status: CanaryStatus
  at: number
  reason?: string
}

export interface PoolSnapshot {
  version: 1
  canaries: Record<string, CanaryRecord>
}

const DAY = 24 * 60 * 60_000
/** A model that failed its canary is checked again after this long: providers fix things. */
export const CANARY_RETRY_MS = 7 * DAY
/** A model that passed is checked again after this long, since a model id can change what it serves. */
export const CANARY_REFRESH_MS = 30 * DAY

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`, 'i')
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/** 0 for a 32k window, 1 for a million tokens or more, on a log scale. */
function windowScore(tokens: number): number {
  return clamp01((Math.log2(tokens) - 15) / (Math.log2(1_000_000) - 15))
}

/** 1 for a model published today, falling to 0 over a year; unknown age scores low. */
function recencyScore(created: number | undefined, now: number): number {
  return created === undefined ? 0.3 : clamp01(1 - (now - created) / (365 * DAY))
}

export class FreePool {
  private canaries = new Map<string, CanaryRecord>()

  constructor(
    private readonly registry: ModelRegistry,
    private readonly health: HealthTracker,
    private readonly clock: Clock,
  ) {}

  recordCanary(key: string, status: CanaryStatus, reason?: string): void {
    this.canaries.set(key, { status, at: this.clock.now(), reason })
  }

  canary(key: string): CanaryRecord | undefined {
    return this.canaries.get(key)
  }

  /** Why a model is kept out of the pool, or undefined when it may be in. */
  exclusion(model: ModelInfo, config: FreePoolConfig): string | undefined {
    if (!model.free) return 'it is not free'
    if (model.contextWindow < config.minContextWindow) return `its window of ${model.contextWindow.toLocaleString('en-US')} tokens is below the pool's minimum of ${config.minContextWindow.toLocaleString('en-US')}`
    if (model.expiresAt !== undefined && model.expiresAt <= this.clock.now()) return 'the provider retired it'
    if (config.exclude.some((glob) => globToRegExp(glob).test(model.model))) return 'it is excluded in settings'
    const canary = this.canaries.get(model.key)
    if (canary?.status === 'failed' && this.clock.now() - canary.at < CANARY_RETRY_MS) return `it failed its tool-call check${canary.reason ? ` (${canary.reason})` : ''}`
    return undefined
  }

  private excluded(model: ModelInfo, config: FreePoolConfig): boolean {
    return this.exclusion(model, config) !== undefined
  }

  /** How strongly the pool prefers a model for a role. Higher is better. */
  rank(model: ModelInfo, role: string): number {
    const now = this.clock.now()
    const prior = 0.3 + 0.4 * windowScore(model.contextWindow) + 0.3 * recencyScore(model.created, now)
    const quality = model.scores[role] ?? prior
    const roleFit = model.roles?.length ? (model.roles.includes(role) ? 1 : 0) : 0.5
    const checked = this.canaries.get(model.key)?.status === 'passed' ? 1 : 0
    return 2 * roleFit + 0.45 * quality + 0.35 * this.health.score(model.key) + 0.2 * checked
  }

  /**
   * The provider's free models that may serve the role, best first. The
   * session's current model leads when it is a member, which keeps prompt
   * caches warm and behaviour consistent; it only changes on failure.
   */
  members(provider: string, role: string, config: FreePoolConfig, sticky?: string): ModelInfo[] {
    const ranked = this.registry
      .list(provider)
      .filter((model) => !this.excluded(model, config))
      .map((model) => ({ model, score: this.rank(model, role) }))
      .sort((a, b) => b.score - a.score || a.model.model.localeCompare(b.model.model))
      .map(({ model }) => model)
    const index = sticky ? ranked.findIndex((model) => model.key === sticky) : -1
    if (index > 0) ranked.unshift(...ranked.splice(index, 1))
    return ranked
  }

  /** Free models with tool support that no canary has vouched for lately, the most promising first. */
  unchecked(provider: string, config: FreePoolConfig, limit: number): ModelInfo[] {
    const now = this.clock.now()
    return this.registry
      .list(provider)
      .filter((model) => model.capabilities.tools && !this.excluded(model, config))
      .filter((model) => {
        // A failed canary that is still recent was excluded above, so any failed one left is due again.
        const canary = this.canaries.get(model.key)
        return !canary || canary.status === 'failed' || now - canary.at >= CANARY_REFRESH_MS
      })
      .sort((a, b) => this.rank(b, 'main') - this.rank(a, 'main'))
      .slice(0, Math.max(0, limit))
  }

  snapshot(): PoolSnapshot {
    return { version: 1, canaries: Object.fromEntries(this.canaries) }
  }

  restore(snapshot: unknown): void {
    if (!snapshot || typeof snapshot !== 'object' || (snapshot as PoolSnapshot).version !== 1) return
    for (const [key, record] of Object.entries((snapshot as PoolSnapshot).canaries ?? {})) {
      if (record && (record.status === 'passed' || record.status === 'failed') && Number.isFinite(record.at)) {
        this.canaries.set(key, { status: record.status, at: record.at, reason: typeof record.reason === 'string' ? record.reason : undefined })
      }
    }
  }
}
