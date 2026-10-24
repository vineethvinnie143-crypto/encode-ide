/**
 * Ports over a byte stream, for a host that runs at the other end of a pipe: the agent on another machine, reached
 * through `ssh` (ADR 0111). One line of JSON is one message, so a stream carries several channels at once, each a Port
 * of its own: `{"c":"<channel>","e":<envelope>}\n`.
 *
 * JSON keeps less than structured cloning does. Bytes (a Uint8Array or an ArrayBuffer) are written as base64 and come
 * back as a Uint8Array; `undefined` in an object is left out, as structured cloning of a plain object would keep it.
 * Everything else the RPC sends is plain data already.
 *
 * What arrives is untrusted: a line that is not JSON, names no channel, or is longer than the limit is reported and
 * dropped, and a stream that sends a line past the limit is closed, since what follows can no longer be framed.
 */
import { RpcError, type Envelope, type Port } from './rpc'

/** What `process.stdin`, a child's stdout or a socket offer (listeners are typed loosely, as Node's own are). */
export interface ByteSource {
  on(event: string, listener: (...args: any[]) => void): unknown
  off?(event: string, listener: (...args: any[]) => void): unknown
  removeListener?(event: string, listener: (...args: any[]) => void): unknown
}

/** What `process.stdout`, a child's stdin or a socket offer. */
export interface ByteSink {
  write(chunk: string): boolean
  end?(): unknown
  on?(event: string, listener: (...args: any[]) => void): unknown
}

export interface StreamChannelsOptions {
  /** The longest line read, in bytes. Default 192 MiB: a file the editor opens, as JSON. */
  maxLineBytes?: number
  /** A line that was dropped, or a stream that failed. */
  onProblem?(error: Error): void
}

export interface StreamChannels {
  /** The port of one channel. Asking twice for the same name gives the same port. */
  port(name: string): Port
  /** Calls `handler` once, when the stream has ended or was closed. */
  onClose(handler: () => void): () => void
  /** Ends the stream; every channel's port closes. */
  close(): void
  readonly closed: boolean
}

const BYTES = '$encode.bytes'
const DEFAULT_MAX_LINE = 192 * 1024 * 1024
const NEWLINE = 0x0a

/** A message as one line: bytes become `{"$encode.bytes": base64}`. */
export function encodeLine(value: unknown): string {
  return JSON.stringify(value, function (this: unknown, key: string, item: unknown) {
    // JSON.stringify calls toJSON on a Buffer before the replacer sees it, so its bytes are read from the holder.
    const raw = key === '' ? item : (this as Record<string, unknown>)[key]
    if (raw instanceof Uint8Array) return { [BYTES]: Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('base64') }
    if (raw instanceof ArrayBuffer) return { [BYTES]: Buffer.from(raw).toString('base64') }
    return item
  })
}

/** The other way: `{"$encode.bytes": base64}` is a Uint8Array again. */
export function decodeLine(line: string): unknown {
  return JSON.parse(line, (_key, item: unknown) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const keys = Object.keys(item)
      if (keys.length === 1 && keys[0] === BYTES) {
        const text = (item as Record<string, unknown>)[BYTES]
        if (typeof text === 'string') return new Uint8Array(Buffer.from(text, 'base64'))
      }
    }
    return item
  })
}

function detach(source: ByteSource, event: string, listener: (...args: any[]) => void): void {
  const off = source.off ?? source.removeListener
  off?.call(source, event, listener)
}

/** Channels of messages over a pair of byte streams: `input` is read, `output` is written. */
export function streamChannels(input: ByteSource, output: ByteSink, options: StreamChannelsOptions = {}): StreamChannels {
  const maxLine = options.maxLineBytes ?? DEFAULT_MAX_LINE
  const problem = (message: string) => options.onProblem?.(new RpcError('invalid-message', message))
  const handlers = new Map<string, Set<(message: unknown) => void>>()
  const closeHandlers = new Set<() => void>()
  const ports = new Map<string, Port>()
  let pending: Buffer[] = []
  let pendingBytes = 0
  let closed = false

  const dispatch = (line: Buffer) => {
    if (line.length === 0) return
    let message: unknown
    try {
      message = decodeLine(line.toString('utf8'))
    } catch {
      problem('A line from the other side was not JSON.')
      return
    }
    const channel = (message as { c?: unknown } | null)?.c
    if (typeof channel !== 'string') {
      problem('A message from the other side named no channel.')
      return
    }
    const set = handlers.get(channel)
    if (!set) return
    for (const handler of [...set]) handler((message as { e?: unknown }).e)
  }

  const onData = (chunk: Uint8Array | string) => {
    if (closed) return
    let data = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    let at = data.indexOf(NEWLINE)
    while (at !== -1) {
      const tail = data.subarray(0, at)
      const line = pending.length ? Buffer.concat([...pending, tail]) : tail
      pending = []
      pendingBytes = 0
      if (line.length > maxLine) problem(`A message from the other side was longer than ${maxLine} bytes.`)
      else dispatch(line)
      if (closed) return
      data = data.subarray(at + 1)
      at = data.indexOf(NEWLINE)
    }
    if (data.length) {
      pendingBytes += data.length
      if (pendingBytes > maxLine) {
        problem(`A message from the other side was longer than ${maxLine} bytes; the connection was closed.`)
        finish()
        return
      }
      // A copy: the stream may reuse its chunk's memory.
      pending.push(Buffer.from(data))
    }
  }

  const finish = () => {
    if (closed) return
    closed = true
    pending = []
    detach(input, 'data', onData)
    detach(input, 'end', finish)
    detach(input, 'close', finish)
    for (const handler of [...closeHandlers]) handler()
    closeHandlers.clear()
    handlers.clear()
  }
  const onError = (error: Error) => {
    options.onProblem?.(error)
    finish()
  }

  input.on('data', onData)
  input.on('end', finish)
  input.on('close', finish)
  input.on('error', onError)
  output.on?.('error', onError)

  const port = (name: string): Port => {
    const existing = ports.get(name)
    if (existing) return existing
    const made: Port = {
      post(message: Envelope) {
        if (closed) throw new RpcError('closed', 'The connection is closed.')
        output.write(`${encodeLine({ c: name, e: message })}\n`)
      },
      listen(handler) {
        let set = handlers.get(name)
        if (!set) handlers.set(name, (set = new Set()))
        set.add(handler)
        return () => {
          handlers.get(name)?.delete(handler)
        }
      },
      onClose(handler) {
        if (closed) {
          queueMicrotask(handler)
          return () => {}
        }
        closeHandlers.add(handler)
        return () => {
          closeHandlers.delete(handler)
        }
      },
    }
    ports.set(name, made)
    return made
  }

  return {
    port,
    onClose(handler) {
      if (closed) {
        queueMicrotask(handler)
        return () => {}
      }
      closeHandlers.add(handler)
      return () => {
        closeHandlers.delete(handler)
      }
    },
    close() {
      if (closed) return
      try {
        output.end?.()
      } catch {
        /* already gone */
      }
      finish()
    },
    get closed() {
      return closed
    },
  }
}
