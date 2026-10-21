import { createHash, randomBytes } from 'node:crypto'
import { AccountsError, cleanMessage } from './errors'
import { readText } from './http'
import { listenForCallback, type CallbackListener, type ListenOptions } from './loopback'
import { object } from './readers'

/**
 * Connect OpenRouter: the user approves eNCode on OpenRouter's own page and
 * gets an API key of their own (OAuth with PKCE). The key is theirs, billed
 * to their account, and revocable on OpenRouter; eNCode keeps it in the key
 * vault like any key the user pastes. Nothing here involves the gateway, and
 * eNCode's free-tier key never leaves it.
 *
 *   const connection = await connectOpenRouter()
 *   openInBrowser(connection.url)
 *   const { key } = await connection.result
 *
 * Where a local listener cannot start, `connectOpenRouterByCode` shows the
 * code on OpenRouter's page for the user to paste back.
 */

export const OPENROUTER_AUTH_URL = 'https://openrouter.ai/auth'
export const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1'

/** OpenRouter's codes live ten minutes, so waiting longer for the user is pointless. */
const DEFAULT_TIMEOUT_MS = 10 * 60_000
const EXCHANGE_TIMEOUT_MS = 20_000
const EXCHANGE_BODY_LIMIT = 64 * 1024
const KEY = /^[\x21-\x7e]{16,512}$/

export interface OpenRouterKey {
  key: string
}

export interface OpenRouterOptions {
  fetch?: typeof fetch
  /** The label OpenRouter pre-fills for the new key. Default `eNCode`. */
  keyLabel?: string
  /** How long to wait for the user to approve. Default ten minutes. */
  timeoutMs?: number
  signal?: AbortSignal
  authUrl?: string
  apiUrl?: string
  /** The callback listener; tests replace it. */
  listen?: (options: ListenOptions) => Promise<CallbackListener>
}

export interface OpenRouterConnection {
  /** Open this in the user's browser. */
  readonly url: string
  /** Settles with the new key once the user approves, and rejects with an AccountsError if they decline, run out of time, or cancel. */
  readonly result: Promise<OpenRouterKey>
  cancel(): void
}

export interface PkcePair {
  verifier: string
  challenge: string
}

/** RFC 7636: a 43 character verifier from 32 random bytes, and its S256 challenge. */
export function createPkce(random: (size: number) => Uint8Array = randomBytes): PkcePair {
  const verifier = Buffer.from(random(32)).toString('base64url')
  return { verifier, challenge: challengeFor(verifier) }
}

export function challengeFor(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url')
}

export interface AuthorizationInput {
  authUrl?: string
  callbackUrl?: string
  challenge: string
  state?: string
  keyLabel?: string
}

/** The OpenRouter page that asks the user to approve. Without a callback it shows the code on screen instead. */
export function authorizationUrl(input: AuthorizationInput): string {
  const url = new URL(input.authUrl ?? OPENROUTER_AUTH_URL)
  if (input.callbackUrl) url.searchParams.set('callback_url', input.callbackUrl)
  url.searchParams.set('code_challenge', input.challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  if (input.state) url.searchParams.set('state', input.state)
  url.searchParams.set('key_label', input.keyLabel ?? 'eNCode')
  return url.href
}

interface ExchangeInput {
  code: string
  verifier: string
  fetch: typeof fetch
  apiUrl: string
  signal?: AbortSignal
}

/** Trades the one-time code for the user's key. The verifier proves this is the app that started the flow. */
async function exchange(input: ExchangeInput): Promise<OpenRouterKey> {
  const deadline = AbortSignal.timeout(EXCHANGE_TIMEOUT_MS)
  const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline
  let response: Response
  let text: string
  try {
    response = await input.fetch(`${input.apiUrl}/auth/keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ code: input.code, code_verifier: input.verifier, code_challenge_method: 'S256' }),
      redirect: 'error',
      signal,
    })
    text = await readText(response, EXCHANGE_BODY_LIMIT)
  } catch (error) {
    if (error instanceof AccountsError) throw error
    if (input.signal?.aborted) throw new AccountsError('cancelled', 'Connecting to OpenRouter was cancelled.')
    const message = deadline.aborted ? 'OpenRouter did not answer in time.' : 'Could not reach OpenRouter. Check your connection.'
    throw new AccountsError('network', message, { cause: error })
  }
  let body: Record<string, unknown> | null = null
  try {
    body = object(text ? JSON.parse(text) : null)
  } catch {
    body = null
  }
  if (!response.ok) {
    const failure = object(body?.error)
    const message = cleanMessage(failure?.message ?? body?.message, `OpenRouter did not accept the code (status ${response.status}). Start again.`)
    const code = response.status >= 500 ? 'unavailable' : response.status === 429 ? 'rate_limited' : 'exchange_failed'
    throw new AccountsError(code, message, { status: response.status })
  }
  const key = body?.key
  if (typeof key !== 'string' || !KEY.test(key)) throw new AccountsError('invalid_response', 'OpenRouter answered without a key this version of eNCode can use.')
  return { key }
}

/** Connects through a local callback: OpenRouter sends the browser back to a listener on this machine. */
export async function connectOpenRouter(options: OpenRouterOptions = {}): Promise<OpenRouterConnection> {
  const fetchImpl = options.fetch ?? fetch
  const { verifier, challenge } = createPkce()
  const state = randomBytes(24).toString('base64url')
  const listener = await (options.listen ?? listenForCallback)({
    state,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ...(options.signal ? { signal: options.signal } : {}),
  })
  const url = authorizationUrl({
    ...(options.authUrl ? { authUrl: options.authUrl } : {}),
    callbackUrl: listener.url,
    challenge,
    state,
    ...(options.keyLabel ? { keyLabel: options.keyLabel } : {}),
  })
  const result = listener.code.then(async (code) => {
    try {
      const key = await exchange({ code, verifier, fetch: fetchImpl, apiUrl: options.apiUrl ?? OPENROUTER_API_URL, ...(options.signal ? { signal: options.signal } : {}) })
      listener.finish('connected')
      return key
    } catch (error) {
      listener.finish('failed')
      throw error
    }
  })
  result.catch(() => undefined)
  return { url, result, cancel: () => listener.cancel() }
}

export interface OpenRouterCodeConnection {
  /** Open this in the user's browser: OpenRouter shows a code to copy once they approve. */
  readonly url: string
  /** Trades the code the user pasted for their key. A code works once. */
  submit(code: string): Promise<OpenRouterKey>
}

/** Connects without a local listener: the user copies the code OpenRouter shows and pastes it into eNCode. */
export function connectOpenRouterByCode(options: Omit<OpenRouterOptions, 'listen' | 'timeoutMs'> = {}): OpenRouterCodeConnection {
  const fetchImpl = options.fetch ?? fetch
  const { verifier, challenge } = createPkce()
  const url = authorizationUrl({
    ...(options.authUrl ? { authUrl: options.authUrl } : {}),
    challenge,
    ...(options.keyLabel ? { keyLabel: options.keyLabel } : {}),
  })
  return {
    url,
    submit: (pasted) => {
      const code = pasted.trim()
      if (!/^[\x21-\x7e]{8,512}$/.test(code)) {
        return Promise.reject(new AccountsError('exchange_failed', 'That does not look like the code from OpenRouter. Copy it again.'))
      }
      return exchange({ code, verifier, fetch: fetchImpl, apiUrl: options.apiUrl ?? OPENROUTER_API_URL, ...(options.signal ? { signal: options.signal } : {}) })
    },
  }
}
