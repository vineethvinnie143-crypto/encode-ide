/**
 * Takes out of a line of text what must not leave this computer when someone sends a log or a diagnostics
 * report to another person: API keys and tokens, e-mail addresses and the user's name in a path.
 *
 * It works on shapes, so a key of a kind it has never seen can get through. Callers that know the keys they
 * hold pass them as `secrets`, and those are removed whatever they look like.
 */

export interface RedactContext {
  /** The user's home folder, for example C:\Users\ana. */
  home?: string
  /** Values that must never appear, such as the API keys stored for the profiles. */
  secrets?: readonly string[]
}

const MARK = '[redacted]'
/** Anything shorter could be a common word, and replacing it everywhere would only damage the text. */
const MIN_SECRET_LENGTH = 8

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Tokens whose form is fixed by the service that issues them. */
const KNOWN_TOKENS: RegExp[] = [
  // OpenAI, OpenRouter, Anthropic and the many that copied the "sk-" prefix.
  /\bsk-[A-Za-z0-9_-]{12,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
]

const HEX = /^[0-9a-f]+$/i
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A long run of letters and digits in both cases is almost always a secret; a commit hash or a session id is not. */
function looksOpaque(run: string): boolean {
  if (HEX.test(run) || UUID.test(run)) return false
  return /[a-z]/.test(run) && /[A-Z]/.test(run) && /[0-9]/.test(run)
}

function exactForms(value: string): string[] {
  // The same text written into a JSON log has its backslashes doubled; one with a path may use either slash.
  return [...new Set([value, value.replace(/\\/g, '\\\\'), value.replace(/\\/g, '/'), value.replace(/\//g, '\\')])].filter(Boolean)
}

export function redact(text: string, context: RedactContext = {}): string {
  let out = text

  for (const secret of context.secrets ?? []) {
    if (secret.length < MIN_SECRET_LENGTH) continue
    for (const form of exactForms(secret)) out = out.split(form).join(MARK)
  }

  // Headers and fields that carry a credential, by name.
  out = out.replace(/\b(proxy-authorization|authorization)(["']?\s*[:=]\s*["']?)(?:bearer\s+|basic\s+|token\s+)?[^\s"',;]+/gi, `$1$2${MARK}`)
  out = out.replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${MARK}`)
  // A value already replaced is left alone, so redacting twice changes nothing more than redacting once.
  out = out.replace(
    /(\b(?:x-api-key|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|token|password|passwd)["']?\s*[:=]\s*["']?)(?!\[redacted\])[^\s"',;&)}\]]+/gi,
    `$1${MARK}`,
  )
  // user:password@host
  out = out.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${MARK}@`)

  for (const pattern of KNOWN_TOKENS) out = out.replace(pattern, MARK)

  out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, '[email]')

  // Paths: the home folder first, then any other user's folder that shows up.
  if (context.home && context.home.length > 3) {
    for (const form of exactForms(context.home.replace(/[\\/]+$/, ''))) {
      out = out.replace(new RegExp(`${escapeRegExp(form)}(?![\\w-])`, 'gi'), '~')
    }
  }
  out = out.replace(/\b([A-Za-z]:(?:\\{1,2}|\/)Users(?:\\{1,2}|\/))(?!<user>)[^\\/\s"'<>|:*?]+/gi, '$1<user>')
  out = out.replace(/(\/(?:home|Users)\/)(?!<user>)[^/\s"']+/g, '$1<user>')

  out = out.replace(/[A-Za-z0-9_-]{32,}/g, (run) => (looksOpaque(run) ? MARK : run))
  return out
}
