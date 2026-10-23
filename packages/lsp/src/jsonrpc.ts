/**
 * The base protocol of the Language Server Protocol: JSON-RPC 2.0 messages, each behind a `Content-Length` header,
 * over a server's standard input and output. Everything from the server is untrusted: a header block that never ends,
 * a body larger than the limit, or text that is not JSON ends the connection instead of growing a buffer without
 * bound. A request can be stopped (`$/cancelRequest`) and times out; its late answer is dropped.
 */
import type { Readable, Writable } from 'node:stream'

export const JSONRPC_ERRORS = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  serverNotInitialized: -32002,
  requestCancelled: -32800,
  contentModified: -32801,
} as const

const MAX_HEADER_BYTES = 8 * 1024
const DEFAULT_MAX_MESSAGE_BYTES = 64 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 30_000

/** A JSON-RPC error answer, or a request that was stopped, timed out or lost with the connection. */
export class RpcFailure extends Error {
  constructor(
    message: string,
    /** The server's error code, or what ended the request on this side. */
    readonly code: number | 'cancelled' | 'timeout' | 'closed',
    readonly data?: unknown,
  ) {
    super(message)
    this.name = 'RpcFailure'
  }
}

export type RequestHandler = (method: string, params: unknown) => unknown | Promise<unknown>
export type NotificationHandler = (method: string, params: unknown) => void

export interface ConnectionOptions {
  /** A request from the server; throw an RpcFailure with a numeric code to answer with that error. Default: method not found. */
  onRequest?: RequestHandler
  onNotification?: NotificationHandler
  /** The connection broke: the stream ended, or the other side broke the protocol. Called once. */
  onClose?(reason: string): void
  maxMessageBytes?: number
}

interface Pending {
  method: string
  resolve(value: unknown): void
  reject(error: Error): void
  timer: NodeJS.Timeout | undefined
  cleanup(): void
}

export interface RequestOptions {
  signal?: AbortSignal
  /** 0: no time limit. Default 30 s. */
  timeoutMs?: number
}

