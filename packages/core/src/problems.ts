/**
 * Problems as the chat shows them: one or two plain sentences, what can be done about it (Retry, Switch model,
 * Settings, Diagnostics), and the longer account folded under Details. What a provider, the system or a stack trace
 * says never makes the sentence; it goes, keys removed, into the details and the log.
 */
import { isTransportError, redactSecrets, type PauseReason, type TransportErrorKind } from '@encode/providers'
import type { EntryProblem, ProblemAction, ProblemCode } from './ui'

/** Details past this are cut: enough for a report, not a wall of text in the chat. */
export const MAX_DETAILS = 4_000

/** What each kind of trouble offers, the most useful first. */
const ACTIONS: Record<ProblemCode, ProblemAction[]> = {
  auth: ['settings', 'switch-model'],
  payment: ['switch-model', 'settings'],
  quota: ['switch-model', 'retry'],
  'rate-limit': ['retry', 'switch-model'],
  network: ['retry'],
  unavailable: ['retry', 'switch-model'],
  'no-model': ['switch-model', 'settings'],
  refused: ['switch-model'],
  context: ['switch-model'],
  empty: ['retry', 'switch-model'],
  host: ['retry'],
  internal: ['retry', 'diagnostics'],
}

/** What a kind of trouble offers, the most useful first. */
export function actionsFor(code: ProblemCode): ProblemAction[] {
  return [...ACTIONS[code]]
}

export interface Problem {
  /** For the person: what happened, in plain words. */
  text: string
  problem: EntryProblem
  /** The longer account, keys removed. */
  details?: string
}

export function problem(code: ProblemCode, text: string, extra: { retryAt?: number; details?: string; home?: string } = {}): Problem {
  const details = detailsOf(extra.details, extra.home)
  return {
    text,
    problem: { code, actions: actionsFor(code), ...(extra.retryAt !== undefined ? { retryAt: extra.retryAt } : {}) },
    ...(details ? { details } : {}),
  }
}

/** Text fit for a Details fold: keys out, the user's folder as "~", and not too long. */
export function detailsOf(text: string | undefined, home?: string): string | undefined {
  if (!text?.trim()) return undefined
  let out = redactSecrets(text.trim())
  if (home && home.length > 2) out = out.split(home).join('~')
  return out.length > MAX_DETAILS ? `${out.slice(0, MAX_DETAILS)}…` : out
}

const TRANSPORT_CODES: Partial<Record<TransportErrorKind, PauseReason>> = {
  auth: 'auth',
  payment: 'payment',
  quota: 'quota',
  'rate-limit': 'rate-limit',
  network: 'network',
  timeout: 'network',
  'content-filter': 'refused',
  'invalid-request': 'refused',
  'not-found': 'no-model',
  unsupported: 'no-model',
}

const TRANSPORT_TEXT: Record<PauseReason, string> = {
  auth: 'The model provider did not accept the API key.',
  payment: 'Your account with the model provider is out of credit.',
  quota: "The model provider's limit is used up for now.",
  'rate-limit': 'The model provider is getting too many requests right now.',
  network: 'eNCode could not reach the model provider.',
  unavailable: 'The model is not available right now.',
  'no-model': 'The model cannot take this request.',
  refused: 'The model provider turned the request down.',
}

/** A request that ended on something thrown, not on an outcome: a fault in eNCode, the system or a provider. */
export function problemFromError(error: unknown, home?: string): Problem {
  const details = describeError(error)
  if (isTransportError(error)) {
    const code = TRANSPORT_CODES[error.kind] ?? 'unavailable'
    return problem(code, TRANSPORT_TEXT[code], { details, home, ...(error.retryAt ? { retryAt: error.retryAt } : {}) })
  }
  const system = systemReason(error)
  if (system) return problem('internal', `This request stopped: ${system}.`, { details, home })
  return problem('internal', 'Something went wrong inside eNCode, and this request stopped.', { details, home })
}

