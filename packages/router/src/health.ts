import type { Clock } from './clock'

/**
 * Per-model health: cooldowns, circuit breakers and the statistics that rank
 * candidates. One tracker serves every session and subagent, so a model that
 * fails for one request is avoided by all of them.
 *
 * Every failure cools the model down: 5 s, doubling with each failure in a
 * row, up to 15 minutes, or until the time the provider named. The first
 * cooldown is short so a model that had one bad moment, or is the only one
 * configured, is back soon; the doubling and the breaker deal with the rest. The breaker
 * opens after 3 failures in a row, or when more than half of the last 20
 * calls failed. Once an open breaker's cooldown ends, one real request goes
 * through as a probe while the others keep away: success closes the breaker,
 * failure doubles the cooldown.
 *
 * Rate limits and missing models are not ill health: they set a cooldown but
 * never count toward the breaker. Scopes block a whole provider at once, for
 * example after it refused the key.
 */

export interface HealthOptions {
  cooldownMs: number
  maxCooldownMs: number
  /** Calls the error rate is measured over. */
  windowSize: number
  openAfterConsecutive: number
  /** The breaker opens when the failure share of the window exceeds this. */
  openAboveErrorRate: number
  /** The error rate only counts once the window holds this many calls. */
  minSamplesForRate: number
}

export const DEFAULT_HEALTH: Readonly<HealthOptions> = {
  cooldownMs: 5_000,
  maxCooldownMs: 15 * 60_000,
  windowSize: 20,
  openAfterConsecutive: 3,
  openAboveErrorRate: 0.5,
  minSamplesForRate: 10,
}

/** A cooldown the provider asks for is honoured, up to a day. */
const MAX_HINTED_COOLDOWN_MS = 24 * 60 * 60_000
/** How long others keep away while one request probes a recovering model. */
const PROBE_WAIT_MS = 5_000
/** Weight of the newest time-to-first-token in its moving average. */
const TTFT_WEIGHT = 0.3

export type Availability = { available: true; probe: boolean } | { available: false; until: number; reason: string }

export interface ScopeBlock {
  until: number
  kind: string
  reason: string
}

interface ModelState {
  /** Outcomes of the last calls, oldest first: true for success. */
  recent: boolean[]
  consecutiveFailures: number
  open: boolean
  cooldownUntil: number
  /** Failures in a row that set a backoff cooldown; the exponent of its doubling. */
  backoff: number
  /** Rate limits in a row without a time from the provider. */
  rateLimits: number
  probing: boolean
  ttftMs?: number
  successes: number
  failures: number
  rateLimited: number
  lastFailure?: { kind: string; message: string; at: number }
  lastSuccessAt?: number
}

export interface ModelHealthReport {
  key: string
  state: 'healthy' | 'cooling' | 'open' | 'probing'
  cooldownUntil?: number
  successRate?: number
  ttftMs?: number
  successes: number
  failures: number
  rateLimited: number
  lastFailure?: { kind: string; message: string; at: number }
}

export interface HealthSnapshot {
  version: 1
  models: Record<string, Omit<ModelState, 'probing'>>
  scopes: Record<string, ScopeBlock>
}

function fresh(): ModelState {
  return { recent: [], consecutiveFailures: 0, open: false, cooldownUntil: 0, backoff: 0, rateLimits: 0, probing: false, successes: 0, failures: 0, rateLimited: 0 }
}

export class HealthTracker {
  private readonly models = new Map<string, ModelState>()
  private readonly scopes = new Map<string, ScopeBlock>()
  private options: HealthOptions

  constructor(
    private readonly clock: Clock,
    options: Partial<HealthOptions> = {},
  ) {
    this.options = { ...DEFAULT_HEALTH, ...options }
  }

  setOptions(options: Partial<HealthOptions>): void {
    this.options = { ...this.options, ...options }
  }

  private state(key: string): ModelState {
    let state = this.models.get(key)
    if (!state) {
      state = fresh()
      this.models.set(key, state)
    }
    return state
  }

  private push(state: ModelState, ok: boolean): void {
    state.recent.push(ok)
    if (state.recent.length > this.options.windowSize) state.recent.splice(0, state.recent.length - this.options.windowSize)
  }

  private hinted(retryAt: number | undefined): number {
    if (retryAt === undefined || !Number.isFinite(retryAt)) return 0
    return Math.min(retryAt, this.clock.now() + MAX_HINTED_COOLDOWN_MS)
  }

  private backoffMs(level: number): number {
    return Math.min(this.options.cooldownMs * 2 ** Math.max(0, level - 1), this.options.maxCooldownMs)
  }

