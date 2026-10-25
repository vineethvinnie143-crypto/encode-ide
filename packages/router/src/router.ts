import {
  cacheTermsOf,
  isEmptyReply,
  repairJson as defaultRepairJson,
  userText,
  type AssembledReply,
  type BudgetQuery,
  type ClientEvent,
  type CompletionOutcome,
  type CompletionRequest,
  type ModelBudget,
  type ModelClient,
  type ModelRequest,
  type ModelRole,
  type PauseReason,
  type ProviderAdapter,
  type ProviderType,
  type Requirements,
  type ToolUseBlock,
  type TransportErrorKind,
  type TransportTarget,
} from '@encode/providers'
import { REFUSAL_KINDS, refusalMessage, refusalOf, type Refusal, type RefusalKind } from './access'
import { runAttempt, type AttemptResult } from './attempt'
import { abortReason, sleep, systemClock, type Clock } from './clock'
import { defaultRouterConfig, isLoopbackUrl, resolveModelList, type ProviderConfig, type RouterConfig } from './config'
import { FreeTier, type FreeTierSnapshot, type FreeTierStatus } from './free-tier'
import { HealthTracker, type HealthSnapshot, type ModelHealthReport, type ScopeBlock } from './health'
import { originOf, redact, type KeySource } from './keys'
import { fetchModelList } from './model-list'
import { fetchFreeQuota, fetchOpenRouterCatalog, nextUtcMidnight, type Fetch } from './openrouter'
import { FreePool, type PoolSnapshot } from './pool'
import { FREE_POOL, modelKey, parseModelRef, splitKey } from './refs'
import { ModelRegistry, type CatalogEntry, type ModelInfo, type RegistrySnapshot } from './registry'
import { failureOf, roleText, skipSentence } from './plain'
import { notFreeMessage, scopes, selectCandidates, type Candidate, type SelectionContext, type Skip } from './select'

/**
 * The model router: eNCode's ModelClient. Core asks it for a role; it picks
 * the best model that can take the call now, streams one attempt at a time,
 * and fails over silently when an attempt dies, before or during the stream.
 * Nothing reaches core's history until an attempt finishes cleanly.
 *
 * Every failure is classified once (see @encode/providers' errors.ts) and
 * answered by the policy in `onFailure`: a model that is unwell cools down and
 * may trip its breaker; a model that is busy waits out its rate limit; a limit
 * on the whole account closes the free tier or blocks the provider; a bad
 * key blocks the provider until the key changes; a prompt that does not fit
 * teaches the model's real window and moves to a larger one.
 *
 * Each request has a failover budget: so many costly failures (a timeout, a
 * dropped stream, a 5xx) or so much time since the first one. When it is
 * spent, or nothing can run, the request ends as an outcome core can act on:
 * `compact` when only the window stands in the way, `paused` otherwise, with
 * the time a retry may work. Waits short enough to sit out (a per-minute
 * limit, a cooldown) are sat out, and announced with a `wait` event.
 */

export type RouterAlert = (
  /** The provider refused the key. The provider stays blocked until keysChanged(). */
  | { type: 'key-refused'; provider: string; message: string }
  /** eNCode's gateway wants the user to sign in again. */
  | { type: 'sign-in'; provider: string; message: string }
  /** Out of credit, or a budget is spent; paid models of the provider are blocked until `until`. */
  | { type: 'payment'; provider: string; message: string; until?: number }
  /** A daily quota is used up (OpenRouter's free requests, the gateway's allowance). */
  | { type: 'quota'; provider: string; message: string; until?: number }
  /** The model catalog could not be fetched; the free pool may be empty. */
  | { type: 'catalog'; provider: string; message: string }
  /** The provider billed a request to a model listed as free. The model counts as paid from now on. */
  | { type: 'billed'; provider: string; model: string; cost: number; message: string }
  /**
   * The provider will not serve one model on this account: its privacy settings
   * leave the model no endpoint, or the model is limited to listed apps. The
   * model is skipped until `until`, and nothing else is affected. Sent once
   * per provider and reason until retryRefused() or keysChanged().
   */
  | { type: 'model-refused'; provider: string; model: string; reason: RefusalKind; message: string; until: number }
) & {
  /** `message` is a plain sentence; this is what the provider said, for a Details fold and the log. */
  detail?: string
}

export interface RouterLogEntry {
  level: 'debug' | 'info' | 'warn'
  message: string
  key?: string
}

/** How one request went, for logs and diagnostics. */
export interface RequestTrace {
  role: string
  startedAt: number
  endedAt: number
  /** Attempts made, each one call to a model. */
  attempts: number
  /** Failures that counted against the failover budget. */
  costly: number
  /** When the first failure or wait happened. */
  firstProblemAt?: number
  /** Models (and `provider:<id>` scopes) ruled out for this request: refused it, overflowed, could not answer. */
  excluded: string[]
  outcome: CompletionOutcome['kind'] | 'aborted'
  /** The pause reason, for a paused request. */
  reason?: PauseReason
  /** The model that answered, for a finished request. */
  model?: string
}

export interface RouterOptions {
  config?: RouterConfig
  /** One adapter per provider type. */
  adapters: readonly ProviderAdapter[] | Partial<Record<ProviderType, ProviderAdapter>>
  keys: KeySource
  clock?: Clock
  /** For catalog and quota syncs. Default: the global fetch; null turns syncing off. */
  fetch?: Fetch | null
  /** Repairs malformed tool JSON. Default: the shared json-repair, which never completes a truncated value. */
  repairJson?: (raw: string) => unknown
  newId?: () => string
  onAlert?(alert: RouterAlert): void
  onLog?(entry: RouterLogEntry): void
  /** Called once per request when it ends, however it ends. */
  onTrace?(trace: RequestTrace): void
}

export interface RouterStatus {
  /** Only free models may take a call (see RouterConfig.freeOnly). */
  freeOnly: boolean
  models: ModelHealthReport[]
  blocks: Array<ScopeBlock & { scope: string }>
  freeTiers: FreeTierStatus[]
  catalogs: Array<{ provider: string; fetchedAt?: number; models: number; free: number; error?: string }>
}

export interface RouterSnapshot {
  version: 1
  registry: RegistrySnapshot
  health: HealthSnapshot
  pool: PoolSnapshot
  freeTiers: Record<string, FreeTierSnapshot>
}

export interface RefreshOptions {
  /** Only these providers. Default: every provider that lists models (OpenRouter, free providers, and any with a key). */
  providers?: string[]
  /** Fetch even when the catalog is fresh. */
  force?: boolean
  signal?: AbortSignal
}

export interface CheckResult {
  ok: boolean
  key: string
  /** The model that answered. */
  model?: string
  ttftMs?: number
  /** The model made a valid tool call, as asked. */
  toolCall: boolean
  /** What the provider billed for the call in US dollars, when it says. Zero for a free model. */
  cost?: number
  /** The provider will not serve this model on this account (see RefusalKind); it is skipped for a day or an hour, and `message` says why. */
  blocked?: RefusalKind
  /** In plain words. */
  message: string
  /** What the provider said, keys removed, when the check failed on its answer. */
  detail?: string
}

/** A catalog older than this is refreshed in the background when a request needs it. */
const CATALOG_MAX_AGE_MS = 6 * 60 * 60_000
/** The quota OpenRouter reports is re-read this often while requests flow; other apps may share the key. */
const QUOTA_MAX_AGE_MS = 15 * 60_000
/** A forced refresh (a model gone missing, the user's Refresh button) refetches a catalog at most this often. */
const CATALOG_MIN_INTERVAL_MS = 60_000
/** A request waits this long for a missing catalog before going on without it. */
const CATALOG_WAIT_MS = 15_000
/** Without a time from the provider: how long an account-wide block lasts. */
const DEFAULT_BLOCK_MS = {
  auth: 24 * 60 * 60_000,
  payment: 60 * 60_000,
  quota: 60 * 60_000,
  freeMinute: 60_000,
  paidRateLimit: 10_000,
  accountRateLimit: 30_000,
  network: 10_000,
  notFound: 6 * 60 * 60_000,
  unsupported: 60 * 60_000,
} as const
const MAX_SESSIONS = 500
/** A key read that hangs (a token refresh on a dead connection) is given up on after this long. */
const KEY_READ_MS = 20_000
/** Canaries run only while at least this many free requests are left today. */
const CANARY_RESERVE = 100

