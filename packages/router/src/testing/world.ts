import { messageText, userText, type ClientEvent, type CompletionOutcome, type CompletionRequest, type ProviderType } from '@encode/providers'
import { parseRouterConfig } from '../config'
import { staticKeys, type KeySource } from '../keys'
import type { CatalogEntry } from '../registry'
import { ModelRouter, type RouterAlert, type RouterOptions } from '../router'
import { FakeClock } from './fake-clock'
import { faults, ScriptedAdapter, type AdapterCall, type Script } from './scripted'

/**
 * A router wired to scripted adapters on a fake clock: what the router's own
 * tests, and integration tests elsewhere, need to run requests against
 * misbehaving providers without a network or real time.
 */

/** A model's behavior: one script for every call, one per call (the last repeats), or a function of the call number. */
export type ModelBehavior = Script | readonly Script[] | ((call: number) => Script)

export interface TestWorldOptions {
  /** Router settings as a user would write them. Default: OpenRouter, with `@free` for every role. */
  settings?: unknown
  /** Catalogs by provider id, set before any request. */
  catalogs?: Record<string, CatalogEntry[]>
  /** Behavior by model id. A model without one answers cleanly with its own name. */
  behavior?: Record<string, ModelBehavior>
  /** Keys by provider id, or a KeySource. Default: a key for openrouter. */
  keys?: Record<string, string> | KeySource
  /** Default null: nothing is synced over the network. */
  fetch?: RouterOptions['fetch']
  router?: Partial<Pick<RouterOptions, 'repairJson' | 'newId' | 'onLog' | 'onTrace'>>
}

function isSequence(behavior: ModelBehavior): behavior is readonly Script[] {
  return Array.isArray(behavior) && behavior.length > 0 && Array.isArray(behavior[0])
}

/** A catalog entry for tests: a tool-capable 128k model, free when its id ends in `:free`. */
export function catalogEntry(model: string, extra: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    model,
    name: model,
    family: 'other',
    contextWindow: 131_072,
    maxOutputTokens: 16_384,
    capabilities: { tools: true, parallelTools: true, images: false, reasoning: false, promptCache: false },
    editFormat: 'replace',
    price: model.endsWith(':free') ? { input: 0, output: 0 } : { input: 1, output: 4 },
    free: model.endsWith(':free'),
    ...extra,
  }
}

export class TestWorld {
  readonly clock = new FakeClock()
  readonly calls: AdapterCall[] = []
  readonly alerts: RouterAlert[] = []
  readonly router: ModelRouter
  behavior: Record<string, ModelBehavior>

  constructor(options: TestWorldOptions = {}) {
    this.behavior = { ...options.behavior }
    const perModel = new Map<string, number>()
    const scripter = (target: { model: string }, call: { forModel: number }): Script => {
      const behavior = Object.hasOwn(this.behavior, target.model) ? this.behavior[target.model] : undefined
      if (behavior === undefined) return faults.reply(`hello from ${target.model}`)
      if (typeof behavior === 'function') return behavior(call.forModel)
      if (isSequence(behavior)) return behavior[Math.min(call.forModel, behavior.length - 1)]
      return behavior as Script
    }
    const types: ProviderType[] = ['openai-compatible', 'openrouter', 'anthropic']
    const adapters = types.map((type) => new ScriptedAdapter(type, this.clock, scripter, this.calls, perModel))
    const settings = options.settings ?? { providers: { openrouter: { type: 'openrouter' } } }
    const { config, problems } = parseRouterConfig(settings)
    if (problems.length) throw new Error(`Test settings have problems: ${JSON.stringify(problems)}`)
    const keys = options.keys === undefined ? staticKeys({ openrouter: 'sk-or-v1-test-key-0123456789' }) : 'has' in options.keys ? (options.keys as KeySource) : staticKeys(options.keys as Record<string, string>)
    this.router = new ModelRouter({
      config,
      adapters,
      keys,
      clock: this.clock,
      fetch: options.fetch === undefined ? null : options.fetch,
      onAlert: (alert) => this.alerts.push(alert),
      ...options.router,
    })
    for (const [provider, entries] of Object.entries(options.catalogs ?? {})) this.router.registry.setCatalog(provider, entries, this.clock.now())
  }

  /** Runs one request to its outcome on the fake clock, with every event it emitted. */
  async complete(overrides: Partial<CompletionRequest> = {}): Promise<{ outcome: CompletionOutcome; events: ClientEvent[]; text: string }> {
    const events: ClientEvent[] = []
    const request: CompletionRequest = {
      role: 'main',
      payload: { system: [{ text: 'You are eNCode.' }], messages: [userText('Say hello.')], tools: [] },
      requirements: { promptTokens: 1_000, maxOutputTokens: 4_096, tools: false, images: false },
      signal: new AbortController().signal,
      ...overrides,
      onEvent: (event) => {
        events.push(event)
        overrides.onEvent?.(event)
      },
    }
    const outcome = await this.clock.run(this.router.complete(request))
    return { outcome, events, text: outcome.kind === 'done' ? messageText(outcome.message) : '' }
  }

  /** The calls one model received. */
  callsTo(model: string): AdapterCall[] {
    return this.calls.filter((call) => call.model === model)
  }
}
