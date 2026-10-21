import type { GatewayErrorCode } from '@encode/gateway-protocol'

/** Why an accounts call failed. What each one means for the user is in the README. */
export type AccountsErrorCode =
  /** There is no session: the user never signed in, or signed out. */
  | 'signed_out'
  /** The gateway ended the session (signed out elsewhere, expired, or its token was reused). The saved session is already removed. */
  | 'session_ended'
  /** The user declined on GitHub. */
  | 'denied'
  /** The sign-in code was not entered in time. */
  | 'expired'
  /** The caller cancelled. */
  | 'cancelled'
  /** The gateway will not serve this account: invite-only, too new, suspended, or sign-in switched off. `gatewayCode` says which. */
  | 'refused'
  /** Too many requests: `retryAfterMs` says when to try again. */
  | 'rate_limited'
  /** The gateway answered with a failure, or is not the service this build expects. */
  | 'unavailable'
  /** The gateway could not be reached, or did not answer in time. */
  | 'network'
  /** This build is older than the gateway serves. */
  | 'client_outdated'
  /** An answer this client cannot read: another protocol version, or not an eNCode gateway at all. */
  | 'invalid_response'
  /** OpenRouter's authorization page was not completed in time. */
  | 'timeout'
  /** The local callback listener could not start. Paste the code instead. */
  | 'listen_failed'
  /** OpenRouter would not exchange the code for a key. */
  | 'exchange_failed'

export interface AccountsErrorDetails {
  gatewayCode?: GatewayErrorCode
  retryAfterMs?: number
  status?: number
  cause?: unknown
}

/** The only error this package throws. The message is written for the user and never contains a token. */
export class AccountsError extends Error {
  readonly code: AccountsErrorCode
  /** The gateway's own code, when the gateway sent one. */
  readonly gatewayCode?: GatewayErrorCode
  /** How long to wait before trying again, when the gateway or OpenRouter said. */
  readonly retryAfterMs?: number
  readonly status?: number

  constructor(code: AccountsErrorCode, message: string, details: AccountsErrorDetails = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause })
    this.name = 'AccountsError'
    this.code = code
    if (details.gatewayCode !== undefined) this.gatewayCode = details.gatewayCode
    if (details.retryAfterMs !== undefined) this.retryAfterMs = details.retryAfterMs
    if (details.status !== undefined) this.status = details.status
  }
}

export function isAccountsError(value: unknown): value is AccountsError {
  return value instanceof AccountsError
}

const MESSAGE_LIMIT = 300

/**
 * A message from a server, made safe to show: control characters removed and
 * the length capped. The gateway writes its messages for users, but this
 * client does not trust the other end of a socket to stay that way.
 */
export function cleanMessage(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g, ' ').trim()
  if (!text) return fallback
  return text.length > MESSAGE_LIMIT ? `${text.slice(0, MESSAGE_LIMIT - 1)}…` : text
}