/** `no-key`: none is stored; `key-read`: the store could not be read. */
type FailureKind = TransportErrorKind | RefusalKind | 'empty' | 'tool-json' | 'no-key' | 'key-read'

interface RequestState {
  readonly startedAt: number
  attempts: number
  /** Failures that cost time or a request: timeouts, dropped streams, server errors, unusable replies. */
  costly: number
  /** When the first failure or wait happened; the time budget runs from here. */
  firstProblemAt?: number
  /** Model keys and provider scopes ruled out for this request. */
  excluded: Set<string>
  /** Same-model retries already spent, by `<key>:<why>`. */
  retried: Set<string>
  /** Retry this model next. */
  forceKey?: string
  /** After an overflow: the prompt size a server counted, which beats the estimate for every model tried next. */
  overflowUsed?: number
  lastFailure?: { key: string; kind: FailureKind; message: string; retryAt?: number; feature?: string }
  previousKey?: string
  /** A finished but flawed reply (unreadable tool JSON, empty), committed if nothing better arrives. */
  fallback?: AssembledReply
  /** The one model of a pinned client, whatever the role (ADR 0101). */
  readonly pin?: string
}

type Step = { next: true } | { outcome: CompletionOutcome }
const NEXT: Step = { next: true }

/** What a call to this model can hold and costs. A price of nothing for a model that is not free is one nobody gave. */
function budgetOf(info: ModelInfo): ModelBudget {
  return {
    model: info.model,
    contextWindow: info.contextWindow,
    maxOutputTokens: info.maxOutputTokens,
    images: info.capabilities.images,
    documents: info.capabilities.documents === true,
    ...(info.free || info.price.input > 0 || info.price.output > 0 ? { price: { input: info.price.input, output: info.price.output } } : {}),
    free: info.free,
    cache: cacheTermsOf({ family: info.family, reasoning: info.capabilities.reasoning, price: info.price }),
  }
}

function adapterMap(adapters: RouterOptions['adapters']): Map<ProviderType, ProviderAdapter> {
  const list = Array.isArray(adapters) ? adapters : Object.values(adapters as Partial<Record<ProviderType, ProviderAdapter>>)
  return new Map(list.filter((adapter): adapter is ProviderAdapter => Boolean(adapter)).map((adapter) => [adapter.type, adapter]))
}

export class ModelRouter implements ModelClient {
  readonly registry = new ModelRegistry()
  readonly health: HealthTracker
  readonly pool: FreePool
  private config: RouterConfig
  private readonly adapters: Map<ProviderType, ProviderAdapter>
  private readonly keys: KeySource
  private readonly clock: Clock
  private readonly fetchImpl?: Fetch
  private readonly repair: (raw: string) => unknown
  private readonly options: RouterOptions
  private readonly tiers = new Map<string, FreeTier>()
  private readonly sessions = new Map<string, string>()
  private readonly syncing = new Map<string, Promise<void>>()
  private readonly syncErrors = new Map<string, string>()
  private readonly quotaFetchedAt = new Map<string, number>()
  /** `<provider>:<reason>` of the model-refused alerts already sent. */
  private readonly announced = new Set<string>()

  constructor(options: RouterOptions) {
    this.options = options
    this.clock = options.clock ?? systemClock
    this.keys = options.keys
    this.adapters = adapterMap(options.adapters)
    this.repair = options.repairJson ?? defaultRepairJson
    const globalFetch = (globalThis as { fetch?: Fetch }).fetch
    this.fetchImpl = options.fetch === null ? undefined : (options.fetch ?? (globalFetch ? (input, init) => globalFetch(input, init) : undefined))
    this.config = options.config ?? defaultRouterConfig()
    this.health = new HealthTracker(this.clock, { cooldownMs: this.config.limits.cooldownMs, maxCooldownMs: this.config.limits.maxCooldownMs })
    this.pool = new FreePool(this.registry, this.health, this.clock)
    this.configure(this.config)
  }

  /** Applies new settings. Health, learned facts and the free tiers' counts carry over. */
  configure(config: RouterConfig): void {
    this.config = config
    this.registry.setProviders(config.providers)
    this.registry.setOverrides(config.models)
    this.health.setOptions({ cooldownMs: config.limits.cooldownMs, maxCooldownMs: config.limits.maxCooldownMs })
    for (const [id, tier] of this.tiers) {
      if (config.providers[id]?.type === 'openrouter') tier.setRequestsPerMinute(config.freePool.requestsPerMinute)
      else this.tiers.delete(id)
    }
  }

  get settings(): RouterConfig {
    return this.config
  }

  /** The user changed a provider's key or credit: lift the blocks a refused key or payment set. A new key may be a new account, so refused models get another try too. */
  keysChanged(provider: string): void {
    this.health.unblock(scopes.provider(provider))
    this.health.unblock(scopes.paid(provider))
    this.retryRefused(provider)
  }

  /**
   * Puts the models a provider refused for this account back in play, for a
   * "Check again" button after the user changed their OpenRouter settings.
   * Without a provider, every provider's. Returns how many models were released.
   */
  retryRefused(provider?: string): number {
    let released = 0
    for (const model of this.health.report().models) {
      if (model.state === 'healthy' || !model.lastFailure || !REFUSAL_KINDS.has(model.lastFailure.kind)) continue
      if (provider !== undefined && splitKey(model.key).provider !== provider) continue
      this.health.release(model.key)
      released++
    }
    for (const announced of [...this.announced]) if (provider === undefined || announced.startsWith(`${provider}:`)) this.announced.delete(announced)
    return released
  }

  /** Sets a refused model aside for this account, tells the user the first time, and returns what to say about it. */
  private refuse(key: string, refusal: Refusal, providerText: string, secrets: string[]): string {
    const { provider, model } = splitKey(key)
    const until = this.clock.now() + refusal.ms
    const message = redact(refusalMessage(refusal.kind, model, providerText), secrets)
    this.health.unusable(key, { kind: refusal.kind, message, until })
    const announcement = `${provider}:${refusal.kind}`
    if (!this.announced.has(announcement)) {
      this.announced.add(announcement)
      this.alert({ type: 'model-refused', provider, model, reason: refusal.kind, message, until, detail: redact(providerText, secrets) })
    }
    return message
  }

  /** In free-only mode, why the model may not be sent a request, judged on the registry as it is right now. */
  private paidRefusal(provider: ProviderConfig, model: string): string | undefined {
    if (!this.config.freeOnly || this.registry.get(provider.id, model).free) return undefined
    return notFreeMessage(model, this.registry.listed(provider.id, model))
  }

  /** OpenRouter's free tier for a provider; only OpenRouter accounts have one. */
  freeTier(provider: string): FreeTier | undefined {
    const config = this.config.providers[provider]
    if (config?.type !== 'openrouter') return undefined
    let tier = this.tiers.get(provider)
    if (!tier) {
      tier = new FreeTier(this.clock, provider, this.config.freePool.requestsPerMinute)
      this.tiers.set(provider, tier)
    }
    return tier
  }

  private get selection(): SelectionContext {
    return {
      config: this.config,
      registry: this.registry,
      health: this.health,
      pool: this.pool,
      freeTier: (provider) => this.freeTier(provider),
      keys: this.keys,
      hasAdapter: (type) => this.adapters.has(type as ProviderType),
      clock: this.clock,
    }
  }

