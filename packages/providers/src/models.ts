/**
 * What eNCode knows about a model before asking anyone: its family, context
 * window, output limit and capabilities, plus the request rules Anthropic's
 * generations differ on. The router's registry (M2) refines these from live
 * catalogs; this table is the offline floor and DirectClient's source.
 */
import type { ModelCapabilities, ProviderType } from './contract'
import type { ModelFamily } from './messages'

export interface ModelInfo {
  family: ModelFamily
  contextWindow: number
  maxOutputTokens: number
  capabilities: ModelCapabilities
}

/** Used for a model nothing is known about; compaction learns the real window from the first overflow. */
export const DEFAULT_CONTEXT_WINDOW = 64_000
export const DEFAULT_MAX_OUTPUT_TOKENS = 8_192

const FAMILIES: ReadonlyArray<[RegExp, ModelFamily]> = [
  [/claude|anthropic\//i, 'anthropic'],
  [/(?:^|\/)(?:gpt|o\d|chatgpt|codex)|openai\//i, 'openai'],
  [/gemini|gemma|google\//i, 'google'],
  [/deepseek/i, 'deepseek'],
  [/qwen|qwq/i, 'qwen'],
  [/kimi|moonshot/i, 'moonshot'],
  [/glm|zhipu|z-ai\//i, 'zhipu'],
  [/mistral|mixtral|codestral|devstral|magistral|ministral|pixtral/i, 'mistral'],
  [/llama|meta-llama\//i, 'meta'],
  [/grok|x-ai\//i, 'xai'],
]

/** The family a model id belongs to, from its name (works for OpenRouter's vendor/model ids too). */
export function familyOf(model: string): ModelFamily {
  for (const [pattern, family] of FAMILIES) if (pattern.test(model)) return family
  return 'other'
}

const caps = (overrides: Partial<ModelCapabilities> = {}): ModelCapabilities => ({
  tools: true,
  parallelTools: true,
  images: false,
  reasoning: false,
  promptCache: false,
  ...overrides,
})

const CLAUDE_CAPS = caps({ images: true, reasoning: true, promptCache: true })

/**
 * Known models by id pattern, first match wins. Ids are matched lowercased with dots as dashes,
 * so OpenRouter's anthropic/claude-sonnet-4.5 matches like claude-sonnet-4-5, date suffixes and all.
 */
const KNOWN: ReadonlyArray<[RegExp, Omit<ModelInfo, 'family'>]> = [
  [/claude-haiku-4-5/, { contextWindow: 200_000, maxOutputTokens: 64_000, capabilities: CLAUDE_CAPS }],
  [/claude-(?:fable|mythos|opus|sonnet|haiku)-[5-9]/, { contextWindow: 1_000_000, maxOutputTokens: 128_000, capabilities: CLAUDE_CAPS }],
  [/claude-(?:opus|sonnet)-4-[6-9]/, { contextWindow: 1_000_000, maxOutputTokens: 128_000, capabilities: CLAUDE_CAPS }],
  [/claude-(?:opus|sonnet)-4/, { contextWindow: 200_000, maxOutputTokens: 64_000, capabilities: CLAUDE_CAPS }],
  [/claude-3-7-sonnet/, { contextWindow: 200_000, maxOutputTokens: 64_000, capabilities: CLAUDE_CAPS }],
  [/claude/, { contextWindow: 200_000, maxOutputTokens: 8_192, capabilities: caps({ images: true, promptCache: true }) }],
  [/gpt-5/, { contextWindow: 400_000, maxOutputTokens: 128_000, capabilities: caps({ images: true, reasoning: true }) }],
  [/gpt-4-1/, { contextWindow: 1_047_576, maxOutputTokens: 32_768, capabilities: caps({ images: true }) }],
  [/gpt-4o/, { contextWindow: 128_000, maxOutputTokens: 16_384, capabilities: caps({ images: true }) }],
  [/(?:^|\/)o[134](?:-mini|-pro)?(?:$|-)/, { contextWindow: 200_000, maxOutputTokens: 100_000, capabilities: caps({ images: true, reasoning: true }) }],
  [/deepseek-reasoner|deepseek-r1/, { contextWindow: 128_000, maxOutputTokens: 64_000, capabilities: caps({ reasoning: true }) }],
  [/deepseek/, { contextWindow: 128_000, maxOutputTokens: 8_192, capabilities: caps() }],
  [/gemini-(?:2-5|3)/, { contextWindow: 1_048_576, maxOutputTokens: 65_536, capabilities: caps({ images: true, reasoning: true }) }],
]

/** What the table knows about `model`, with defaults for the rest. */
function normalized(model: string): string {
  return model.toLowerCase().replace(/\./g, '-')
}

export function modelInfo(model: string): ModelInfo & { known: boolean } {
  const id = normalized(model)
  const family = familyOf(id)
  for (const [pattern, info] of KNOWN) if (pattern.test(id)) return { family, ...info, known: true }
  return {
    family,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    capabilities: caps({ images: family === 'anthropic' || family === 'openai' || family === 'google' }),
    known: false,
  }
}

/** How a Claude model wants its request built. The generations differ in ways that return a 400. */
export interface AnthropicTraits {
  /** Takes thinking {type: 'adaptive'}. */
  adaptiveThinking: boolean
  /** Takes thinking {type: 'enabled', budget_tokens}. Rejected on the newest models. */
  budgetThinking: boolean
  /** Takes thinking.display ('summarized'); thinking text is omitted by default from 4.7 on. */
  thinkingDisplay: boolean
  /** Takes temperature, top_p and top_k. */
  samplingParameters: boolean
  /** Takes output_config.effort. */
  effort: boolean
  /** Effort levels beyond 'high' ('xhigh', 'max'). */
  extendedEffort: boolean
}

export function anthropicTraits(model: string): AnthropicTraits {
  const id = normalized(model)
  // Fable, Mythos, Opus 5.x, Sonnet 5.x, Haiku 5.x, Opus 4.7 and 4.8: adaptive only, no sampling parameters.
  const modern = /claude-(?:fable|mythos)|claude-(?:opus|sonnet|haiku)-[5-9]|claude-opus-4-[7-9]/.test(id)
  const adaptive46 = /claude-(?:opus|sonnet)-4-6/.test(id)
  const thinks = /claude-(?:opus|sonnet)-4|claude-3-7-sonnet|claude-haiku-4-5/.test(id)
  return {
    adaptiveThinking: modern || adaptive46,
    budgetThinking: !modern && (adaptive46 || thinks),
    thinkingDisplay: modern,
    samplingParameters: !modern,
    effort: modern || adaptive46,
    extendedEffort: modern,
  }
}

/** The adapter a provider type uses for the given base URL. */
export function providerTypeFor(baseUrl: string, declared?: ProviderType): ProviderType {
  if (declared) return declared
  let host = ''
  try {
    host = new URL(baseUrl).hostname
  } catch {
    return 'openai-compatible'
  }
  if (host === 'api.anthropic.com') return 'anthropic'
  if (host === 'openrouter.ai') return 'openrouter'
  return 'openai-compatible'
}