/** Everything known about an error, for the details: its name, message, code and where it was thrown. */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const code = (error as { code?: unknown }).code
  const head = `${error.name}${typeof code === 'string' ? ` [${code}]` : ''}: ${error.message}`
  const frames = (error.stack ?? '').split('\n').filter((line) => /^\s+at /.test(line)).slice(0, 12)
  const cause = error.cause !== undefined && error.cause !== error ? `\nCaused by ${describeError(error.cause).split('\n')[0]}` : ''
  return [head, ...frames].join('\n') + cause
}

/** What the system said, as words: "C:\a.txt is in use by another program". */
const SYSTEM_REASONS: Record<string, (path: string) => string> = {
  ENOENT: (path) => (path ? `${path} does not exist` : 'a file or folder it needed does not exist'),
  EACCES: (path) => (path ? `access to ${path} was denied` : 'access was denied'),
  EPERM: (path) => (path ? `the system did not allow the change to ${path}` : 'the system did not allow it'),
  EBUSY: (path) => (path ? `${path} is in use by another program` : 'a file is in use by another program'),
  ENOSPC: () => 'the disk is full',
  EMFILE: () => 'too many files are open at once',
  ENFILE: () => 'too many files are open at once',
  EISDIR: (path) => (path ? `${path} is a folder, not a file` : 'a folder was found where a file was expected'),
  ENOTDIR: (path) => (path ? `part of ${path} is not a folder` : 'part of a path is not a folder'),
  EEXIST: (path) => (path ? `${path} already exists` : 'it already exists'),
  ENOTEMPTY: (path) => (path ? `${path} is not empty` : 'the folder is not empty'),
  EROFS: (path) => (path ? `${path} is on a read-only drive` : 'the drive is read-only'),
  ENAMETOOLONG: () => 'the path is too long',
  ELOOP: (path) => (path ? `${path} links to itself` : 'a link points to itself'),
  ETIMEDOUT: () => 'it took too long',
  ECONNREFUSED: () => 'the connection was refused',
  ECONNRESET: () => 'the connection dropped',
  ENOTFOUND: () => 'the address could not be found',
  EAI_AGAIN: () => 'the address could not be looked up',
}

/** The reason of a Node system error in plain words, or undefined when it is not one. */
export function systemReason(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined
  const code = (error as { code?: unknown }).code
  if (typeof code !== 'string' || !Object.hasOwn(SYSTEM_REASONS, code)) return undefined
  const path = (error as { path?: unknown }).path
  return SYSTEM_REASONS[code](typeof path === 'string' ? path : '')
}

/** Errors only a fault in eNCode's own code throws: what they say means nothing to the person who sees it. */
const FAULTS = new Set(['TypeError', 'ReferenceError', 'RangeError', 'SyntaxError', 'EvalError', 'URIError'])

export const FAULT_TEXT = 'Something went wrong inside eNCode, so that did not finish. Try again.'

/**
 * An error as a person should read it: a fault in eNCode's own code as one fixed sentence (the log keeps what it
 * said), anything else as plainError() says it.
 */
export function shownError(error: unknown): string {
  if (error instanceof Error && FAULTS.has(error.name)) return FAULT_TEXT
  return plainError(error)
}

/**
 * An error as one plain line, for a message the model or the person reads: a system error in words, else the
 * message without its "Error:" prefix and without a stack. The model is better served by a fault's own words, so
 * this keeps them; shownError() is for a person.
 */
export function plainError(error: unknown): string {
  const system = systemReason(error)
  if (system) return `${system.charAt(0).toUpperCase()}${system.slice(1)}.`
  const message = error instanceof Error ? error.message : String(error)
  const first = message.split('\n').find((line) => line.trim() && !/^\s+at /.test(line)) ?? ''
  const text = redactSecrets(first.replace(/^(?:[A-Z][A-Za-z]*Error|Error)(?: \[[A-Z_]+\])?:\s*/, '').trim())
  return text.length > 300 ? `${text.slice(0, 300)}…` : text || 'It failed without saying why.'
}
