import { errorAction, formatClientHeader, GatewayHeaders, readGatewayError, type GatewayErrorDetail } from '@encode/gateway-protocol'
import { AccountsError, cleanMessage } from './errors'

/** More than any gateway answer in this protocol: a bigger body is not from the gateway. */
const RESPONSE_LIMIT = 256 * 1024

export interface SendOptions {
  method?: 'GET' | 'POST'
  body?: unknown
  token?: string
  signal?: AbortSignal
  timeoutMs?: number
}

export type Reply =
  | { ok: true; status: number; body: unknown }
  | { ok: false; status: number; detail?: GatewayErrorDetail; retryAfterMs?: number }

export interface HttpOptions {
  baseUrl: string
  fetch: typeof fetch
  client: { app: string; version: string }
  timeoutMs: number
}

/** Reads at most `limit` bytes of text, and cancels the rest. */
export async function readText(response: Response, limit: number): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: false })
  let text = ''
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      // Not awaited: a cancel can wait on other readers of the same stream, and the answer is already refused.
      void reader.cancel().catch(() => undefined)
      throw new AccountsError('invalid_response', 'The server sent a larger answer than the protocol allows.')
    }
    text += decoder.decode(value, { stream: true })
  }
  return text + decoder.decode()
}

/** Seconds in a `retry-after` header as milliseconds. HTTP dates are not used by the gateway and are ignored. */
function retryAfterHeader(response: Response): number | undefined {
  const value = response.headers.get('retry-after')
  if (!value || !/^\d{1,6}$/.test(value)) return undefined
  return Number(value) * 1000
}

/**
 * Talks to the gateway. Every request carries the client header, has a
 * deadline, and refuses redirects, so a token never follows a Location header
 * to another host. Failures to reach the gateway throw; the gateway's own
 * refusals come back as data for the caller to judge.
 */
export class GatewayHttp {
  constructor(private readonly options: HttpOptions) {}

  async send(path: string, send: SendOptions = {}): Promise<Reply> {
    const { signal: outer } = send
    if (outer?.aborted) throw new AccountsError('cancelled', 'Cancelled.')
    const deadline = AbortSignal.timeout(send.timeoutMs ?? this.options.timeoutMs)
    const signal = outer ? AbortSignal.any([outer, deadline]) : deadline
    const headers: Record<string, string> = {
      accept: 'application/json',
      [GatewayHeaders.client]: formatClientHeader(this.options.client.app, this.options.client.version),
    }
    if (send.body !== undefined) headers['content-type'] = 'application/json'
    if (send.token) headers.authorization = `Bearer ${send.token}`

    let response: Response
    let text: string
    try {
      response = await this.options.fetch(`${this.options.baseUrl}${path}`, {
        method: send.method ?? (send.body === undefined ? 'GET' : 'POST'),
        headers,
        ...(send.body === undefined ? {} : { body: JSON.stringify(send.body) }),
        redirect: 'error',
        signal,
      })
      text = await readText(response, RESPONSE_LIMIT)
    } catch (error) {
      if (error instanceof AccountsError) throw error
      if (outer?.aborted) throw new AccountsError('cancelled', 'Cancelled.')
      if (deadline.aborted) throw new AccountsError('network', 'The eNCode gateway did not answer in time.', { cause: error })
      throw new AccountsError('network', 'Could not reach the eNCode gateway. Check your connection.', { cause: error })
    }

    let body: unknown
    if (text) {
      try {
        body = JSON.parse(text)
      } catch {
        body = undefined
      }
    }
    if (response.status >= 200 && response.status < 300) return { ok: true, status: response.status, body }
    const detail = readGatewayError(body)
    const retryAfterMs = detail?.retry_after !== undefined ? detail.retry_after * 1000 : retryAfterHeader(response)
    return { ok: false, status: response.status, ...(detail ? { detail } : {}), ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) }
  }
}

export type Refusal = Extract<Reply, { ok: false }>

/**
 * The error for a refusal, by what the client should do about it. A gateway
 * that did not send an error body (a proxy's page, a wrong address) is judged
 * by its status alone.
 */
export function failureOf(reply: Refusal): AccountsError {
  const { detail, status, retryAfterMs } = reply
  const extra = { status, ...(detail ? { gatewayCode: detail.code } : {}), ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) }
  if (!detail) {
    if (status === 429) return new AccountsError('rate_limited', 'Too many requests. Wait a little and try again.', extra)
    if (status >= 500) return new AccountsError('unavailable', `The eNCode gateway is having trouble (status ${status}). Try again shortly.`, extra)
    return new AccountsError('invalid_response', 'That address did not answer like an eNCode gateway.', extra)
  }
  const message = cleanMessage(detail.message, 'The eNCode gateway refused the request.')
  switch (errorAction(detail.code)) {
    case 'wait':
      return new AccountsError('rate_limited', message, extra)
    case 'next_tier':
      return new AccountsError('refused', message, extra)
    case 'backoff':
      return new AccountsError('unavailable', message, extra)
    case 'update':
      return new AccountsError('client_outdated', message, extra)
    case 'refresh':
    case 'sign_in':
      return new AccountsError('session_ended', message, extra)
    case 'fix':
      return new AccountsError('invalid_response', message, extra)
  }
}