  /**
   * Reads a provider's key. A KeySource may refresh a token over the network, so
   * a read that hangs must not outlive an abort or hold a catalog sync for good:
   * it ends when the signal aborts or after KEY_READ_MS, with `problem` saying why.
   * A missing key is no problem, just no `key`.
   */
  private async readKey(provider: ProviderConfig, signal?: AbortSignal): Promise<{ key?: string; problem?: string }> {
    let timer: unknown
    let onAbort: (() => void) | undefined
    try {
      return await Promise.race([
        (async () => ({ key: (await this.keys.get(provider.id, originOf(provider.baseUrl))) || undefined }))(),
        new Promise<{ problem: string }>((resolve) => {
          timer = this.clock.setTimeout(() => resolve({ problem: `Reading the key for ${provider.id} took longer than ${KEY_READ_MS / 1000} s.` }), KEY_READ_MS)
        }),
        new Promise<Record<string, never>>((resolve) => {
          if (!signal) return
          onAbort = () => resolve({})
          if (signal.aborted) onAbort()
          else signal.addEventListener('abort', onAbort, { once: true })
        }),
      ])
    } catch (error) {
      return { problem: `Reading the key for ${provider.id} failed: ${error instanceof Error ? error.message : String(error)}` }
    } finally {
      if (timer !== undefined) this.clock.clearTimeout(timer)
      if (signal && onAbort) signal.removeEventListener('abort', onAbort)
    }
  }

