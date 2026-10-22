/**
 * Bring your own key. The router never stores keys: it asks a KeySource,
 * which the host backs with the OS keychain (desktop), environment variables
 * (CLI and CI) or the account service (gateway access tokens). Keys go
 * straight from this machine to their provider and are bound to the
 * provider's origin, so a changed base URL can never carry an old key to a
 * new server.
 */
export interface KeySource {
  /** Whether a key is configured for the provider. Cheap and synchronous: selection calls it often. */
  has(provider: string): boolean
  /** The key for the provider's origin, or undefined when there is none. May refresh a token first. */
  get(provider: string, origin: string): Promise<string | undefined>
  /** The provider refused the key; the next get should refresh or re-read it. */
  invalidate?(provider: string): void
}

/** A KeySource over a fixed map, for tests and the CLI's environment variables. */
export function staticKeys(keys: Record<string, string | undefined>): KeySource {
  return {
    has: (provider) => Boolean(keys[provider]),
    get: async (provider) => keys[provider] || undefined,
  }
}

export function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

/** Text shaped like a key: OpenAI-style `sk-…` keys (OpenRouter's too) and bearer or basic credentials. */
const KEY_SHAPES: readonly RegExp[] = [/\bsk-[A-Za-z0-9_-]{8,}/g, /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi]
/** A value assigned to a field named like a credential, in JSON, headers or query strings. */
const KEY_ASSIGNMENT = /\b(api[_-]?key|x-api-key|authorization|access[_-]?token)(["']?\s*[:=]\s*["']?)[^\s"',}&]{8,}/gi

/**
 * Removes keys from text that may reach a log, the UI or the model: the keys
 * in use, and anything shaped like a key or a credential.
 */
export function redact(text: string, keys: readonly string[] = []): string {
  let out = text
  for (const key of keys) if (key && key.length >= 8) out = out.split(key).join('[redacted]')
  for (const shape of KEY_SHAPES) out = out.replace(shape, '[redacted]')
  return out.replace(KEY_ASSIGNMENT, (_match, name: string, separator: string) => `${name}${separator}[redacted]`)
}
