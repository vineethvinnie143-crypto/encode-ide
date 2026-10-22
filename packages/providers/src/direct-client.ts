/**
 * DirectClient: a ModelClient with one model per role and no failover. It
 * is what runs before the router (M2) lands, and what the CLI uses when told
 * to call one model directly.
 *
 * Within that one model it is patient: transient failures (a dropped
 * connection, a 5xx, a short rate limit) are retried before the first byte
 * and after a dead stream, with backoff, and an empty reply gets a second
 * chance. A rate limit or an overloaded provider gets longer, because waiting
 * is what clears it; a quota, a bad key or a model that is gone does not wait.
 * Everything it cannot fix ends as a `compact` or `paused` outcome.
 */
import { createAssembler, type AssembledReply } from './assembler'
import { createAnthropicAdapter } from './anthropic'
import type {
  BudgetQuery,
  ClientEvent,
  CompletionOutcome,
  CompletionRequest,
  ModelBudget,
  ModelClient,
  ModelRole,
  PauseReason,
  ProviderAdapter,
  ProviderType,
  TransportTarget,
} from './contract'
import { isTransportError, TransportError } from './errors'
import { repairJson } from './json-repair'
import { isEmptyReply } from './messages'
import { modelInfo, providerTypeFor } from './models'
import { createOpenAICompatibleAdapter, createOpenRouterAdapter } from './openai'

export interface DirectRoute {
  target: TransportTarget
  contextWindow: number
}

/** A provider as a user configures it: enough to build a route. */
export interface ProviderProfile {
  /** The profile's id; keys are bound to it. */
  provider: string
  providerType?: ProviderType
  baseUrl: string
  model: string
  apiKey?: string
  contextWindow?: number
  maxOutputTokens?: number
  dataCollection?: 'allow' | 'deny'
}

/** A route for a configured provider, filling in what the model table knows. */
export function routeFor(profile: ProviderProfile): DirectRoute {
  const info = modelInfo(profile.model)
  return {
    target: {
      key: `${profile.provider}:${profile.model}`,
      provider: profile.provider,
      providerType: providerTypeFor(profile.baseUrl, profile.providerType),
      baseUrl: profile.baseUrl,
      model: profile.model,
      family: info.family,
      ...(profile.apiKey ? { apiKey: profile.apiKey } : {}),
      maxOutputTokens: profile.maxOutputTokens ?? info.maxOutputTokens,
      capabilities: info.capabilities,
      ...(profile.dataCollection ? { dataCollection: profile.dataCollection } : {}),
    },
    contextWindow: profile.contextWindow ?? info.contextWindow,
  }
}

export interface DirectClientOptions {
  /** The model for a role. */
  route(role: ModelRole, query: BudgetQuery): DirectRoute | Promise<DirectRoute>
  adapters?: Partial<Record<ProviderType, ProviderAdapter>>
  /** Attempts per call, the first included. Default 3. */
  attempts?: number
  /** Attempts for a rate limit or an overloaded provider, which clear by waiting. Default 6: about half a minute of growing pauses. */
  patientAttempts?: number
  /** Silence after which an attempt is abandoned, in ms. Default 120 s. */
  idleTimeoutMs?: number
  /** The longest rate-limit wait sat out; a longer one pauses instead. Default 60 s. */
  maxWaitMs?: number
  /** Repairs malformed tool JSON. Default: json-repair's, which never completes a truncated value. */
  repairJson?: (raw: string) => unknown
  now?: () => number
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

export interface DirectClient extends ModelClient {
  /** A smaller window learned from an overflow, if any. */
  learnedWindow(key: string): number | undefined
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Yields from `source`, aborting `controller` when nothing arrives for `ms`. */
async function* withIdleTimeout<T>(source: AsyncIterable<T>, controller: AbortController, ms: number): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]()
  let finished = false
  try {
    while (true) {
      const timer = setTimeout(() => controller.abort(new TransportError('timeout', `The model sent nothing for ${Math.round(ms / 1000)} s.`)), ms)
      let next: IteratorResult<T>
      try {
        next = await iterator.next()
      } catch (error) {
        finished = true
        throw error
      } finally {
        clearTimeout(timer)
      }
      if (next.done) {
        finished = true
        return
      }
      yield next.value
    }
  } finally {
    if (!finished) await iterator.return?.()
  }
}

const PAUSE_FOR: Partial<Record<TransportError['kind'], PauseReason>> = {
  auth: 'auth',
  payment: 'payment',
  quota: 'quota',
  'rate-limit': 'rate-limit',
  network: 'network',
  timeout: 'network',
  'not-found': 'no-model',
  'content-filter': 'refused',
}

const RETRYABLE = new Set<TransportError['kind']>(['rate-limit', 'overloaded', 'server', 'timeout', 'network', 'protocol'])