  availability(key: string): Availability {
    const state = this.models.get(key)
    if (!state) return { available: true, probe: false }
    const now = this.clock.now()
    if (now < state.cooldownUntil) {
      return { available: false, until: state.cooldownUntil, reason: state.lastFailure?.message ?? 'cooling down' }
    }
    if (state.open) {
      if (state.probing) return { available: false, until: now + PROBE_WAIT_MS, reason: 'another request is checking whether it recovered' }
      return { available: true, probe: true }
    }
    return { available: true, probe: false }
  }

  /** Claims the probe of a model whose breaker is open. False when another request already probes it. */
  startProbe(key: string): boolean {
    const state = this.state(key)
    if (state.probing) return false
    state.probing = true
    return true
  }

  /** Releases a probe that ended without a verdict, for example because the user stopped it. */
  endProbe(key: string): void {
    const state = this.models.get(key)
    if (state) state.probing = false
  }

  success(key: string, details: { ttftMs?: number } = {}): void {
    const state = this.state(key)
    state.successes++
    state.consecutiveFailures = 0
    state.backoff = 0
    state.rateLimits = 0
    state.open = false
    state.probing = false
    state.cooldownUntil = 0
    state.lastSuccessAt = this.clock.now()
    this.push(state, true)
    if (details.ttftMs !== undefined && Number.isFinite(details.ttftMs) && details.ttftMs >= 0) {
      state.ttftMs = state.ttftMs === undefined ? details.ttftMs : state.ttftMs * (1 - TTFT_WEIGHT) + details.ttftMs * TTFT_WEIGHT
    }
  }

  /** A failure that says the model is unwell: backoff cooldown, and it counts toward the breaker. */
  failure(key: string, details: { kind: string; message: string; retryAt?: number }): void {
    const state = this.state(key)
    const now = this.clock.now()
    state.failures++
    state.consecutiveFailures++
    state.backoff = Math.min(state.backoff + 1, 30)
    state.probing = false
    state.lastFailure = { kind: details.kind, message: details.message, at: now }
    state.cooldownUntil = Math.max(state.cooldownUntil, now + this.backoffMs(state.backoff), this.hinted(details.retryAt))
    this.push(state, false)
    const failed = state.recent.filter((ok) => !ok).length
    const rateTripped = state.recent.length >= this.options.minSamplesForRate && failed / state.recent.length > this.options.openAboveErrorRate
    if (state.consecutiveFailures >= this.options.openAfterConsecutive || rateTripped) state.open = true
  }

  /** The model is busy, not broken: cooldown until the provider's time, or a doubling backoff without one. */
  rateLimited(key: string, details: { message: string; retryAt?: number }): void {
    const state = this.state(key)
    const now = this.clock.now()
    state.rateLimited++
    state.probing = false
    state.lastFailure = { kind: 'rate-limit', message: details.message, at: now }
    const hinted = this.hinted(details.retryAt)
    if (hinted > now) {
      state.cooldownUntil = Math.max(state.cooldownUntil, hinted)
    } else {
      state.rateLimits = Math.min(state.rateLimits + 1, 30)
      state.cooldownUntil = Math.max(state.cooldownUntil, now + this.backoffMs(state.rateLimits))
    }
  }

  /**
   * The model cannot serve this account for now (gone, or refused by its data
   * policy). No breaker change. Whatever it answered before no longer vouches
   * for it.
   */
  unusable(key: string, details: { kind: string; message: string; until: number }): void {
    const state = this.state(key)
    state.probing = false
    state.lastSuccessAt = undefined
    state.lastFailure = { kind: details.kind, message: details.message, at: this.clock.now() }
    state.cooldownUntil = Math.max(state.cooldownUntil, this.hinted(details.until))
  }

  /** Ends a model's cooldown now, keeping its record: the user fixed what kept it out. */
  release(key: string): void {
    const state = this.models.get(key)
    if (!state) return
    state.cooldownUntil = 0
    state.probing = false
  }

  /** Whether the model has answered a request since it last failed to be usable: a listing says it exists, only an answer says it works. */
  proven(key: string): boolean {
    return this.models.get(key)?.lastSuccessAt !== undefined
  }

  /** A call that worked but went wrong in a smaller way (invalid tool arguments): ranks the model lower. */
  soft(key: string): void {
    this.push(this.state(key), false)
  }

  /**
   * How much to trust a model, 0 to 1: mostly its recent success rate, then
   * its speed to first token, then how rarely it is rate limited. A model never
   * used scores in the middle.
   */
  score(key: string): number {
    const state = this.models.get(key)
    if (!state) return 0.6 * 0.5 + 0.25 * 0.5 + 0.15
    const ok = state.recent.filter(Boolean).length
    const reliability = (ok + 1) / (state.recent.length + 2)
    const speed = state.ttftMs === undefined ? 0.5 : 1 / (1 + state.ttftMs / 8_000)
    const total = state.successes + state.failures + state.rateLimited
    const congestion = state.rateLimited / (total + 4)
    return 0.6 * reliability + 0.25 * speed + 0.15 * (1 - congestion)
  }