export class JsonRpcConnection {
  private buffer: Buffer = Buffer.alloc(0)
  private expected: number | null = null
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private closedWith: string | null = null
  private readonly maxBytes: number
  private readonly detach: () => void

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly options: ConnectionOptions = {},
  ) {
    this.maxBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES
    const onData = (chunk: Buffer) => this.receive(chunk)
    const onEnd = () => this.close('The language server closed its output.')
    const onError = (error: Error) => this.close(`The language server's output failed: ${error.message}`)
    const onOutputError = (error: Error) => this.close(`The language server's input failed: ${error.message}`)
    input.on('data', onData)
    input.on('end', onEnd)
    input.on('error', onError)
    output.on('error', onOutputError)
    this.detach = () => {
      input.off('data', onData)
      input.off('end', onEnd)
      input.off('error', onError)
      output.off('error', onOutputError)
    }
  }

  get closed(): boolean {
    return this.closedWith !== null
  }

  request<T = unknown>(method: string, params: unknown, options: RequestOptions = {}): Promise<T> {
    if (this.closedWith !== null) return Promise.reject(new RpcFailure(this.closedWith, 'closed'))
    if (options.signal?.aborted) return Promise.reject(new RpcFailure(`${method} was stopped.`, 'cancelled'))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
      const onAbort = () => {
        this.settle(id)?.reject(new RpcFailure(`${method} was stopped.`, 'cancelled'))
        this.cancel(id)
      }
      const pending: Pending = {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer: timeoutMs > 0
          ? setTimeout(() => {
              this.settle(id)?.reject(new RpcFailure(`The language server did not answer ${method} within ${Math.round(timeoutMs / 1000)} s.`, 'timeout'))
              this.cancel(id)
            }, timeoutMs)
          : undefined,
        cleanup: () => options.signal?.removeEventListener('abort', onAbort),
      }
      this.pending.set(id, pending)
      options.signal?.addEventListener('abort', onAbort, { once: true })
      this.send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })
    })
  }

  notify(method: string, params?: unknown): void {
    if (this.closedWith !== null) return
    this.send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })
  }

  /** Ends the connection; what still waits is refused with `reason`. */
  close(reason = 'The connection was closed.'): void {
    if (this.closedWith !== null) return
    this.closedWith = reason
    this.detach()
    for (const id of [...this.pending.keys()]) this.settle(id)?.reject(new RpcFailure(reason, 'closed'))
    this.buffer = Buffer.alloc(0)
    this.options.onClose?.(reason)
  }

  private cancel(id: number): void {
    this.notify('$/cancelRequest', { id })
  }

  private settle(id: number): Pending | undefined {
    const pending = this.pending.get(id)
    if (!pending) return undefined
    this.pending.delete(id)
    if (pending.timer) clearTimeout(pending.timer)
    pending.cleanup()
    return pending
  }

  private send(message: object): void {
    let body: Buffer
    try {
      body = Buffer.from(JSON.stringify(message), 'utf8')
    } catch (error) {
      throw new Error(`A message for the language server could not be written: ${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      this.output.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]))
    } catch (error) {
      this.close(`The language server's input failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private receive(chunk: Buffer): void {
    if (this.closedWith !== null) return
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    for (;;) {
      if (this.expected === null) {
        const end = this.buffer.indexOf('\r\n\r\n')
        if (end < 0) {
          if (this.buffer.length > MAX_HEADER_BYTES) return this.close('The language server sent a header that never ended.')
          return
        }
        const header = this.buffer.subarray(0, end).toString('ascii')
        this.buffer = this.buffer.subarray(end + 4)
        const length = contentLength(header)
        if (length === null) return this.close('The language server sent a message without a valid Content-Length.')
        if (length > this.maxBytes) return this.close(`The language server sent a message of ${length} bytes, more than the ${this.maxBytes} allowed.`)
        this.expected = length
      }
      if (this.buffer.length < this.expected) return
      const body = this.buffer.subarray(0, this.expected)
      this.buffer = this.buffer.subarray(this.expected)
      this.expected = null
      let message: unknown
      try {
        message = JSON.parse(body.toString('utf8'))
      } catch {
        return this.close('The language server sent a message that is not JSON.')
      }
      // A batch is legal JSON-RPC, though no language server sends one.
      for (const item of Array.isArray(message) ? message : [message]) this.dispatch(item)
      if (this.closedWith !== null) return
    }
  }

  private dispatch(message: unknown): void {
    if (!message || typeof message !== 'object') return
    const record = message as { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown }
    const hasId = typeof record.id === 'number' || typeof record.id === 'string'
    if (typeof record.method === 'string') {
      if (hasId) void this.answer(record.id as number | string, record.method, record.params)
      else {
        try {
          this.options.onNotification?.(record.method, record.params)
        } catch {
          // A handler's own failure must not end the connection.
        }
      }
      return
    }
    if (typeof record.id !== 'number') return
    const pending = this.settle(record.id)
    if (!pending) return
    if (record.error && typeof record.error === 'object') {
      const error = record.error as { code?: unknown; message?: unknown; data?: unknown }
      const code = typeof error.code === 'number' ? error.code : JSONRPC_ERRORS.internalError
      const text = typeof error.message === 'string' ? error.message.slice(0, 2_000) : `${pending.method} failed.`
      pending.reject(new RpcFailure(text, code, error.data))
      return
    }
    pending.resolve(record.result ?? null)
  }

  private async answer(id: number | string, method: string, params: unknown): Promise<void> {
    try {
      if (!this.options.onRequest) throw new RpcFailure(`eNCode does not handle ${method}.`, JSONRPC_ERRORS.methodNotFound)
      const result = await this.options.onRequest(method, params)
      this.send({ jsonrpc: '2.0', id, result: result ?? null })
    } catch (error) {
      const code = error instanceof RpcFailure && typeof error.code === 'number' ? error.code : JSONRPC_ERRORS.internalError
      const message = error instanceof Error ? error.message : String(error)
      if (this.closedWith === null) this.send({ jsonrpc: '2.0', id, error: { code, message } })
    }
  }
}

function contentLength(header: string): number | null {
  let length: number | null = null
  for (const line of header.split('\r\n')) {
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const name = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()
    if (name === 'content-length') {
      if (!/^\d{1,10}$/.test(value)) return null
      length = Number(value)
    }
  }
  return length
}