  private emitter(request: CompletionRequest): (event: ClientEvent) => void {
    return (event) => {
      try {
        request.onEvent?.(event)
      } catch (error) {
        this.log('warn', `A progress listener failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  private log(level: RouterLogEntry['level'], message: string, key?: string): void {
    try {
      this.options.onLog?.({ level, message: redact(message), ...(key ? { key } : {}) })
    } catch {
      // Logging must never break a request.
    }
  }

  private alert(alert: RouterAlert): void {
    try {
      this.options.onAlert?.({ ...alert, message: redact(alert.message), ...(alert.detail ? { detail: redact(alert.detail) } : {}) })
    } catch {
      // An alert listener must never break a request.
    }
  }

  // ------------------------------------------------------------- completion

  async complete(request: CompletionRequest): Promise<CompletionOutcome> {
    return this.completeOn(request)
  }

  /**
   * A client of one model for every role, tool and subagent, with no other to fail over to (ADR 0101): what "Test this
   * model" scores. Its calls go through everything else as any call does: the key bound to its server, free-only mode,
   * the paid guards, the free tier's counts, health and what a provider refused.
   */
  pinned(ref: string): ModelClient {
    return {
      complete: (request) => this.completeOn(request, ref),
      budget: (role, query) => this.budgetOn(role, query, ref),
    }
  }

  private async completeOn(request: CompletionRequest, pin?: string): Promise<CompletionOutcome> {
    const { signal } = request
    if (signal.aborted) throw abortReason(signal)
    const state: RequestState = { startedAt: this.clock.now(), attempts: 0, costly: 0, excluded: new Set(), retried: new Set(), ...(pin !== undefined ? { pin } : {}) }
    let outcome: CompletionOutcome | undefined
    try {
      outcome = await this.run(request, state)
      return outcome
    } catch (error) {
      if (signal.aborted) throw abortReason(signal)
      // complete() rejects only on abort; anything else is a bug, reported as a pause rather than a crash.
      const message = error instanceof Error ? error.message : String(error)
      this.log('warn', `The router failed unexpectedly: ${message}`)
      outcome = { kind: 'paused', reason: 'unavailable', message: "eNCode's model router hit a problem it did not expect.", detail: redact(message) }
      return outcome
    } finally {
      this.trace(request, state, outcome)
    }
  }

  private trace(request: CompletionRequest, state: RequestState, outcome: CompletionOutcome | undefined): void {
    if (!this.options.onTrace) return
    try {
      this.options.onTrace({
        role: request.role,
        startedAt: state.startedAt,
        endedAt: this.clock.now(),
        attempts: state.attempts,
        costly: state.costly,
        ...(state.firstProblemAt !== undefined ? { firstProblemAt: state.firstProblemAt } : {}),
        excluded: [...state.excluded],
        outcome: outcome?.kind ?? 'aborted',
        ...(outcome?.kind === 'paused' ? { reason: outcome.reason } : {}),
        ...(outcome?.kind === 'done' && outcome.message.origin ? { model: outcome.message.origin.model } : {}),
      })
    } catch {
      // A trace listener must never break a request.
    }
  }

  /** The models a call would try now, in order, and why the others are left out. For the UI's model indicator. */
  preview(role: ModelRole, requirements: Requirements, query: BudgetQuery = {}): { candidates: string[]; skipped: Skip[] } {
    const { role: resolved, refs } = resolveModelList(this.config, { role, tool: query.tool, agent: query.agent })
    const sticky = query.sticky !== undefined ? this.sessions.get(query.sticky) : undefined
    const { candidates, skipped } = selectCandidates(this.selection, { role: resolved, refs, requirements, sticky })
    return { candidates: candidates.map((candidate) => candidate.info.key), skipped }
  }

  /** The models a request may run on, in order: its role's list, or a pinned client's one model. */
  private listOf(request: CompletionRequest, state: RequestState): { role: string; refs: string[] } {
    return state.pin !== undefined ? { role: request.role, refs: [state.pin] } : resolveModelList(this.config, request)
  }

  private async run(request: CompletionRequest, state: RequestState): Promise<CompletionOutcome> {
    const { signal } = request
    const emit = this.emitter(request)
    const { role, refs } = this.listOf(request, state)
    await this.ensureCatalogs(refs, signal)
    const limits = this.config.limits

    while (true) {
      if (signal.aborted) throw abortReason(signal)
      if (state.attempts >= limits.maxAttempts) return this.giveUp(state, role, refs, request.requirements)

      const sticky = request.sticky !== undefined ? this.sessions.get(request.sticky) : undefined
      // After an overflow, what the server counted replaces an estimate that was too low.
      const { requirements } = request
      const { candidates, skipped } = selectCandidates(this.selection, {
        role,
        refs,
        requirements: state.overflowUsed !== undefined && state.overflowUsed > requirements.promptTokens ? { ...requirements, promptTokens: state.overflowUsed } : requirements,
        sticky,
        exclude: state.excluded,
      })
      const forced = state.forceKey !== undefined ? candidates.find((candidate) => candidate.info.key === state.forceKey) : undefined
      state.forceKey = undefined
      const candidate = forced ?? candidates[0]

      if (!candidate) {
        const step = await this.whenNothingRuns(state, skipped, request, emit)
        if ('outcome' in step) return step.outcome
        continue
      }
      if (candidate.delayMs > 0) {
        emit({ type: 'wait', until: this.clock.now() + candidate.delayMs, reason: 'The free models take only so many requests a minute.' })
        await sleep(this.clock, candidate.delayMs, signal)
        continue
      }

      const step = await this.attempt(candidate, request, state, emit, { sticky, skipped })
      if ('outcome' in step) return step.outcome
    }
  }

  /** One attempt on `candidate`, and what it means for the request. */
  private async attempt(
    candidate: Candidate,
    request: CompletionRequest,
    state: RequestState,
    emit: (event: ClientEvent) => void,
    context: { sticky?: string; skipped: Skip[] },
  ): Promise<Step> {
    const { info, provider } = candidate
    const key = info.key
    // Selection and the probe claim happen without an await between them, so two requests never probe at once.
    if (candidate.probe && !this.health.startProbe(key)) {
      state.excluded.add(key)
      return NEXT
    }
    state.attempts++
    try {
      if (state.previousKey !== undefined && state.previousKey !== key) {
        const last = state.lastFailure
        emit({
          type: 'switch',
          from: state.previousKey,
          to: key,
          reason: failureOf(last ?? { kind: 'unavailable' }, last?.key ?? state.previousKey),
          ...(last ? { detail: last.message } : {}),
        })
      } else if (state.previousKey === undefined && context.sticky !== undefined && context.sticky !== key) {
        const skip = context.skipped.find((entry) => entry.key === context.sticky)
        if (skip) emit({ type: 'switch', from: context.sticky, to: key, reason: skipSentence(skip, this.skipKind(skip)), detail: skip.message })
      }
      state.previousKey = key
      emit({ type: 'attempt', attempt: state.attempts, key, provider: provider.id, model: info.model })

      let apiKey: string | undefined
      if (provider.needsKey) {
        const read = await this.readKey(provider, request.signal)
        if (request.signal.aborted) throw abortReason(request.signal)
        apiKey = read.key
        if (read.problem) this.log('warn', read.problem, key)
        if (!apiKey) {
          state.excluded.add(scopes.provider(provider.id))
          state.lastFailure = { key, kind: read.problem ? 'key-read' : 'no-key', message: redact(read.problem ?? `No key is set for ${provider.id}.`) }
          return NEXT
        }
      }

      const adapter = this.adapters.get(provider.type)
      if (!adapter) {
        state.excluded.add(key)
        return NEXT
      }
      // Selection judged the model before the key was read; the catalog or the settings may have changed since.
      const refusal = this.paidRefusal(provider, info.model)
      if (refusal) {
        this.log('warn', refusal, key)
        state.excluded.add(key)
        return NEXT
      }
      if (info.free) this.freeTier(provider.id)?.record()
      const target = this.target(candidate, apiKey)
      const result = await runAttempt({
        adapter,
        target,
        payload: request.payload,
        signal: request.signal,
        clock: this.clock,
        timing: this.timing(candidate),
        repairJson: this.repair,
        newId: this.options.newId,
        emit,
      })
      const secrets = apiKey ? [apiKey] : []
      return result.ok ? this.onReply(candidate, result, request, state, emit, secrets) : this.onFailure(candidate, result, request, state, emit, secrets)
    } finally {
      if (candidate.probe) this.health.endProbe(key)
    }
  }

  private target(candidate: Candidate, apiKey: string | undefined): TransportTarget {
    const { info, provider } = candidate
    return {
      key: info.key,
      provider: provider.id,
      providerType: provider.type,
      baseUrl: provider.baseUrl,
      model: info.model,
      family: info.family,
      ...(apiKey ? { apiKey } : {}),
      maxOutputTokens: candidate.maxOutputTokens,
      capabilities: info.capabilities,
      ...(candidate.serverFallbacks.length ? { serverFallbacks: candidate.serverFallbacks } : {}),
      ...(provider.type === 'openrouter' ? { dataCollection: this.config.freePool.dataCollection } : {}),
    }
  }

  private timing(candidate: Candidate) {
    const limits = this.config.limits
    const firstTokenMs = isLoopbackUrl(candidate.provider.baseUrl)
      ? limits.localFirstTokenMs
      : candidate.info.capabilities.reasoning
        ? limits.reasoningFirstTokenMs
        : limits.firstTokenMs
    return {
      firstTokenMs,
      keepaliveFirstTokenMs: Math.max(limits.keepaliveFirstTokenMs, firstTokenMs),
      idleMs: limits.idleMs,
      keepaliveIdleMs: Math.max(limits.keepaliveIdleMs, limits.idleMs),
    }
  }

  /** The key of the model that answered: OpenRouter names a server-side fallback in the stream. */
  private servedKey(candidate: Candidate, served: string | undefined): string {
    if (!served || served === candidate.info.model) return candidate.info.key
    const ids = [candidate.info.model, ...candidate.serverFallbacks]
    const match = ids.find((id) => id === served) ?? ids.find((id) => id === `${served}:free` || id.replace(/:free$/, '') === served)
    return match ? modelKey(candidate.provider.id, match) : candidate.info.key
  }

  /**
   * A model no catalog lists that OpenRouter answered as a listed one (a preset names its model only in its replies)
   * is described as that one from now on: its window, what it can read, its price (ADR 0117).
   */
  private learnServedBy(candidate: Candidate, served: string | undefined): void {
    const { provider, info } = candidate
    if (provider.type !== 'openrouter' || !served || served === info.model) return
    if (this.registry.listed(provider.id, info.model) || !this.registry.listed(provider.id, served)) return
    this.registry.learn(info.key, { servedBy: served })
  }

  // ---------------------------------------------------------------- replies

  private onReply(
    candidate: Candidate,
    result: Extract<AttemptResult, { ok: true }>,
    request: CompletionRequest,
    state: RequestState,
    emit: (event: ClientEvent) => void,
    secrets: string[],
  ): Step {
    const key = candidate.info.key
    const servedKey = this.servedKey(candidate, result.servedModel)
    this.checkBill(servedKey, result.reply.usage)
    const { reply, schemaErrors } = this.validate(result.reply, result.rawArguments, request.validateToolCall)
    const finish = reply.finish
    const normalEnd = finish !== 'length' && finish !== 'content_filter'
    // The assembler marks calls cut off by the output limit or a filter itself; any other invalid call had unreadable JSON.
    const unreadable = normalEnd && reply.message.content.some((block) => block.type === 'tool-use' && block.invalid && !schemaErrors.has(block.id))
    const empty = normalEnd && isEmptyReply(reply.message)

    if (!unreadable && !empty) {
      this.learnServedBy(candidate, result.servedModel)
      this.health.success(servedKey, { ttftMs: result.ttftMs })
      if (servedKey !== key) this.health.soft(key)
      if (candidate.fromPool && request.requirements.tools && reply.message.content.some((block) => block.type === 'tool-use' && !block.invalid)) {
        if (this.pool.canary(servedKey)?.status !== 'passed') this.pool.recordCanary(servedKey, 'passed')
      }
      if (request.sticky !== undefined) this.remember(request.sticky, servedKey)
      return { outcome: { kind: 'done', message: this.withOrigin(reply, candidate, servedKey), usage: reply.usage, finish } }
    }

    // A finished reply that cannot be used as it is: ask the same model once more, then another.
    const kind: FailureKind = unreadable ? 'tool-json' : 'empty'
    const message = unreadable ? `${candidate.info.model} wrote tool arguments that are not valid JSON.` : `${candidate.info.model} sent an empty reply.`
    if (result.streamed) emit({ type: 'discard', reason: message })
    state.fallback = { ...reply, message: this.withOrigin(reply, candidate, servedKey) }
    state.firstProblemAt ??= this.clock.now()
    state.lastFailure = { key, kind, message: redact(message, secrets) }
    this.health.soft(servedKey)
    const retryKey = `${key}:${kind}`
    if (!state.retried.has(retryKey)) {
      state.retried.add(retryKey)
      state.forceKey = key
      return NEXT
    }
    if (kind === 'tool-json' && candidate.fromPool) this.pool.recordCanary(servedKey, 'failed', message)
    state.excluded.add(key)
    return this.costly(state, request)
  }

  /**
   * A price is the provider's promise; the bill is what it did. When a model
   * listed as free was billed, the promise was wrong (or the listing was
   * misread): the model counts as paid from then on, so free-only mode never
   * sends it another request, and the user is told.
   */
  private checkBill(key: string, usage: { cost?: number } | undefined): void {
    const cost = usage?.cost
    if (cost === undefined || !Number.isFinite(cost) || cost <= 0) return
    const { provider, model } = splitKey(key)
    if (!this.registry.get(provider, model).free) return
    this.registry.learn(key, { free: false })
    const message = `${provider} billed $${Number(cost.toPrecision(2))} for a request to ${model}, which is listed as free. eNCode now treats ${model} as a paid model${this.config.freeOnly ? ' and will not use it' : ''}.`
    this.log('warn', message, key)
    this.alert({ type: 'billed', provider, model, cost, message })
  }

  /**
   * Applies the caller's schema check to the calls whose JSON parsed. A call
   * that fails it carries `invalid` with the model's raw arguments, and core
   * answers it so the model corrects itself; its id is returned so it is not
   * mistaken for JSON that could not be read, which is retried instead.
   */
  private validate(
    reply: AssembledReply,
    rawArguments: string[],
    validator: CompletionRequest['validateToolCall'],
  ): { reply: AssembledReply; schemaErrors: Set<string> } {
    const schemaErrors = new Set<string>()
    if (!validator) return { reply, schemaErrors }
    let index = 0
    const content = reply.message.content.map((block) => {
      if (block.type !== 'tool-use') return block
      const raw = rawArguments[index++] ?? JSON.stringify(block.input)
      if (block.invalid) return block
      let error: string | undefined
      try {
        error = validator(block.name, block.input)
      } catch (thrown) {
        error = `The arguments could not be checked: ${thrown instanceof Error ? thrown.message : String(thrown)}`
      }
      if (!error) return block
      schemaErrors.add(block.id)
      return { type: 'tool-use', id: block.id, name: block.name, input: {}, invalid: { raw, error } } satisfies ToolUseBlock
    })
    return { reply: { ...reply, message: { ...reply.message, content } }, schemaErrors }
  }

  /** The message's origin names the model that answered, with its own family. */
  private withOrigin(reply: AssembledReply, candidate: Candidate, servedKey: string): AssembledReply['message'] {
    if (servedKey === candidate.info.key) return reply.message
    const served = this.registry.get(candidate.provider.id, servedKey.slice(candidate.provider.id.length + 1))
    return { ...reply.message, origin: { provider: candidate.provider.id, model: served.model, family: served.family } }
  }

  private remember(session: string, key: string): void {
    this.sessions.delete(session)
    this.sessions.set(session, key)
    if (this.sessions.size > MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value as string)
  }

  // --------------------------------------------------------------- failures

  /** Counts a costly failure, and ends the request when its budget is spent. */
  private costly(state: RequestState, request: CompletionRequest): Step {
    state.costly++
    const limits = this.config.limits
    const elapsed = this.clock.now() - (state.firstProblemAt ?? state.startedAt)
    if (state.costly > limits.maxFailovers || elapsed >= limits.maxFailoverMs) {
      const { role, refs } = this.listOf(request, state)
      return { outcome: this.giveUp(state, role, refs, request.requirements) }
    }
    return NEXT
  }

  private block(scope: string, until: number, kind: string, reason: string): boolean {
    const fresh = !this.health.blocked(scope)
    this.health.block(scope, { until, kind, reason })
    return fresh
  }

  private onFailure(
    candidate: Candidate,
    result: Extract<AttemptResult, { ok: false }>,
    request: CompletionRequest,
    state: RequestState,
    emit: (event: ClientEvent) => void,
    secrets: string[],
  ): Step {
    const { info, provider } = candidate
    const key = info.key
    const { error } = result
    const now = this.clock.now()
    const message = redact(`${info.model}: ${error.message}`, secrets)
    if (result.streamed) emit({ type: 'discard', reason: message })
    state.firstProblemAt ??= now
    this.log('info', message, key)

    // This model, on this account: set it aside for long, and leave the key and the other models alone.
    const refusal = refusalOf(provider.type, error)
    if (refusal) {
      state.lastFailure = { key, kind: refusal.kind, message: this.refuse(key, refusal, error.message, secrets) }
      state.excluded.add(key)
      return NEXT
    }
    state.lastFailure = { key, kind: error.kind, message, retryAt: error.retryAt, ...(error.feature ? { feature: error.feature } : {}) }
    const openRouter = provider.type === 'openrouter'
    const account = error.scope === 'account' || (error.scope === undefined && !openRouter && (error.kind === 'quota' || error.kind === 'payment'))

    switch (error.kind) {
      case 'auth': {
        this.keys.invalidate?.(provider.id)
        const retryKey = `${provider.id}:token`
        if (error.code === 'token_expired' && !state.retried.has(retryKey)) {
          // An expired token: the next keys.get() refreshes it.
          state.retried.add(retryKey)
          state.forceKey = key
          return NEXT
        }
        const fresh = this.block(scopes.provider(provider.id), now + DEFAULT_BLOCK_MS.auth, 'auth', message)
        if (fresh) {
          this.alert(
            error.code === 'invalid_token' || error.code === 'token_expired'
              ? { type: 'sign-in', provider: provider.id, message: `Sign in to ${provider.id} again to keep using its models.`, detail: message }
              : { type: 'key-refused', provider: provider.id, message: failureOf({ kind: 'auth' }, key), detail: message },
          )
        }
        return NEXT
      }
      case 'payment': {
        const until = error.retryAt ?? now + DEFAULT_BLOCK_MS.payment
        // A negative balance stops free models too; otherwise only paid ones need money.
        const scope = info.free ? scopes.provider(provider.id) : scopes.paid(provider.id)
        if (this.block(scope, until, 'payment', message)) this.alert({ type: 'payment', provider: provider.id, message: failureOf({ kind: 'payment' }, key), detail: message, until })
        return NEXT
      }
      case 'quota': {
        if (!account) {
          this.health.unusable(key, { kind: 'quota', message, until: error.retryAt ?? now + DEFAULT_BLOCK_MS.quota })
          return NEXT
        }
        const tier = info.free ? this.freeTier(provider.id) : undefined
        const until = error.retryAt ?? (tier ? nextUtcMidnight(now) : now + DEFAULT_BLOCK_MS.quota)
        let fresh: boolean
        if (tier) {
          fresh = tier.closure()?.kind !== 'free-daily'
          tier.close({ until, kind: 'free-daily', reason: message })
        } else {
          fresh = this.block(scopes.provider(provider.id), until, 'quota', message)
        }
        if (fresh) this.alert({ type: 'quota', provider: provider.id, message: failureOf({ kind: tier ? 'free-daily' : 'quota' }, key), detail: message, until })
        return NEXT
      }
      case 'rate-limit': {
        if (!account) {
          this.health.rateLimited(key, { message, retryAt: error.retryAt })
          return NEXT
        }
        const tier = info.free ? this.freeTier(provider.id) : undefined
        if (tier) tier.close({ until: error.retryAt ?? now + DEFAULT_BLOCK_MS.freeMinute, kind: 'free-rpm', reason: message })
        else if (openRouter) this.block(scopes.paid(provider.id), error.retryAt ?? now + DEFAULT_BLOCK_MS.paidRateLimit, 'rate-limit', message)
        else this.block(scopes.provider(provider.id), error.retryAt ?? now + DEFAULT_BLOCK_MS.accountRateLimit, 'rate-limit', message)
        return NEXT
      }
      case 'context-overflow': {
        const retryKey = `${key}:overflow`
        if (error.used !== undefined) state.overflowUsed = Math.max(state.overflowUsed ?? 0, error.used)
        if (error.window !== undefined) {
          this.registry.learn(key, { contextWindow: error.window })
        } else {
          // The server did not say; the prompt plus the output budget did not fit, so the window is smaller than that.
          this.registry.learn(key, { contextWindow: (error.used ?? request.requirements.promptTokens) + candidate.maxOutputTokens })
        }
        if (state.retried.has(retryKey)) state.excluded.add(key)
        else state.retried.add(retryKey)
        return NEXT
      }
      case 'unsupported': {
        if (error.feature === 'documents') {
          // The documents' text goes instead, so the same model can take the call again, once.
          this.registry.learn(key, { documents: false })
          const retryKey = `${key}:documents`
          if (state.retried.has(retryKey)) state.excluded.add(key)
          else {
            state.retried.add(retryKey)
            state.forceKey = key
          }
          return NEXT
        }
        if (error.feature === 'tools') this.registry.learn(key, { tools: false })
        else if (error.feature === 'images') this.registry.learn(key, { images: false })
        else this.health.unusable(key, { kind: 'unsupported', message, until: now + DEFAULT_BLOCK_MS.unsupported })
        state.excluded.add(key)
        return NEXT
      }
      case 'not-found': {
        this.health.unusable(key, { kind: 'not-found', message, until: now + DEFAULT_BLOCK_MS.notFound })
        state.excluded.add(key)
        // The catalog has probably moved on; refresh it for the next request.
        if (candidate.fromPool) void this.refresh({ providers: [provider.id], force: true }).catch(() => undefined)
        return NEXT
      }
      case 'content-filter':
        // A safety system stopped the request. eNCode does not route around it to another model.
        return { outcome: { kind: 'paused', reason: 'refused', message: failureOf(error, key), detail: message } }
      case 'invalid-request': {
        this.health.soft(key)
        state.excluded.add(key)
        return NEXT
      }
      case 'network': {
        // The connection failed, not the model: hold the provider back briefly without touching model health.
        this.block(scopes.provider(provider.id), now + DEFAULT_BLOCK_MS.network, 'network', message)
        return this.costly(state, request)
      }
      case 'overloaded':
      case 'server':
      case 'timeout':
      case 'protocol': {
        const servedKey = this.servedKey(candidate, result.servedModel)
        this.health.failure(servedKey, { kind: error.kind, message, retryAt: error.retryAt })
        return this.costly(state, request)
      }
    }
  }

  // ------------------------------------------------------ nothing can run

  /** Nothing can take the call now: wait if that is short, else compact, commit a fallback or pause. */
  private async whenNothingRuns(state: RequestState, skipped: Skip[], request: CompletionRequest, emit: (event: ClientEvent) => void): Promise<Step> {
    const now = this.clock.now()
    const limits = this.config.limits
    const waitable = skipped.filter((skip) => skip.until !== undefined && skip.until > now && skip.reason !== 'tried')
    const earliest = waitable.length ? waitable.reduce((best, skip) => (skip.until! < best.until! ? skip : best)) : undefined
    const budgetEnd = (state.firstProblemAt ?? state.startedAt) + limits.maxFailoverMs
    const budgetLeft = state.costly <= limits.maxFailovers && state.attempts < limits.maxAttempts

    if (earliest && earliest.until! <= budgetEnd && budgetLeft) {
      state.firstProblemAt ??= now
      emit({ type: 'wait', until: earliest.until!, reason: skipSentence(earliest, this.skipKind(earliest)), detail: earliest.message })
      await sleep(this.clock, earliest.until! - now, request.signal)
      return NEXT
    }

    const tooSmall = skipped.filter((skip) => skip.reason === 'context' && skip.window !== undefined)
    if (tooSmall.length) {
      const window = Math.max(...tooSmall.map((skip) => skip.window!))
      const used = state.overflowUsed ?? request.requirements.promptTokens
      return { outcome: { kind: 'compact', window, ...(used ? { used } : {}) } }
    }
    const { role, refs } = this.listOf(request, state)
    return { outcome: this.giveUp(state, role, refs, request.requirements, skipped) }
  }

  /** The end of a request that cannot finish: a flawed reply if one arrived, else a pause saying why. */
  private giveUp(state: RequestState, role: string, refs: readonly string[], requirements: Requirements, skipped?: Skip[]): CompletionOutcome {
    if (state.fallback) return { kind: 'done', message: state.fallback.message, usage: state.fallback.usage, finish: state.fallback.finish }
    const now = this.clock.now()
    const skips = skipped ?? selectCandidates(this.selection, { role, refs, requirements }).skipped
    const future = skips.filter((skip) => skip.until !== undefined && skip.until > now)
    const retryAt = future.length ? Math.min(...future.map((skip) => skip.until!)) : undefined
    const { reason, message, detail } = this.pauseReason(state, role, refs, skips)
    return {
      kind: 'paused',
      reason,
      message,
      ...(detail ? { detail } : {}),
      ...(retryAt !== undefined ? { retryAt } : reason === 'unavailable' || reason === 'network' ? { retryAt: now + this.config.limits.cooldownMs } : {}),
    }
  }

  /**
   * Why a request cannot run, in one or two plain sentences, and the router's longer account of it as `detail`. Times
   * are left to the caller, which has `retryAt` and knows the person's clock.
   */
  private pauseReason(state: RequestState, role: string, refs: readonly string[], skips: Skip[]): { reason: PauseReason; message: string; detail?: string } {
    const now = this.clock.now()
    const last = state.lastFailure
    const kindReason = (kind: string): PauseReason => {
      switch (kind) {
        case 'auth':
        case 'payment':
        case 'quota':
        case 'rate-limit':
        case 'network':
          return kind
        case 'no-key':
        case 'key-read':
          return 'auth'
        case 'free-daily':
          return 'quota'
        case 'free-rpm':
          return 'rate-limit'
        case 'content-filter':
        case 'invalid-request':
          return 'refused'
        case 'not-found':
        case 'unsupported':
        case 'policy':
        case 'app-only':
        case 'forbidden':
        case 'server-tool':
          return 'no-model'
        default:
          return 'unavailable'
      }
    }
    const whom = roleText(role)
    if (last && state.attempts > 0) {
      // Models of the same provider fail for the same reason, which the sentence already says.
      const provider = parseModelRef(last.key)?.provider
      const others = skips.filter((skip) => skip.key !== last.key && parseModelRef(skip.key)?.provider !== provider)
      const rest = others.length ? ` The other models chosen for ${whom} cannot answer either.` : ''
      const detail = [last.message, ...others.map((skip) => `${skip.key}: ${skip.message}`)].join('\n')
      return { reason: kindReason(last.kind), message: `${failureOf(last, last.key)}${rest}`, detail }
    }
    const blocking = skips.filter((skip) => skip.until !== undefined && skip.until > now).sort((a, b) => a.until! - b.until!)[0]
    if (blocking) {
      const kind = this.skipKind(blocking)
      return { reason: kindReason(kind ?? 'unavailable'), message: skipSentence(blocking, kind), detail: blocking.message }
    }
    // Models that free-only mode refused are not what stopped the call, unless they are all there is.
    const rest = skips.filter((skip) => skip.reason !== 'not-free')
    const detail = skips.length ? skips.map((skip) => `${skip.key}: ${skip.message}`).join('\n') : undefined
    const withDetail = (reason: PauseReason, message: string) => ({ reason, message, ...(detail ? { detail } : {}) })
    if (!rest.length) {
      const pooled = refs.includes(FREE_POOL)
      const missing = pooled ? this.config.freePool.providers.filter((id) => this.registry.catalogFetchedAt(id) === undefined) : []
      if (missing.length) return withDetail('unavailable', `The list of free models from ${missing.join(', ')} has not loaded yet. Check the connection.`)
      if (skips.length) {
        return withDetail(
          'no-model',
          pooled
            ? 'Only free models are allowed, and none is available right now.'
            : `Only free models are allowed, and none of the models chosen for ${whom} is free. Choose free models for it in Settings, or turn off free-only mode.`,
        )
      }
      return withDetail('no-model', pooled ? `The free models have nothing for ${whom} right now.` : `No model is chosen for ${whom}.`)
    }
    const noKey = [...new Set(rest.filter((skip) => skip.reason === 'no-key').map((skip) => parseModelRef(skip.key)?.provider ?? skip.key))]
    if (noKey.length && rest.every((skip) => skip.reason === 'no-key' || skip.reason === 'no-adapter' || skip.reason === 'tried')) {
      return withDetail('no-model', `Add an API key for ${noKey.join(' and ')} to use the models chosen for ${whom}.`)
    }
    if (rest.some((skip) => skip.reason === 'tools')) return withDetail('no-model', `None of the models chosen for ${whom} that are ready can use tools.`)
    if (rest.some((skip) => skip.reason === 'images')) return withDetail('no-model', `None of the models chosen for ${whom} that are ready can read images.`)
    return withDetail('no-model', `None of the models chosen for ${whom} can take this request.`)
  }

  /** The kind of block behind a skip that waits (a provider held back, a free tier closed), for the words that tell it. */
  private skipKind(skip: Skip): string | undefined {
    if (skip.reason === 'free-closed') return this.closureKind(skip)
    if (skip.reason === 'provider-blocked' || skip.reason === 'paid-blocked' || skip.reason === 'pacing' || skip.reason === 'cooling') return this.blockKind(skip)
    return undefined
  }

  private closureKind(skip: Skip): string {
    const provider = parseModelRef(skip.key)?.provider
    return (provider && this.freeTier(provider)?.closure()?.kind) || 'free-rpm'
  }

  private blockKind(skip: Skip): string {
    const provider = parseModelRef(skip.key)?.provider
    if (!provider) return 'unavailable'
    if (skip.reason === 'provider-blocked') return this.health.blocked(scopes.provider(provider))?.kind ?? 'unavailable'
    if (skip.reason === 'paid-blocked') return this.health.blocked(scopes.paid(provider))?.kind ?? 'payment'
    if (skip.reason === 'pacing') return 'free-rpm'
    if (skip.reason === 'cooling') return this.health.report().models.find((model) => model.key === skip.key)?.lastFailure?.kind ?? 'unavailable'
    return 'unavailable'
  }

  // ----------------------------------------------------------------- budget

  async budget(role: ModelRole, query: BudgetQuery = {}): Promise<ModelBudget> {
    return this.budgetOn(role, query)
  }

  private async budgetOn(role: ModelRole, query: BudgetQuery = {}, pin?: string): Promise<ModelBudget> {
    const { role: resolved, refs } = pin !== undefined ? { role, refs: [pin] } : resolveModelList(this.config, { role, tool: query.tool, agent: query.agent })
    const sticky = query.sticky !== undefined ? this.sessions.get(query.sticky) : undefined
    const ready = (images: boolean) => {
      const requirements: Requirements = { promptTokens: 0, maxOutputTokens: 1, tools: false, images }
      return selectCandidates(this.selection, { role: resolved, refs, requirements, sticky }).candidates[0]?.info
    }
    // A request with pictures goes to a model that reads them, as `complete` sends it, while one is ready; else to the first.
    const first = (query.images ? ready(true) : undefined) ?? ready(false)
    if (first) return budgetOf(first)
    // Nothing runs now: the best guess is the role's first model, available or not.
    for (const ref of refs) {
      const parsed = ref === FREE_POOL ? undefined : parseModelRef(ref)
      if (parsed && this.config.providers[parsed.provider]) {
        const info = this.registry.get(parsed.provider, parsed.model)
        // A model that free-only mode refuses will never run, so it is no guess at what will.
        if (this.config.freeOnly && !info.free) continue
        return budgetOf(info)
      }
      if (ref === FREE_POOL) {
        for (const id of this.config.freePool.providers) {
          const member = this.pool.members(id, resolved, this.config.freePool, sticky)[0]
          if (member) return budgetOf(member)
        }
      }
    }
    return { model: FREE_POOL, contextWindow: this.config.freePool.minContextWindow || 32_000, maxOutputTokens: 8_192 }
  }

  // ---------------------------------------------------------------- catalogs

  /** Providers whose catalog matters to these refs: the pool's, and OpenRouter ones named directly. */
  private catalogProviders(refs: readonly string[]): string[] {
    const ids = new Set<string>()
    for (const ref of refs) {
      if (ref === FREE_POOL) {
        for (const id of this.config.freePool.providers) ids.add(id)
        continue
      }
      const parsed = parseModelRef(ref)
      if (parsed && this.config.providers[parsed.provider]?.type === 'openrouter') ids.add(parsed.provider)
    }
    return [...ids]
  }

  /** Makes sure the catalogs a request needs exist, waiting briefly for a missing one and refreshing stale ones in the background. */
  private async ensureCatalogs(refs: readonly string[], signal: AbortSignal): Promise<void> {
    if (!this.fetchImpl) return
    const now = this.clock.now()
    const missing: string[] = []
    for (const id of this.catalogProviders(refs)) {
      const fetchedAt = this.registry.catalogFetchedAt(id)
      if (fetchedAt === undefined) {
        if (this.canList(id)) missing.push(id)
      } else if (now - fetchedAt > CATALOG_MAX_AGE_MS || this.quotaStale(id, now)) {
        void this.refresh({ providers: [id] }).catch(() => undefined)
      }
    }
    if (!missing.length) return
    const sync = this.refresh({ providers: missing, signal }).catch(() => undefined)
    let timer: unknown
    let onAbort: (() => void) | undefined
    await Promise.race([
      sync,
      new Promise<void>((resolve) => {
        timer = this.clock.setTimeout(resolve, CATALOG_WAIT_MS)
      }),
      new Promise<void>((resolve) => {
        onAbort = resolve
        signal.addEventListener('abort', onAbort, { once: true })
      }),
    ])
    this.clock.clearTimeout(timer)
    if (onAbort) signal.removeEventListener('abort', onAbort)
    if (signal.aborted) throw abortReason(signal)
  }

  private quotaStale(provider: string, now: number): boolean {
    if (this.config.providers[provider]?.type !== 'openrouter' || !this.keys.has(provider)) return false
    const at = this.quotaFetchedAt.get(provider)
    return at === undefined || now - at > QUOTA_MAX_AGE_MS
  }

  /** Whether a provider's models can be listed: OpenRouter's catalog is public, others need their key unless local. */
  private canList(provider: string): boolean {
    const config = this.config.providers[provider]
    if (!config) return false
    return config.type === 'openrouter' || !config.needsKey || this.keys.has(provider)
  }

  /**
   * Syncs model catalogs and OpenRouter's free quota. One sync per provider
   * runs at a time; failures are reported in status() and as an alert, never
   * thrown, and the last good catalog stays in use.
   */
  async refresh(options: RefreshOptions = {}): Promise<void> {
    const ids = options.providers ?? Object.keys(this.config.providers).filter((id) => this.canList(id))
    await Promise.all(
      ids.map((id) => {
        const running = this.syncing.get(id)
        if (running) return running
        const now = this.clock.now()
        const fetchedAt = this.registry.catalogFetchedAt(id)
        if (!options.force && fetchedAt !== undefined && now - fetchedAt <= CATALOG_MAX_AGE_MS && !this.quotaStale(id, now)) return undefined
        const sync = this.sync(id, options.signal, options.force).finally(() => this.syncing.delete(id))
        this.syncing.set(id, sync)
        return sync
      }),
    )
  }

  private async sync(id: string, signal: AbortSignal | undefined, force = false): Promise<void> {
    const provider: ProviderConfig | undefined = this.config.providers[id]
    const fetchImpl = this.fetchImpl
    if (!provider || !fetchImpl) return
    const fetchedAt = this.registry.catalogFetchedAt(id)
    const age = fetchedAt === undefined ? Number.POSITIVE_INFINITY : this.clock.now() - fetchedAt
    if (age > CATALOG_MAX_AGE_MS || this.syncErrors.has(id) || (force && age >= CATALOG_MIN_INTERVAL_MS)) {
      try {
        let models: CatalogEntry[]
        if (provider.type === 'openrouter') {
          models = await fetchOpenRouterCatalog({ fetch: fetchImpl, baseUrl: provider.baseUrl, signal })
          if (!models.length) throw new Error('The model catalog was empty.')
          // An empty pool with no explanation would look like a bug: say what the free check saw.
          const named = models.filter((model) => model.model.endsWith(':free')).length
          if (named && !models.some((model) => model.free)) {
            this.log('warn', `${id} lists ${named} ${named === 1 ? 'model' : 'models'} with a :free id, but none passed the free check, so the free pool is empty. Run scripts/free-models.mjs to see each price.`)
          }
        } else {
          const read = provider.needsKey ? await this.readKey(provider, signal) : {}
          if (read.problem) this.log('warn', read.problem)
          if (provider.needsKey && !read.key) return
          models = await fetchModelList({ fetch: fetchImpl, provider, apiKey: read.key, signal })
        }
        this.registry.setCatalog(id, models, this.clock.now())
        this.syncErrors.delete(id)
      } catch (error) {
        if (signal?.aborted) return
        const detail = redact(`Could not load the model list from ${id}: ${error instanceof Error ? error.message : String(error)}`)
        const message = `eNCode could not load the list of models from ${id}.`
        const known = this.syncErrors.has(id)
        this.syncErrors.set(id, message)
        this.log('warn', detail)
        if (!known) this.alert({ type: 'catalog', provider: id, message, detail })
        return
      }
    }
    if (provider.type === 'openrouter' && (force ? this.keys.has(id) : this.quotaStale(id, this.clock.now()))) await this.syncQuota(provider, fetchImpl, signal)
  }

  /** Reads OpenRouter's count of the key's free requests. A failure only waits for the next read: the tier keeps its own count. */
  private async syncQuota(provider: ProviderConfig, fetchImpl: Fetch, signal: AbortSignal | undefined): Promise<void> {
    let apiKey: string | undefined
    try {
      const read = await this.readKey(provider, signal)
      if (read.problem) this.log('warn', read.problem)
      apiKey = read.key
      if (!apiKey) return
      const quota = await fetchFreeQuota({ fetch: fetchImpl, baseUrl: provider.baseUrl, apiKey, now: this.clock.now(), signal })
      if (quota) this.freeTier(provider.id)?.applyQuota(quota)
    } catch (error) {
      if (signal?.aborted) return
      this.log('warn', redact(`Could not read the free-request quota from ${provider.id}: ${error instanceof Error ? error.message : String(error)}`, apiKey ? [apiKey] : []))
    }
    this.quotaFetchedAt.set(provider.id, this.clock.now())
  }

  // ------------------------------------------------------------------ checks

  /**
   * Tests one model with a tiny tool call, for the Settings page's Test
   * button and as the free pool's canary. Health and the canary record are
   * updated with the result; the free tier counts the request.
   */
  async checkModel(ref: string, options: { signal?: AbortSignal } = {}): Promise<CheckResult> {
    const parsed = parseModelRef(ref)
    const provider = parsed ? this.config.providers[parsed.provider] : undefined
    const key = parsed ? modelKey(parsed.provider, parsed.model) : ref
    if (!parsed || !provider) return { ok: false, key, toolCall: false, message: `"${ref}" does not name a configured provider's model.` }
    const adapter = this.adapters.get(provider.type)
    if (!adapter) return { ok: false, key, toolCall: false, message: `No adapter speaks ${provider.type}.` }
    const early = this.paidRefusal(provider, parsed.model)
    if (early) return { ok: false, key, toolCall: false, message: early }
    const signal = options.signal ?? new AbortController().signal
    const read = provider.needsKey ? await this.readKey(provider, signal) : {}
    if (signal.aborted) throw abortReason(signal)
    const apiKey = read.key
    if (provider.needsKey && !apiKey) return { ok: false, key, toolCall: false, message: redact(read.problem ?? `No key is set for ${provider.id}.`) }
    // The registry may have changed while the key was read.
    const late = this.paidRefusal(provider, parsed.model)
    if (late) return { ok: false, key, toolCall: false, message: late }
    const info = this.registry.get(parsed.provider, parsed.model)
    const payload: ModelRequest = {
      system: [{ text: 'You are checking a connection. Call the tool you are given exactly once, and say nothing else.' }],
      messages: [userText('Call the echo tool with the text "eNCode".')],
      tools: [
        {
          name: 'echo',
          description: 'Echoes the given text back.',
          inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
        },
      ],
      maxOutputTokens: 512,
    }
    const candidate: Candidate = { info, provider, fromPool: false, probe: false, delayMs: 0, maxOutputTokens: Math.min(512, info.maxOutputTokens), serverFallbacks: [] }
    if (info.free) this.freeTier(provider.id)?.record()
    const result = await runAttempt({
      adapter,
      target: this.target(candidate, apiKey),
      payload,
      signal,
      clock: this.clock,
      timing: this.timing(candidate),
      repairJson: this.repair,
      newId: this.options.newId,
      emit: () => undefined,
    })
    const secrets = apiKey ? [apiKey] : []
    if (!result.ok) {
      const { error } = result
      const detail = redact(error.message, secrets)
      const refusal = refusalOf(provider.type, error)
      if (refusal) return { ok: false, key, toolCall: false, blocked: refusal.kind, message: this.refuse(key, refusal, error.message, secrets), detail }
      if (error.kind === 'server' || error.kind === 'overloaded' || error.kind === 'timeout' || error.kind === 'protocol') {
        this.health.failure(key, { kind: error.kind, message: detail, retryAt: error.retryAt })
      }
      return { ok: false, key, toolCall: false, message: failureOf({ kind: error.kind, ...(error.feature ? { feature: error.feature } : {}) }, key), detail }
    }
    const call = result.reply.message.content.find((block): block is ToolUseBlock => block.type === 'tool-use')
    const toolCall = Boolean(call && !call.invalid && call.name === 'echo' && typeof call.input.text === 'string')
    this.health.success(key, { ttftMs: result.ttftMs })
    this.checkBill(key, result.reply.usage)
    if (info.free) this.pool.recordCanary(key, toolCall ? 'passed' : 'failed', toolCall ? undefined : 'did not make a valid tool call')
    return {
      ok: true,
      key,
      model: result.reply.message.origin?.model ?? info.model,
      ...(result.ttftMs !== undefined ? { ttftMs: result.ttftMs } : {}),
      ...(result.reply.usage.cost !== undefined ? { cost: result.reply.usage.cost } : {}),
      toolCall,
      message: toolCall ? 'The model answered and called a tool correctly.' : 'The model answered but did not call the tool correctly.',
    }
  }

  /**
   * Runs the canary on a few free models that nothing has vouched for lately,
   * for the host to call while the app is idle. Canaries spend free requests,
   * so they run only while OpenRouter reports a daily allowance with plenty to
   * spare; on a 50-a-day account the pool learns from real calls instead.
   */
  async runCanaries(options: { limit?: number; signal?: AbortSignal } = {}): Promise<CheckResult[]> {
    const results: CheckResult[] = []
    let left = Math.max(0, Math.floor(options.limit ?? 3))
    for (const id of this.config.freePool.providers) {
      const tier = this.freeTier(id)
      if (!tier || !this.keys.has(id)) continue
      for (const model of this.pool.unchecked(id, this.config.freePool, left)) {
        const remaining = tier.remaining()
        if (left <= 0 || options.signal?.aborted || tier.closure() || tier.delay() > 0 || remaining === undefined || remaining < CANARY_RESERVE) break
        if (!this.health.availability(model.key).available || this.health.blocked(scopes.provider(id))) continue
        results.push(await this.checkModel(model.key, options.signal ? { signal: options.signal } : {}))
        left--
      }
    }
    return results
  }

  // ------------------------------------------------------------ state, status

  status(): RouterStatus {
    const report = this.health.report()
    return {
      freeOnly: this.config.freeOnly,
      models: report.models,
      blocks: report.scopes,
      freeTiers: [...this.tiers.values()].map((tier) => tier.status()),
      catalogs: Object.keys(this.config.providers).map((provider) => {
        const models = this.registry.list(provider)
        const fetchedAt = this.registry.catalogFetchedAt(provider)
        const error = this.syncErrors.get(provider)
        return {
          provider,
          ...(fetchedAt !== undefined ? { fetchedAt } : {}),
          models: models.length,
          free: models.filter((model) => model.free).length,
          ...(error ? { error } : {}),
        }
      }),
    }
  }

  /** Everything worth keeping across restarts: catalogs, learned facts, health, canaries and free-tier counts. */
  snapshot(): RouterSnapshot {
    return {
      version: 1,
      registry: this.registry.snapshot(),
      health: this.health.snapshot(),
      pool: this.pool.snapshot(),
      freeTiers: Object.fromEntries([...this.tiers].map(([id, tier]) => [id, tier.snapshot()])),
    }
  }

  /** Restores a snapshot from disk. Anything malformed is skipped. */
  restore(snapshot: unknown): void {
    if (!snapshot || typeof snapshot !== 'object' || (snapshot as RouterSnapshot).version !== 1) return
    const { registry, health, pool, freeTiers } = snapshot as RouterSnapshot
    this.registry.restore(registry)
    this.health.restore(health)
    this.pool.restore(pool)
    if (freeTiers && typeof freeTiers === 'object') {
      for (const [id, tier] of Object.entries(freeTiers)) this.freeTier(id)?.restore(tier)
    }
  }
}

export function createRouter(options: RouterOptions): ModelRouter {
  return new ModelRouter(options)
}