export function createDirectClient(options: DirectClientOptions): DirectClient {
  const adapters: Partial<Record<ProviderType, ProviderAdapter>> = {
    'openai-compatible': createOpenAICompatibleAdapter(),
    openrouter: createOpenRouterAdapter(),
    anthropic: createAnthropicAdapter(),
    ...options.adapters,
  }
  const attempts = Math.max(1, options.attempts ?? 3)
  const patientAttempts = Math.max(attempts, options.patientAttempts ?? 6)
  const idleTimeoutMs = options.idleTimeoutMs ?? 120_000
  const maxWaitMs = options.maxWaitMs ?? 60_000
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? abortableSleep
  const learned = new Map<string, number>()

  const windowOf = (route: DirectRoute) => Math.min(route.contextWindow, learned.get(route.target.key) ?? Infinity)

  async function budget(role: ModelRole, query: BudgetQuery = {}): Promise<ModelBudget> {
    const route = await options.route(role, query)
    return { model: route.target.model, contextWindow: windowOf(route), maxOutputTokens: route.target.maxOutputTokens }
  }

  async function complete(request: CompletionRequest): Promise<CompletionOutcome> {
    const { signal } = request
    if (signal.aborted) throw signal.reason
    const emit = (event: ClientEvent) => request.onEvent?.(event)
    const route = await options.route(request.role, { sticky: request.sticky, tool: request.tool, agent: request.agent })
    const { target } = route
    const adapter = adapters[target.providerType]
    if (!adapter) return { kind: 'paused', reason: 'unavailable', message: `No adapter speaks ${target.providerType}.` }
    let emptyRetried = false

    for (let attempt = 1; ; attempt++) {
      emit({ type: 'attempt', attempt, key: target.key, provider: target.provider, model: target.model })
      const assembler = createAssembler({
        origin: { provider: target.provider, model: target.model, family: target.family },
        validateToolCall: request.validateToolCall,
        repairJson: options.repairJson ?? repairJson,
      })
      const controller = new AbortController()
      const onAbort = () => controller.abort(signal.reason)
      signal.addEventListener('abort', onAbort, { once: true })
      let reply: AssembledReply | undefined
      let failure: TransportError | undefined
      try {
        for await (const event of withIdleTimeout(adapter.stream({ target, request: request.payload, signal: controller.signal }), controller, idleTimeoutMs)) {
          assembler.push(event)
          if (event.type === 'text' || event.type === 'thinking') {
            if (event.text) emit({ type: event.type, text: event.text })
          } else if (event.type === 'tool-call') {
            emit(event)
          }
        }
        reply = assembler.finish()
      } catch (error) {
        if (signal.aborted) throw signal.reason
        failure = isTransportError(error) ? error : new TransportError('protocol', error instanceof Error ? error.message : String(error), { cause: error })
      } finally {
        signal.removeEventListener('abort', onAbort)
      }

      if (reply) {
        if (isEmptyReply(reply.message) && reply.finish === 'stop' && !emptyRetried && attempt < attempts) {
          emptyRetried = true
          emit({ type: 'discard', reason: 'The model sent an empty reply.' })
          continue
        }
        return { kind: 'done', message: reply.message, usage: reply.usage, finish: reply.finish }
      }

      const error = failure!
      if (assembler.snapshot().received) emit({ type: 'discard', reason: error.message })
      if (error.kind === 'context-overflow') {
        const window = error.window ?? Math.floor(Math.min(windowOf(route), error.used ?? request.requirements.promptTokens) * 0.75)
        learned.set(target.key, Math.min(window, learned.get(target.key) ?? Infinity))
        return { kind: 'compact', window, ...(error.used !== undefined ? { used: error.used } : {}) }
      }
      const describe = (reason: PauseReason, retryAt?: number): CompletionOutcome => ({
        kind: 'paused',
        reason,
        message: `${target.model} on ${target.provider}: ${error.message}`,
        ...(retryAt !== undefined ? { retryAt } : {}),
      })
      if (!RETRYABLE.has(error.kind)) return describe(PAUSE_FOR[error.kind] ?? 'unavailable', error.retryAt)
      const wait = error.retryAt !== undefined ? Math.max(0, error.retryAt - now()) : Math.min(maxWaitMs, 1000 * 2 ** (attempt - 1))
      const limit = error.kind === 'rate-limit' || error.kind === 'overloaded' ? patientAttempts : attempts
      if (attempt >= limit || wait > maxWaitMs) return describe(PAUSE_FOR[error.kind] ?? 'unavailable', error.retryAt)
      if (wait > 0) {
        emit({ type: 'wait', until: now() + wait, reason: error.message })
        await sleep(wait, signal)
      }
    }
  }

  return { complete, budget, learnedWindow: (key) => learned.get(key) }
}
