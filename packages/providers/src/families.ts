/**
 * What each model family expects of a request beyond the dialect (ADR 0099, 0100): which take sampling parameters and
 * at what temperature for code, how a reasoning effort is named, and the limits to assume for one of its models nothing
 * is known about.
 */
import type { ModelFamily, ReasoningEffort } from './messages'

/**
 * Whether a temperature the person set goes to this model. Kimi's thinking models refuse a change to it, Gemini 3
 * is asked to keep its own (lower values make it loop), and MiniMax's ignore it.
 */
export function takesSampling(family: ModelFamily, model: string): boolean {
  if (family === 'moonshot' || family === 'minimax') return false
  return !(family === 'google' && /gemini-(?:[3-9]|\d{2,})/i.test(model))
}

/**
 * The temperature a family's maker recommends for code, sent when the person set none (ADR 0100): DeepSeek's 0.0 for
 * coding (its API's own default is 1.0), and 0.7 for Qwen's Coder models, as their model card says. Undefined for the
 * rest, which keep their provider's default.
 */
export function codeTemperature(family: ModelFamily, model: string): number | undefined {
  if (family === 'deepseek') return 0
  if (family === 'qwen' && /coder/i.test(model)) return 0.7
  return undefined
}

/**
 * `reasoning_effort` as a provider's own API names it, for the families that take one there; undefined for the rest.
 * DeepSeek and Kimi know low, high and max.
 */
export function effortWord(family: ModelFamily, effort: ReasoningEffort): string | undefined {
  if (family === 'openai') return effort === 'xhigh' || effort === 'max' ? 'high' : effort
  if (family === 'deepseek' || family === 'moonshot') return effort === 'low' ? 'low' : effort === 'xhigh' || effort === 'max' ? 'max' : 'high'
  return undefined
}

/**
 * Whether one step of a request may think at another effort than the last without costing the prompt cache (ADR 0135).
 * OpenAI's, DeepSeek's and Kimi's effort is a field of the request, outside the prompt their caches match. Claude and
 * Gemini check their reasoning against the request it was written under, gpt-oss writes its effort into the system
 * message, and the rest are not known to keep their cache, so their effort stays as it is set.
 */
export function effortPerStep(family: ModelFamily, model: string, reasoning: boolean): boolean {
  if (!reasoning || /gpt-oss/i.test(model)) return false
  return family === 'openai' || family === 'deepseek' || family === 'moonshot'
}

/**
 * The window and output to assume for a model of a family whose models reason at length, when no catalog says:
 * their reasoning counts against the output limit, so the usual 8,192 cuts replies short. A server that allows less
 * says so, and the request is sent again with its limit (openai.ts); a smaller window is learned from the first
 * overflow.
 */
export const FAMILY_LIMITS: Partial<Record<ModelFamily, { contextWindow: number; maxOutputTokens: number }>> = {
  deepseek: { contextWindow: 128_000, maxOutputTokens: 32_000 },
  moonshot: { contextWindow: 256_000, maxOutputTokens: 32_000 },
  zhipu: { contextWindow: 128_000, maxOutputTokens: 32_000 },
  minimax: { contextWindow: 192_000, maxOutputTokens: 32_000 },
  qwen: { contextWindow: 128_000, maxOutputTokens: 32_000 },
}
