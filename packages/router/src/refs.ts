/**
 * How settings name models. A model is `<provider>:<model id>`, split at the
 * first colon, because model ids contain colons of their own
 * (`openrouter:qwen/qwen3-coder:free`). `@free` stands for the free pool.
 */

export const FREE_POOL = '@free'

export interface ModelRef {
  /** The provider's id in settings, such as `openrouter` or `anthropic`. */
  provider: string
  /** The model id as that provider knows it. */
  model: string
}

/** Provider ids: short, lowercase-friendly identifiers. */
export const PROVIDER_ID = /^[a-z][a-z0-9_-]{0,63}$/i

/** Model ids: printable, without spaces, and of a sane length. */
const MODEL_ID = /^[\x21-\x7e]{1,256}$/

export function parseModelRef(text: string): ModelRef | null {
  if (typeof text !== 'string') return null
  const trimmed = text.trim()
  const colon = trimmed.indexOf(':')
  if (colon <= 0) return null
  const provider = trimmed.slice(0, colon)
  const model = trimmed.slice(colon + 1)
  if (!PROVIDER_ID.test(provider) || !MODEL_ID.test(model)) return null
  return { provider, model }
}

/** The router's key for a model: the same `<provider>:<model id>` form settings use. */
export function modelKey(provider: string, model: string): string {
  return `${provider}:${model}`
}

/** A model key back to its parts. Keys are only ever built by modelKey, so the first colon splits them. */
export function splitKey(key: string): ModelRef {
  const colon = key.indexOf(':')
  return { provider: key.slice(0, colon), model: key.slice(colon + 1) }
}
