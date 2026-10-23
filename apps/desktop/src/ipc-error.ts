/** Errors only a fault in eNCode's own code throws (as in @encode/core's shownError). */
const FAULTS = new Set(['TypeError', 'ReferenceError', 'RangeError', 'SyntaxError', 'EvalError', 'URIError'])

export const FAULT_TEXT = 'Something went wrong inside eNCode, so that did not finish. Try again.'

/**
 * What a failure says when the interface shows it: one plain line. The main process already sends failures that
 * way; this also takes off Electron's "Error invoking remote method" wrapper, and keeps an error thrown in the
 * interface itself to its first line, without its class, its stack or anything shaped like a key. A fault in the
 * interface's own code is one fixed sentence; what it said goes to the console, which the main process logs.
 */
export function errorText(error: unknown): string {
  if (error instanceof Error && FAULTS.has(error.name)) {
    console.error(error)
    return FAULT_TEXT
  }
  const message = error instanceof Error ? error.message : String(error ?? '')
  const unwrapped = message.replace(/^Error invoking remote method '[^']+':\s*/, '')
  const first = unwrapped.split('\n').find((line) => line.trim() && !/^\s+at /.test(line)) ?? ''
  const text = first
    .replace(/^(?:[A-Z][A-Za-z]*Error|Error)(?: \[[A-Z_]+\])?:\s*/, '')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '[redacted]')
    .trim()
  if (!text) return 'eNCode could not do that. Try again.'
  return text.length > 300 ? `${text.slice(0, 300)}…` : text
}
