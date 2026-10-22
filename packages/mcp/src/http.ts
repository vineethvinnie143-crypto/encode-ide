import {
  ConnectionClosedError,
  ErrorCode,
  ProtocolError,
  isRequest,
  parseMessages,
  type JsonRpcId,
  type JsonRpcMessage,
  type SendOptions,
  type Transport,
} from './jsonrpc'
import { MAX_EVENT_CHARS, readEvents } from './sse'

/**
 * MCP over HTTP, both generations of it.
 *
 * Streamable HTTP (2025-03-26 and later): every message is a POST to one
 * endpoint. The server answers a request with a JSON body or with an event
 * stream that carries the answer (and may carry its own notifications and
 * requests first), and a notification or response with 202. The first answer
 * may set a session id, which every later request repeats; a 404 on a request
 * that carries one means the session ended. After initialisation a GET stream
 * is offered for messages the server starts on its own.
 *
 * Legacy HTTP+SSE (2024-11-05): the client opens an event stream, the server
 * names the URL to POST to in its first event, and answers arrive on the
 * stream.
 *
 * What the user configured is sent, and nothing else follows it: redirects
 * are never followed (a redirect could carry the configured headers, with a
 * token in them, to another site), the URL a legacy server names must stay
 * on the site that was configured, and header values cannot carry line
 * breaks.
 */

export interface HttpOptions {
  url: string
  /** Sent with every request: tokens and keys the user configured. */
  headers?: Record<string, string>
  fetch?: typeof fetch
  /** The most one message may hold, in bytes. */
  maxMessageBytes?: number
  /** How long the server has to start answering a request, in ms. */
  headerTimeoutMs?: number
  userAgent?: string
}

export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'HttpStatusError'
  }
}

/** The server wants credentials eNCode does not have. */
export class AuthRequiredError extends HttpStatusError {
  constructor(status: number, readonly challenge: string | null) {
    super(
      status,
      `The server refused the request (HTTP ${status}) and wants credentials. Put a token in the server's "headers" (for example "Authorization": "Bearer \${TOKEN}"); signing in through the browser is not supported yet.`,
    )
    this.name = 'AuthRequiredError'
  }
}

/** The server forgot the session; connecting again starts a new one. */
export class SessionExpiredError extends Error {
  constructor() {
    super('The server ended the session.')
    this.name = 'SessionExpiredError'
  }
}

const DEFAULT_MAX_MESSAGE_BYTES = 16 * 1024 * 1024
const DEFAULT_HEADER_TIMEOUT_MS = 30_000
/** Headers eNCode sets itself or that would break the request. */
const RESERVED_HEADERS = new Set([
  'accept',
  'connection',
  'content-length',
  'content-type',
  'expect',
  'host',
  'keep-alive',
  'last-event-id',
  'mcp-protocol-version',
  'mcp-session-id',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

/** What is wrong with a header set, or null. */
export function headerProblem(headers: Record<string, string>): string | null {
  for (const [name, value] of Object.entries(headers)) {
    if (!HEADER_NAME.test(name)) return `"${name}" is not a header name`
    if (RESERVED_HEADERS.has(name.toLowerCase())) return `the ${name} header is set by eNCode`
    if (typeof value !== 'string' || value.length > 8192 || /[\r\n\u0000]/.test(value)) return `the value of ${name} is not a single line`
  }
  return null
}

/** The URL of an HTTP server, or why it cannot be used. */
export function parseServerUrl(raw: string): URL | string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return `"${raw}" is not a URL`
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return `${url.protocol} URLs are not supported (use http or https)`
  if (url.username || url.password) return 'the URL contains a user name or password; put credentials in "headers" instead'
  if (!url.hostname) return 'the URL has no host'
  return url
}

function parseUrl(raw: string): URL {
  const url = parseServerUrl(raw)
  if (typeof url === 'string') throw new Error(url)
  return url
}

async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > maxBytes) throw new ProtocolError('The server sent a message that is too large.')
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return Buffer.concat(chunks).toString('utf8')
}

