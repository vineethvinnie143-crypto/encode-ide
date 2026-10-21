/**
 * JSON-RPC 2.0 as MCP uses it, and the connection that runs it over any
 * transport. Both ends of a conversation are served by the same code: the
 * client uses it against real servers, and the tests use it to play the
 * server.
 *
 * Everything that arrives is untrusted. A message is checked for shape
 * before anything looks inside it; a response nobody is waiting for is
 * dropped; an unknown request is answered "method not found"; a handler that
 * throws is answered with a generic internal error, never with its message.
 */

export type JsonRpcId = string | number

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: JsonRpcId
  method: string
  params?: unknown
}

export interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

export interface JsonRpcSuccess {
  jsonrpc: '2.0'
  id: JsonRpcId
  result: unknown
}

export interface JsonRpcErrorBody {
  code: number
  message: string
  data?: unknown
}

export interface JsonRpcFailure {
  jsonrpc: '2.0'
  id: JsonRpcId | null
  error: JsonRpcErrorBody
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse

export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  /** Not in the JSON-RPC range reserved for the protocol: ours, for a stream that ended before an answer. */
  ConnectionClosed: -32000,
  RequestTimeout: -32001,
} as const

/** The server answered a request with an error. */
export class McpError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message)
    this.name = 'McpError'
  }
}

/** The other side sent something that is not MCP. */
export class ProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProtocolError'
  }
}

export class RequestTimeoutError extends Error {
  constructor(
    readonly method: string,
    readonly timeoutMs: number,
  ) {
    super(`${method} did not answer within ${Math.round(timeoutMs / 1000)} s`)
    this.name = 'RequestTimeoutError'
  }
}

export class ConnectionClosedError extends Error {
  constructor(message = 'The connection closed.') {
    super(message)
    this.name = 'ConnectionClosedError'
  }
}

/** Messages in one HTTP body or one array; a batch larger than this is refused. */
const MAX_BATCH = 64

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isId(value: unknown): value is JsonRpcId {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))
}

/** The message a value is, or null when it is not a JSON-RPC 2.0 message. */
export function toMessage(value: unknown): JsonRpcMessage | null {
  if (!isObject(value) || value.jsonrpc !== '2.0') return null
  const hasId = 'id' in value
  if (typeof value.method === 'string') {
    if (!value.method) return null
    if (hasId && !isId(value.id)) return null
    return hasId
      ? { jsonrpc: '2.0', id: value.id as JsonRpcId, method: value.method, ...('params' in value ? { params: value.params } : {}) }
      : { jsonrpc: '2.0', method: value.method, ...('params' in value ? { params: value.params } : {}) }
  }
  const hasResult = 'result' in value
  if (hasResult === 'error' in value) return null
  if (hasResult) return hasId && isId(value.id) ? { jsonrpc: '2.0', id: value.id, result: value.result } : null
  const error = value.error
  if (!isObject(error) || typeof error.code !== 'number' || typeof error.message !== 'string') return null
  if (hasId && value.id !== null && !isId(value.id)) return null
  return {
    jsonrpc: '2.0',
    id: hasId ? (value.id as JsonRpcId | null) : null,
    error: { code: error.code, message: error.message, ...('data' in error ? { data: error.data } : {}) },
  }
}

/** Parses the text of one message (or, from older servers, an array of them). */
export function parseMessages(text: string): JsonRpcMessage[] {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new ProtocolError('The server sent text that is not JSON.')
  }
  const items = Array.isArray(value) ? value : [value]
  if (!items.length || items.length > MAX_BATCH) throw new ProtocolError('The server sent an empty or oversized batch.')
  return items.map((item) => {
    const message = toMessage(item)
    if (!message) throw new ProtocolError('The server sent JSON that is not a JSON-RPC 2.0 message.')
    return message
  })
}

export const isRequest = (message: JsonRpcMessage): message is JsonRpcRequest => 'method' in message && 'id' in message
export const isNotification = (message: JsonRpcMessage): message is JsonRpcNotification => 'method' in message && !('id' in message)
export const isResponse = (message: JsonRpcMessage): message is JsonRpcResponse => !('method' in message)

// ---------------------------------------------------------------------------
// Transports

export interface SendOptions {
  signal?: AbortSignal
}

