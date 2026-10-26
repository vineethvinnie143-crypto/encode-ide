/**
 * A connection to a debug adapter over the Debug Adapter Protocol (ADR 0144): requests answered by their sequence
 * number, events, and the few requests an adapter sends back. Each message is JSON behind a `Content-Length` header,
 * over the adapter's standard input and output or a socket it dialed in on.
 *
 * The adapter is a separate program (debugpy, Delve, lldb-dap), so what it sends is read with care: a header block
 * that never ends, a body over the limit or text that is not JSON ends the connection instead of growing a buffer
 * without bound; an answer to a request never made is dropped; a request never answered times out.
 */
import type { Readable, Writable } from 'node:stream'

const MAX_HEADER_BYTES = 8 * 1024
const DEFAULT_MAX_MESSAGE_BYTES = 64 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_ERROR_CHARS = 2_000

/** An error answer from the adapter, or a request lost with the connection or never answered. */
export class DapError extends Error {
  override name = 'DapError'
  constructor(
    message: string,
    readonly code: 'failed' | 'closed' | 'timeout',
  ) {
    super(message)
  }
}

export type DapEvent = { event: string; body: Record<string, unknown> }

/** A request the adapter sends: throw to answer that it failed. */
export type DapRequestHandler = (command: string, args: Record<string, unknown>) => unknown | Promise<unknown>

export interface DapOptions {
  onEvent?(event: DapEvent): void
  /** Default: every request the adapter sends is answered as not supported. */
  onRequest?: DapRequestHandler
  /** The connection broke: the stream ended, or the adapter broke the protocol. Called once. */
  onClose?(reason: string): void
  maxMessageBytes?: number
}

interface Pending {
  command: string
  resolve(value: Record<string, unknown>): void
  reject(error: Error): void
  timer: NodeJS.Timeout | undefined
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** An error's text as the adapter wrote it: `body.error.format` with its `{variables}` filled in, else `message`. */
export function dapErrorText(message: Record<string, unknown>, command: string): string {
  const body = isRecord(message.body) ? message.body : {}
  const error = isRecord(body.error) ? body.error : null
  let text: string | null = null
  if (error && typeof error.format === 'string') {
    const variables = isRecord(error.variables) ? error.variables : {}
    text = error.format.replace(/\{([^}]*)\}/g, (whole, name: string) => (typeof variables[name] === 'string' ? (variables[name] as string) : whole))
  }
  if (!text && typeof message.message === 'string' && message.message.trim()) text = message.message
  return (text?.trim() || `The debugger could not do ${command}.`).slice(0, MAX_ERROR_CHARS)
}

export class DapConnection {
  private buffer: Buffer = Buffer.alloc(0)
  private expected: number | null = null
  private seq = 1
  private readonly pending = new Map<number, Pending>()
  private closedWith: string | null = null
  private readonly maxBytes: number
  private readonly detach: () => void

  constructor(
    input: Readable,
    private readonly output: Writable,
    private readonly options: DapOptions = {},
  ) {
    this.maxBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES
    const onData = (chunk: Buffer) => this.receive(chunk)
    const onEnd = () => this.close('The debugger closed its connection.')
    const onError = (error: Error) => this.close(`The debugger's connection failed: ${error.message}`)
    input.on('data', onData)
    input.on('end', onEnd)
    input.on('close', onEnd)
    input.on('error', onError)
    output.on('error', onError)
    this.detach = () => {
      input.off('data', onData)
      input.off('end', onEnd)
      input.off('close', onEnd)
      input.off('error', onError)
      output.off('error', onError)
    }
  }

  get closed(): boolean {
    return this.closedWith !== null
  }

  /** Sends a request; its answer's body, or a DapError. `timeoutMs` 0 waits as long as the connection lasts. */
  request(command: string, args?: Record<string, unknown>, options: { timeoutMs?: number } = {}): Promise<Record<string, unknown>> {
    if (this.closedWith !== null) return Promise.reject(new DapError(this.closedWith, 'closed'))
    const seq = this.seq++
    return new Promise((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
      this.pending.set(seq, {
        command,
        resolve,
        reject,
        timer:
          timeoutMs > 0
            ? setTimeout(() => {
                this.settle(seq)?.reject(new DapError(`The debugger did not answer ${command} within ${Math.round(timeoutMs / 1000)} s.`, 'timeout'))
              }, timeoutMs)
            : undefined,
      })
      this.send({ seq, type: 'request', command, ...(args === undefined ? {} : { arguments: args }) })
    })
  }