  /** Blocks a whole scope (`provider:<id>`, `paid:<id>`…) until a time. A later block never shortens an earlier one. */
  block(scope: string, block: ScopeBlock): void {
    const current = this.blocked(scope)
    if (current && current.until >= block.until) return
    this.scopes.set(scope, { ...block, until: Math.min(block.until, this.clock.now() + MAX_HINTED_COOLDOWN_MS) })
  }

  blocked(scope: string): ScopeBlock | undefined {
    const block = this.scopes.get(scope)
    if (!block) return undefined
    if (this.clock.now() >= block.until) {
      this.scopes.delete(scope)
      return undefined
    }
    return block
  }

  unblock(scope: string): void {
    this.scopes.delete(scope)
  }

  /** Forgets a model's history, for example after the user fixed its settings. */
  reset(key: string): void {
    this.models.delete(key)
  }

  report(): { models: ModelHealthReport[]; scopes: Array<ScopeBlock & { scope: string }> } {
    const now = this.clock.now()
    const models = [...this.models].map(([key, state]): ModelHealthReport => {
      const cooling = now < state.cooldownUntil
      return {
        key,
        state: state.probing ? 'probing' : cooling ? (state.open ? 'open' : 'cooling') : state.open ? 'open' : 'healthy',
        cooldownUntil: cooling ? state.cooldownUntil : undefined,
        successRate: state.recent.length ? state.recent.filter(Boolean).length / state.recent.length : undefined,
        ttftMs: state.ttftMs === undefined ? undefined : Math.round(state.ttftMs),
        successes: state.successes,
        failures: state.failures,
        rateLimited: state.rateLimited,
        lastFailure: state.lastFailure,
      }
    })
    const scopes = [...this.scopes.keys()].flatMap((scope) => {
      const block = this.blocked(scope)
      return block ? [{ scope, ...block }] : []
    })
    return { models, scopes }
  }

  snapshot(): HealthSnapshot {
    const models: HealthSnapshot['models'] = {}
    for (const [key, { probing: _probing, ...state }] of this.models) models[key] = { ...state, recent: [...state.recent] }
    const scopes: HealthSnapshot['scopes'] = {}
    for (const scope of this.scopes.keys()) {
      const block = this.blocked(scope)
      if (block) scopes[scope] = { ...block }
    }
    return { version: 1, models, scopes }
  }

  /** Restores a snapshot from disk; malformed entries are skipped. */
  restore(snapshot: unknown): void {
    if (!snapshot || typeof snapshot !== 'object' || (snapshot as HealthSnapshot).version !== 1) return
    const { models, scopes } = snapshot as HealthSnapshot
    const finite = (value: unknown, fallback = 0) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)
    for (const [key, raw] of Object.entries(models ?? {})) {
      if (!raw || typeof raw !== 'object') continue
      const state = fresh()
      state.recent = Array.isArray(raw.recent) ? raw.recent.filter((ok) => typeof ok === 'boolean').slice(-this.options.windowSize) : []
      state.consecutiveFailures = finite(raw.consecutiveFailures)
      state.open = raw.open === true
      state.cooldownUntil = Math.min(finite(raw.cooldownUntil), this.clock.now() + MAX_HINTED_COOLDOWN_MS)
      state.backoff = Math.min(finite(raw.backoff), 30)
      state.rateLimits = Math.min(finite(raw.rateLimits), 30)
      state.ttftMs = typeof raw.ttftMs === 'number' && Number.isFinite(raw.ttftMs) ? raw.ttftMs : undefined
      state.successes = finite(raw.successes)
      state.failures = finite(raw.failures)
      state.rateLimited = finite(raw.rateLimited)
      if (raw.lastFailure && typeof raw.lastFailure.kind === 'string' && typeof raw.lastFailure.message === 'string') {
        state.lastFailure = { kind: raw.lastFailure.kind, message: raw.lastFailure.message, at: finite(raw.lastFailure.at) }
      }
      state.lastSuccessAt = typeof raw.lastSuccessAt === 'number' ? raw.lastSuccessAt : undefined
      this.models.set(key, state)
    }
    for (const [scope, block] of Object.entries(scopes ?? {})) {
      if (block && typeof block.until === 'number' && typeof block.kind === 'string' && typeof block.reason === 'string') this.block(scope, block)
    }
  }
}