/**
 * One way of moving messages: stdio, Streamable HTTP, legacy SSE, or memory
 * in the tests. A transport never interprets messages; it delivers them.
 */
export interface Transport {
  onmessage?: (message: JsonRpcMessage) => void
  /** Called once, when the transport can carry no more messages. */
  onclose?: (reason?: Error) => void
  /** Trouble that does not end the connection (a line that was not JSON). */
  onerror?: (error: Error) => void
  /** Opens the transport. */
  start?(): Promise<void>
  /** The protocol version agreed with the server; HTTP requests after the handshake must carry it. */
  setProtocolVersion?(version: string): void
  /** The handshake is complete: a transport may now listen for messages the server starts on its own. */
  ready?(): void
  send(message: JsonRpcMessage, options?: SendOptions): Promise<void>
  close(): Promise<void>
}

// ---------------------------------------------------------------------------
// The connection

export interface Progress {
  progress: number
  total?: number
  message?: string
}

export interface RequestOptions {
  signal?: AbortSignal
  timeoutMs?: number
  /** Called for each progress notification the other side sends for this request. */
  onProgress?: (progress: Progress) => void
  /** Progress counts as life: the timeout starts over each time it arrives. */
  resetTimeoutOnProgress?: boolean
  /** The longest the request may take, progress or not. */
  maxTotalMs?: number
}

export interface IncomingHandlers {
  /** Answers a request from the other side. Throw `McpError` to answer with an error. */
  request?(method: string, params: unknown, signal: AbortSignal): Promise<unknown>
  notification?(method: string, params: unknown): void
}

interface Pending {
  method: string
  resolve(value: unknown): void
  reject(error: Error): void
  timer?: ReturnType<typeof setTimeout>
  startedAt: number
  timeoutMs?: number
  maxTotalMs?: number
  onProgress?: (progress: Progress) => void
  resetOnProgress: boolean
  detach(): void
}

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000

function abortReason(signal: AbortSignal): Error {
  const reason = signal.reason
  if (reason instanceof Error) return reason
  const error = new Error(typeof reason === 'string' && reason ? reason : 'The request was cancelled.')
  error.name = 'AbortError'
  return error
}

function progressOf(params: unknown): { token: JsonRpcId; progress: Progress } | null {
  if (!isObject(params) || !isId(params.progressToken) || typeof params.progress !== 'number' || !Number.isFinite(params.progress)) return null
  return {
    token: params.progressToken,
    progress: {
      progress: params.progress,
      ...(typeof params.total === 'number' && Number.isFinite(params.total) ? { total: params.total } : {}),
      ...(typeof params.message === 'string' ? { message: params.message.slice(0, 500) } : {}),
    },
  }
}

export class Connection {
  private nextId = 1
  private readonly pending = new Map<JsonRpcId, Pending>()
  private readonly serving = new Map<JsonRpcId, AbortController>()
  private closed = false
  /** Called once when the connection ends, from either side, with why. */
  onclose?: (reason?: Error) => void

  constructor(
    private readonly transport: Transport,
    private readonly handlers: IncomingHandlers = {},
  ) {
    transport.onmessage = (message) => this.receive(message)
    transport.onclose = (reason) => this.shutdown(reason)
  }