  /** Ends the connection; what still waits is refused with `reason`. */
  close(reason = 'The debugger connection was closed.'): void {
    if (this.closedWith !== null) return
    this.closedWith = reason
    this.detach()
    for (const seq of [...this.pending.keys()]) this.settle(seq)?.reject(new DapError(reason, 'closed'))
    this.buffer = Buffer.alloc(0)
    try {
      this.options.onClose?.(reason)
    } catch {
      /* a listener's trouble is its own */
    }
  }

  private settle(seq: number): Pending | undefined {
    const pending = this.pending.get(seq)
    if (!pending) return undefined
    this.pending.delete(seq)
    if (pending.timer) clearTimeout(pending.timer)
    return pending
  }

  private send(message: Record<string, unknown>): void {
    if (this.closedWith !== null) return
    const body = Buffer.from(JSON.stringify(message), 'utf8')
    try {
      this.output.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]))
    } catch (error) {
      this.close(`The debugger's input failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private receive(chunk: Buffer): void {
    if (this.closedWith !== null) return
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    for (;;) {
      if (this.expected === null) {
        const end = this.buffer.indexOf('\r\n\r\n')
        if (end < 0) {
          if (this.buffer.length > MAX_HEADER_BYTES) return this.close('The debugger sent a header that never ended.')
          return
        }
        const length = contentLength(this.buffer.subarray(0, end).toString('ascii'))
        this.buffer = this.buffer.subarray(end + 4)
        if (length === null) return this.close('The debugger sent a message without a valid Content-Length.')
        if (length > this.maxBytes) return this.close(`The debugger sent a message of ${length} bytes, more than the ${this.maxBytes} allowed.`)
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
        return this.close('The debugger sent a message that is not JSON.')
      }
      if (isRecord(message)) this.dispatch(message)
      if (this.closedWith !== null) return
    }
  }

  private dispatch(message: Record<string, unknown>): void {
    switch (message.type) {
      case 'response': {
        if (typeof message.request_seq !== 'number') return
        const pending = this.settle(message.request_seq)
        if (!pending) return
        if (message.success === true) pending.resolve(isRecord(message.body) ? message.body : {})
        else pending.reject(new DapError(dapErrorText(message, pending.command), 'failed'))
        return
      }
      case 'event':
        if (typeof message.event !== 'string') return
        try {
          this.options.onEvent?.({ event: message.event, body: isRecord(message.body) ? message.body : {} })
        } catch {
          // A handler's own failure must not end the connection.
        }
        return
      case 'request':
        if (typeof message.command === 'string' && typeof message.seq === 'number') void this.answer(message.seq, message.command, isRecord(message.arguments) ? message.arguments : {})
        return
    }
  }

  private async answer(seq: number, command: string, args: Record<string, unknown>): Promise<void> {
    try {
      if (!this.options.onRequest) throw new Error(`eNCode does not do ${command}.`)
      const body = await this.options.onRequest(command, args)
      this.send({ seq: this.seq++, type: 'response', request_seq: seq, command, success: true, ...(isRecord(body) ? { body } : {}) })
    } catch (error) {
      this.send({ seq: this.seq++, type: 'response', request_seq: seq, command, success: false, message: error instanceof Error ? error.message : String(error) })
    }
  }
}

function contentLength(header: string): number | null {
  let length: number | null = null
  for (const line of header.split('\r\n')) {
    const colon = line.indexOf(':')
    if (colon < 0) continue
    if (line.slice(0, colon).trim().toLowerCase() !== 'content-length') continue
    const value = line.slice(colon + 1).trim()
    if (!/^\d{1,10}$/.test(value)) return null
    length = Number(value)
  }
  return length
}
