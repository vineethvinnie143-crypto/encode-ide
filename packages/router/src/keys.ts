import { redactSecrets } from '@encode/providers'

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

/** Removes keys from text that may reach a log, the UI or the model: the keys in use, and anything shaped like one. */
export function redact(text: string, keys: readonly string[] = []): string {
  return redactSecrets(text, keys)
}