  /** Sends a request and resolves with its result. Rejects with `McpError` when the other side answers with an error. */
  request<T = unknown>(method: string, params?: unknown, options: RequestOptions = {}): Promise<T> {
    if (this.closed) return Promise.reject(new ConnectionClosedError())
    if (options.signal?.aborted) return Promise.reject(abortReason(options.signal))
    const id = this.nextId++
    const body = options.onProgress ? { ...(isObject(params) ? params : {}), _meta: { ...(isObject(params) && isObject(params._meta) ? params._meta : {}), progressToken: id } } : params
    const message: JsonRpcRequest = { jsonrpc: '2.0', id, method, ...(body === undefined ? {} : { params: body }) }

    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        if (this.settle(id)) {
          this.cancel(id, options.signal ? abortReason(options.signal).message : 'cancelled')
          reject(abortReason(options.signal!))
        }
      }
      const pending: Pending = {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        startedAt: Date.now(),
        timeoutMs: options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
        maxTotalMs: options.maxTotalMs,
        onProgress: options.onProgress,
        resetOnProgress: options.resetTimeoutOnProgress === true,
        detach: () => options.signal?.removeEventListener('abort', onAbort),
      }
      this.pending.set(id, pending)
      options.signal?.addEventListener('abort', onAbort, { once: true })
      this.arm(id, pending)
      this.transport.send(message, { signal: options.signal }).catch((error: unknown) => {
        if (this.settle(id)) reject(error instanceof Error ? error : new Error(String(error)))
      })
    })
  }

  notify(method: string, params?: unknown): Promise<void> {
    if (this.closed) return Promise.reject(new ConnectionClosedError())
    return this.transport.send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.shutdown()
    await this.transport.close()
  }

  // -------------------------------------------------------------------------

  /** Removes a request from the table; true when it was still waiting. */
  private settle(id: JsonRpcId): boolean {
    const pending = this.pending.get(id)
    if (!pending) return false
    this.pending.delete(id)
    if (pending.timer) clearTimeout(pending.timer)
    pending.detach()
    return true
  }

  private arm(id: JsonRpcId, pending: Pending): void {
    if (pending.timer) clearTimeout(pending.timer)
    if (pending.timeoutMs === undefined) return
    let wait = pending.timeoutMs
    if (pending.maxTotalMs !== undefined) wait = Math.min(wait, Math.max(0, pending.maxTotalMs - (Date.now() - pending.startedAt)))
    pending.timer = setTimeout(() => {
      if (!this.settle(id)) return
      this.cancel(id, 'timed out')
      pending.reject(new RequestTimeoutError(pending.method, pending.timeoutMs ?? wait))
    }, wait)
  }

  private cancel(id: JsonRpcId, reason: string): void {
    if (this.closed) return
    void this.transport.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: reason.slice(0, 200) } }).catch(() => {})
  }

  private receive(message: JsonRpcMessage): void {
    if (isResponse(message)) {
      if (message.id === null) return
      const pending = this.pending.get(message.id)
      if (!pending || !this.settle(message.id)) return
      if ('error' in message) pending.reject(new McpError(message.error.code, message.error.message, message.error.data))
      else pending.resolve(message.result)
      return
    }
    if (isRequest(message)) {
      void this.serve(message)
      return
    }
    if (message.method === 'notifications/progress') {
      const progress = progressOf(message.params)
      const pending = progress ? this.pending.get(progress.token) : undefined
      if (progress && pending) {
        pending.onProgress?.(progress.progress)
        if (pending.resetOnProgress) this.arm(progress.token, pending)
      }
      return
    }
    if (message.method === 'notifications/cancelled') {
      const requestId = isObject(message.params) ? message.params.requestId : undefined
      if (isId(requestId)) this.serving.get(requestId)?.abort(new Error('The other side cancelled the request.'))
      return
    }
    try {
      this.handlers.notification?.(message.method, message.params)
    } catch {
      // A handler that fails must not take the connection down.
    }
  }

  private async serve(request: JsonRpcRequest): Promise<void> {
    const controller = new AbortController()
    this.serving.set(request.id, controller)
    try {
      let result: unknown
      if (request.method === 'ping') result = {}
      else if (!this.handlers.request) throw new McpError(ErrorCode.MethodNotFound, `Method not found: ${request.method}`)
      else result = await this.handlers.request(request.method, request.params, controller.signal)
      await this.reply({ jsonrpc: '2.0', id: request.id, result: result ?? {} })
    } catch (error) {
      const body: JsonRpcErrorBody =
        error instanceof McpError ? { code: error.code, message: error.message, ...(error.data === undefined ? {} : { data: error.data }) } : { code: ErrorCode.InternalError, message: 'Internal error' }
      await this.reply({ jsonrpc: '2.0', id: request.id, error: body })
    } finally {
      this.serving.delete(request.id)
    }
  }

  private async reply(message: JsonRpcResponse): Promise<void> {
    if (this.closed) return
    try {
      await this.transport.send(message)
    } catch {
      // The other side is gone; nothing to tell.
    }
  }

  private shutdown(reason?: Error): void {
    if (this.closed) return
    this.closed = true
    this.onclose?.(reason)
    for (const controller of this.serving.values()) controller.abort(new ConnectionClosedError())
    this.serving.clear()
    for (const id of [...this.pending.keys()]) {
      const pending = this.pending.get(id)
      if (pending && this.settle(id)) pending.reject(new ConnectionClosedError(reason?.message ?? 'The connection closed.'))
    }
  }
}