function isEventStream(response: Response): boolean {
  return (response.headers.get('content-type') ?? '').toLowerCase().includes('text/event-stream')
}

function redirectError(response: Response): Error {
  const location = response.headers.get('location')
  return new Error(`The server redirected the request${location ? ` to ${location}` : ''}. eNCode does not follow redirects, because they could send your headers to another site; use the final URL.`)
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

abstract class HttpBase {
  onmessage?: (message: JsonRpcMessage) => void
  onclose?: (reason?: Error) => void
  onerror?: (error: Error) => void
  protected closed = false
  protected readonly lifetime = new AbortController()
  protected readonly url: URL
  protected readonly fetchImpl: typeof fetch
  protected readonly maxBytes: number
  private readonly headerTimeoutMs: number

  constructor(protected readonly options: HttpOptions) {
    this.url = parseUrl(options.url)
    const problem = headerProblem(options.headers ?? {})
    if (problem) throw new Error(`Cannot send these headers: ${problem}.`)
    this.fetchImpl = options.fetch ?? fetch
    this.maxBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES
    this.headerTimeoutMs = options.headerTimeoutMs ?? DEFAULT_HEADER_TIMEOUT_MS
  }

  /** Headers every request carries; the ones eNCode sets cannot be overridden by the configuration. */
  protected baseHeaders(extra: Record<string, string> = {}): Headers {
    const headers = new Headers(this.options.headers)
    if (this.options.userAgent && !headers.has('user-agent')) headers.set('user-agent', this.options.userAgent)
    for (const [name, value] of Object.entries(extra)) headers.set(name, value)
    return headers
  }

  /**
   * Sends a request. The server has `headerTimeoutMs` to start answering; after that only `signal` ends it,
   * and it ends the body of the response too, not just the wait for the first byte (an event stream stays
   * open for as long as the transport does).
   */
  protected async request(url: URL, init: RequestInit, signal: AbortSignal): Promise<Response> {
    const slow = new AbortController()
    const timer = setTimeout(() => slow.abort(new Error(`The server did not answer within ${Math.round(this.headerTimeoutMs / 1000)} s.`)), this.headerTimeoutMs)
    try {
      return await this.fetchImpl(url, { ...init, redirect: 'manual', signal: AbortSignal.any([signal, slow.signal]) })
    } catch (error) {
      if (slow.signal.aborted && !signal.aborted && slow.signal.reason instanceof Error) throw slow.signal.reason
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  protected deliver(messages: JsonRpcMessage[]): void {
    for (const message of messages) this.onmessage?.(message)
  }

  /** Answers for requests whose stream ended without one, so nothing waits for ever. */
  protected failUnanswered(ids: Set<JsonRpcId>, why: string): void {
    for (const id of ids) this.onmessage?.({ jsonrpc: '2.0', id, error: { code: ErrorCode.ConnectionClosed, message: why } })
    ids.clear()
  }

  protected async failure(response: Response): Promise<Error> {
    if (response.status >= 300 && response.status < 400) return redirectError(response)
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => {})
      return new AuthRequiredError(response.status, response.headers.get('www-authenticate'))
    }
    let detail = ''
    try {
      detail = (await readBounded(response, 2048)).replace(/\s+/g, ' ').trim().slice(0, 300)
    } catch {
      // The status is what matters.
    }
    return new HttpStatusError(response.status, `The server answered HTTP ${response.status}${detail ? `: ${detail}` : ''}.`)
  }
}

// ---------------------------------------------------------------------------

export class StreamableHttpTransport extends HttpBase implements Transport {
  private sessionId: string | undefined
  private protocolVersion: string | undefined
  private lastEventId: string | undefined
  private listening = false

  setProtocolVersion(version: string): void {
    this.protocolVersion = version
  }

  ready(): void {
    this.openStream()
  }

  async send(message: JsonRpcMessage, sendOptions: SendOptions = {}): Promise<void> {
    if (this.closed) throw new ConnectionClosedError()
    const signal = sendOptions.signal ? AbortSignal.any([this.lifetime.signal, sendOptions.signal]) : this.lifetime.signal
    const expected = new Set<JsonRpcId>()
    if (isRequest(message)) expected.add(message.id)

    const response = await this.request(
      this.url,
      {
        method: 'POST',
        headers: this.baseHeaders({
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...this.sessionHeaders(),
        }),
        body: JSON.stringify(message),
      },
      signal,
    )

    const session = response.headers.get('mcp-session-id')
    if (session && !this.sessionId && /^[\x21-\x7e]{1,256}$/.test(session)) this.sessionId = session

    if (response.status === 404 && this.sessionId) {
      await response.body?.cancel().catch(() => {})
      const error = new SessionExpiredError()
      this.finish(error)
      throw error
    }
    if (response.status === 202) {
      await response.body?.cancel().catch(() => {})
      this.failUnanswered(expected, 'The server accepted the request but never answered it.')
      return
    }
    if (!response.ok) {
      const error = await this.failure(response)
      // Some servers put their JSON-RPC error in a 4xx body; the request is then answered, not failed.
      if (error instanceof HttpStatusError && expected.size && !(error instanceof AuthRequiredError)) {
        this.failUnanswered(expected, error.message)
        return
      }
      throw error
    }

    if (isEventStream(response)) {
      if (!response.body) throw new ProtocolError('The server sent an empty event stream.')
      for await (const event of readEvents(response.body, MAX_EVENT_CHARS)) {
        if (event.id) this.lastEventId = event.id
        if (event.event !== 'message' || !event.data) continue
        const messages = parseMessages(event.data)
        for (const item of messages) if ('id' in item && !('method' in item) && item.id !== null) expected.delete(item.id)
        this.deliver(messages)
      }
      this.failUnanswered(expected, 'The server ended the stream without answering.')
      return
    }

    const type = (response.headers.get('content-type') ?? '').toLowerCase()
    if (!type.includes('application/json')) {
      await response.body?.cancel().catch(() => {})
      throw new ProtocolError(`The server answered with ${type || 'no content type'}, not JSON or an event stream.`)
    }
    const messages = parseMessages(await readBounded(response, this.maxBytes))
    for (const item of messages) if ('id' in item && !('method' in item) && item.id !== null) expected.delete(item.id)
    this.deliver(messages)
    this.failUnanswered(expected, 'The server answered without a result for this request.')
  }

  /** Starts listening for messages the server sends on its own, if it offers a stream for them. */
  private openStream(): void {
    if (this.listening || this.closed) return
    this.listening = true
    void this.listen().finally(() => {
      this.listening = false
    })
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.lifetime.abort(new ConnectionClosedError())
    if (this.sessionId) {
      try {
        await this.fetchImpl(this.url, {
          method: 'DELETE',
          headers: this.baseHeaders(this.sessionHeaders()),
          redirect: 'manual',
          signal: AbortSignal.timeout(3000),
        })
      } catch {
        // The server may not support ending sessions, or may be gone.
      }
    }
    this.onclose?.()
  }

  private sessionHeaders(): Record<string, string> {
    return {
      ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
      ...(this.protocolVersion ? { 'mcp-protocol-version': this.protocolVersion } : {}),
    }
  }

  private finish(reason: Error): void {
    if (this.closed) return
    this.closed = true
    this.lifetime.abort(reason)
    this.onclose?.(reason)
  }

  private async listen(): Promise<void> {
    let failures = 0
    let delay = 1000
    while (!this.closed && failures < 5) {
      try {
        const response = await this.request(
          this.url,
          {
            method: 'GET',
            headers: this.baseHeaders({ accept: 'text/event-stream', ...this.sessionHeaders(), ...(this.lastEventId ? { 'last-event-id': this.lastEventId } : {}) }),
          },
          this.lifetime.signal,
        )
        // 405: this server has nothing to say unprompted.
        if (response.status === 405 || response.status === 400) {
          await response.body?.cancel().catch(() => {})
          return
        }
        if (response.status === 404 && this.sessionId) {
          await response.body?.cancel().catch(() => {})
          this.finish(new SessionExpiredError())
          return
        }
        if (!response.ok || !isEventStream(response) || !response.body) {
          await response.body?.cancel().catch(() => {})
          throw new Error(`The server did not offer a stream (HTTP ${response.status}).`)
        }
        failures = 0
        for await (const event of readEvents(response.body, MAX_EVENT_CHARS)) {
          if (event.id) this.lastEventId = event.id
          if (event.retry !== undefined) delay = Math.min(event.retry, 30_000)
          if (event.event === 'message' && event.data) this.deliver(parseMessages(event.data))
        }
      } catch (error) {
        if (this.closed) return
        failures++
        this.onerror?.(error instanceof Error ? error : new Error(String(error)))
      }
      await sleep(delay * Math.max(1, failures), this.lifetime.signal)
    }
  }
}

// ---------------------------------------------------------------------------

const ENDPOINT_TIMEOUT_MS = 30_000

export class LegacySseTransport extends HttpBase implements Transport {
  private endpoint: URL | undefined

  async start(): Promise<void> {
    try {
      await this.open()
    } catch (error) {
      this.closed = true
      this.lifetime.abort(error)
      throw error
    }
  }

  private async open(): Promise<void> {
    const response = await this.request(this.url, { method: 'GET', headers: this.baseHeaders({ accept: 'text/event-stream' }) }, this.lifetime.signal)
    if (!response.ok) throw await this.failure(response)
    if (!isEventStream(response) || !response.body) {
      await response.body?.cancel().catch(() => {})
      throw new ProtocolError('The server did not answer with an event stream.')
    }
    const body = response.body
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The server did not say where to send messages.')), ENDPOINT_TIMEOUT_MS)
      const fail = (error: Error) => {
        clearTimeout(timer)
        reject(error)
      }
      void (async () => {
        try {
          for await (const event of readEvents(body, MAX_EVENT_CHARS)) {
            if (event.event === 'endpoint' && !this.endpoint) {
              const target = this.resolveEndpoint(event.data)
              if (typeof target === 'string') return fail(new Error(target))
              this.endpoint = target
              clearTimeout(timer)
              resolve()
            } else if (event.event === 'message' && event.data && this.endpoint) {
              this.deliver(parseMessages(event.data))
            }
          }
          if (!this.endpoint) fail(new Error('The event stream ended before the server said where to send messages.'))
          else if (!this.closed) {
            this.closed = true
            this.onclose?.(new Error('The server closed the event stream.'))
          }
        } catch (error) {
          if (!this.endpoint) fail(error instanceof Error ? error : new Error(String(error)))
          else if (!this.closed) {
            this.closed = true
            this.onclose?.(error instanceof Error ? error : new Error(String(error)))
          }
        }
      })()
    })
  }

  async send(message: JsonRpcMessage, sendOptions: SendOptions = {}): Promise<void> {
    if (this.closed || !this.endpoint) throw new ConnectionClosedError()
    const signal = sendOptions.signal ? AbortSignal.any([this.lifetime.signal, sendOptions.signal]) : this.lifetime.signal
    const response = await this.request(
      this.endpoint,
      { method: 'POST', headers: this.baseHeaders({ 'content-type': 'application/json' }), body: JSON.stringify(message) },
      signal,
    )
    if (response.status === 200 || response.status === 202 || response.status === 204) {
      await response.body?.cancel().catch(() => {})
      return
    }
    throw await this.failure(response)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.lifetime.abort(new ConnectionClosedError())
    this.onclose?.()
  }

  /** Where the server wants messages posted, if that is the site that was configured. */
  private resolveEndpoint(data: string): URL | string {
    let target: URL
    try {
      target = new URL(data.trim(), this.url)
    } catch {
      return 'The server named an address that is not a URL.'
    }
    if (target.origin !== this.url.origin) return `The server asked eNCode to send messages to ${target.origin}, which is not the site that was configured (${this.url.origin}).`
    return target
  }
}
