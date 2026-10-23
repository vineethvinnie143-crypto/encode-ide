/**
 * Keys out of text that may reach a log, the chat or the model: the keys in use, and anything shaped like a key or
 * a credential. It works on shapes, so callers that hold keys pass them too; those go whatever they look like.
 */

/** Tokens whose form is fixed by the service that issues them, and bearer or basic credentials. */
const KEY_SHAPES: readonly RegExp[] = [
  // OpenAI, OpenRouter, Anthropic and the many that copied the "sk-" prefix.
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
]
/** A value assigned to a field named like a credential, in JSON, headers or query strings. */
const KEY_ASSIGNMENT = /\b(api[_-]?key|x-api-key|authorization|access[_-]?token|token|secret|password)(["']?\s*[:=]\s*["']?)[^\s"',}&]{8,}/gi

export const REDACTED = '[redacted]'

export function redactSecrets(text: string, keys: readonly string[] = []): string {
  let out = text
  for (const key of keys) if (key && key.length >= 8) out = out.split(key).join(REDACTED)
  for (const shape of KEY_SHAPES) out = out.replace(shape, REDACTED)
  return out.replace(KEY_ASSIGNMENT, (_match, name: string, separator: string) => `${name}${separator}${REDACTED}`)
}
