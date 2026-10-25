/**
 * The model the command line works with: eNCode's own router for one model on every role, with its key from the
 * environment. Keys are read here and nowhere else; they are never printed, and the agent's commands start without
 * them (packages/tools/src/shell/environment.ts takes every variable named like a key out).
 */
import { createDemoClient } from '@encode/core'
import type { ModelClient, SpendingCap } from '@encode/providers'
import { createAnthropicAdapter, createOpenAICompatibleAdapter, createOpenRouterAdapter, redactSecrets } from '@encode/providers'
import { createRouter, parseRouterConfig, staticKeys } from '@encode/router'
import { UsageError } from './args'

interface Preset {
  /** The router's provider type. */
  type: 'openrouter' | 'anthropic' | 'openai-compatible'
  baseUrl?: string
  /** The variable that holds its key; none for a server on this computer. */
  key?: string
}

/** The providers a model can name, as `<provider>:<model id>`. */
export const PRESETS: Readonly<Record<string, Preset>> = {
  openrouter: { type: 'openrouter', key: 'OPENROUTER_API_KEY' },
  anthropic: { type: 'anthropic', key: 'ANTHROPIC_API_KEY' },
  openai: { type: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', key: 'OPENAI_API_KEY' },
  deepseek: { type: 'openai-compatible', baseUrl: 'https://api.deepseek.com/v1', key: 'DEEPSEEK_API_KEY' },
  ollama: { type: 'openai-compatible', baseUrl: 'http://localhost:11434/v1' },
  lmstudio: { type: 'openai-compatible', baseUrl: 'http://localhost:1234/v1' },
}

export interface ModelChoice {
  client: ModelClient
  /** What to call it in the header, without a key. */
  label: string
  /** The keys in use, to take out of anything written. */
  secrets: string[]
  /** OpenRouter's free models: what they are sent may be kept by whoever serves them. */
  free: boolean
  /** The spending cap `client` is held to (--max-cost, ADR 0138). */
  cap?: SpendingCap
}

export const NO_MODEL = `Choose a model: --model openrouter:<id> (or anthropic:, openai:, deepseek:, ollama:, lmstudio:), --model @free for OpenRouter's free models, or --model demo to try eNCode offline. ENCODE_MODEL sets one for every run.`

/** The provider and router config for a model, or why it cannot be used. Exported for tests. */
export function modelConfig(model: string, baseUrl: string | undefined, env: NodeJS.ProcessEnv): { provider: string; providers: Record<string, unknown>; ref: string; keyName?: string } {
  if (baseUrl) {
    let url: URL
    try {
      url = new URL(baseUrl)
    } catch {
      throw new UsageError(`--base-url ${baseUrl} is not an address`)
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new UsageError('--base-url must be an http or https address')
    if (model.includes(':') && PRESETS[model.slice(0, model.indexOf(':'))]) throw new UsageError(`with --base-url, --model is the server's own model id, not ${model}`)
    return { provider: 'custom', providers: { custom: { type: 'openai-compatible', baseUrl: url.href.replace(/\/+$/, '') } }, ref: `custom:${model}`, keyName: 'ENCODE_API_KEY' }
  }
  if (model === '@free') return { provider: 'openrouter', providers: { openrouter: { type: 'openrouter' } }, ref: '@free', keyName: 'OPENROUTER_API_KEY' }
  const at = model.indexOf(':')
  const provider = at > 0 ? model.slice(0, at) : ''
  const preset = PRESETS[provider]
  if (!preset || at === model.length - 1) throw new UsageError(`${model} is not a model eNCode knows how to reach. ${NO_MODEL}`)
  const custom = provider === 'ollama' || provider === 'lmstudio' ? env[`ENCODE_${provider.toUpperCase()}_URL`]?.trim() : undefined
  return {
    provider,
    providers: { [provider]: { type: preset.type, ...(custom || preset.baseUrl ? { baseUrl: custom || preset.baseUrl } : {}) } },
    ref: model,
    ...(preset.key ? { keyName: preset.key } : {}),
  }
}

export async function chooseModel(model: string | undefined, baseUrl: string | undefined, env: NodeJS.ProcessEnv, warn: (text: string) => void): Promise<ModelChoice> {
  if (!model) throw new UsageError(NO_MODEL)
  if (model === 'demo') return { client: createDemoClient(), label: 'demo (offline)', secrets: [], free: false }
  const { provider, providers, ref, keyName } = modelConfig(model, baseUrl, env)
  const key = keyName ? (env[keyName] ?? '').trim() : ''
  // A server on this computer, or one given by --base-url, may need no key.
  if (!key && keyName && provider !== 'custom') throw new UsageError(`Set ${keyName} to use ${model}. eNCode reads it from the environment only and never writes it anywhere.`)
  const { config, problems } = parseRouterConfig({ providers, roles: { main: [ref] }, freeOnly: ref === '@free' })
  if (problems.length) throw new UsageError(problems.map((problem) => `${problem.path}: ${problem.message}`).join('; '))
  const router = createRouter({
    config,
    adapters: [createOpenRouterAdapter(), createOpenAICompatibleAdapter(), createAnthropicAdapter()],
    keys: staticKeys(key ? { [provider]: key } : {}),
  })
  try {
    await router.refresh()
  } catch (error) {
    // The catalog says what a model can take; without it the first request still says what is wrong.
    warn(redactSecrets(`Could not read ${provider}'s model list: ${error instanceof Error ? error.message : String(error)}`, key ? [key] : []))
  }
  return { client: router, label: baseUrl ? `${model} at ${new URL(baseUrl).host}` : model, secrets: key ? [key] : [], free: ref === '@free' }
}
