/**
 * The model client for one configured profile: the offline demo agent, a
 * model called directly, or a plain "nothing is set up yet". The router
 * (when one is wired in) replaces this; the session only ever sees the
 * ModelClient contract.
 */
import {
  createDirectClient,
  routeFor,
  type BudgetQuery,
  type CompletionOutcome,
  type CompletionRequest,
  type DirectClientOptions,
  type ModelBudget,
  type ModelClient,
  type ModelRole,
} from '@encode/providers'
import { createDemoClient } from './demo'

export interface ProfileConfig {
  id: string
  /** 'demo' is the offline agent; 'openrouter' names the provider type; 'custom' is told from its address. */
  kind: 'custom' | 'openrouter' | 'demo'
  baseUrl: string
  model: string
  contextWindow?: number
  maxOutputTokens?: number
}

export interface ProfileClientOptions {
  /** The profile in use now, read at every call so a change applies to the next one. */
  profile(): ProfileConfig | null
  /** A profile's key, asked for at every call so that it does not rest in memory here. */
  apiKey?(profileId: string): Promise<string | undefined> | string | undefined
  demo?: ModelClient
  direct?: Pick<DirectClientOptions, 'adapters' | 'attempts' | 'idleTimeoutMs' | 'maxWaitMs' | 'now' | 'sleep'>
}

export const NO_MODEL_MESSAGE = 'No model is set up yet. Open Settings, add a model and choose it.'

const FALLBACK_BUDGET: ModelBudget = { model: 'none', contextWindow: 128_000, maxOutputTokens: 8_192 }

export function createProfileClient(options: ProfileClientOptions): ModelClient {
  const demo = options.demo ?? createDemoClient()
  // Calls overlap (subagents), so a switch of profile can land between choosing and routing a call: the last real one serves.
  let lastDirect: ProfileConfig | undefined

  const direct = createDirectClient({
    ...options.direct,
    route: async () => {
      const now = options.profile()
      const profile = now && now.kind !== 'demo' ? now : lastDirect
      if (!profile) throw new Error(NO_MODEL_MESSAGE)
      const apiKey = await options.apiKey?.(profile.id)
      return routeFor({
        provider: profile.id,
        baseUrl: profile.baseUrl,
        model: profile.model,
        ...(profile.kind === 'openrouter' ? { providerType: 'openrouter' as const } : {}),
        ...(apiKey ? { apiKey } : {}),
        ...(profile.contextWindow ? { contextWindow: profile.contextWindow } : {}),
        ...(profile.maxOutputTokens ? { maxOutputTokens: profile.maxOutputTokens } : {}),
      })
    },
  })

  const choose = (): ModelClient | undefined => {
    const profile = options.profile()
    if (!profile) return undefined
    if (profile.kind === 'demo') return demo
    lastDirect = profile
    return direct
  }

  return {
    async budget(role: ModelRole, query?: BudgetQuery): Promise<ModelBudget> {
      const client = choose()
      return client ? client.budget(role, query) : FALLBACK_BUDGET
    },
    async complete(request: CompletionRequest): Promise<CompletionOutcome> {
      const client = choose()
      if (!client) return { kind: 'paused', reason: 'no-model', message: NO_MODEL_MESSAGE }
      return client.complete(request)
    },
  }
}
