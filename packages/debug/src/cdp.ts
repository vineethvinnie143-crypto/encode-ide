/**
 * A connection to a program's inspector over the Chrome DevTools Protocol: requests answered by id, and events. It
 * runs over the WebSocket Node.js has built in; tests give it a socket of their own.
 *
 * The program at the other end is the person's own, but what it sends is still read with care: an answer that is not
 * JSON, or one to a request never made, is dropped; a request that is never answered times out.
 */

/** What the connection needs of a WebSocket: the subset of the standard one that Node.js has. */
export interface SocketLike {
  send(data: string): void
  close(): void
  addEventListener(type: 'open', listener: () => void): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  addEventListener(type: 'close', listener: () => void): void
  addEventListener(type: 'error', listener: (event: unknown) => void): void
}

export type SocketFactory = (url: string) => SocketLike

/** An error answer from the program, or a request lost with the connection or never answered. */
export class CdpError extends Error {
  override name = 'CdpError'
  constructor(
    message: string,
    readonly code: number | 'closed' | 'timeout',
  ) {
    super(message)
  }
}

const DEFAULT_TIMEOUT_MS = 30_000
const CONNECT_TIMEOUT_MS = 10_000

interface Pending {
  method: string
  resolve(value: unknown): void
  reject(error: Error): void
  timer: NodeJS.Timeout | undefined
}

export type CdpListener = (method: string, params: Record<string, unknown>) => void

export class CdpConnection {
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly listeners = new Set<CdpListener>()
  private readonly closers = new Set<(reason: string) => void>()
  private closedWith: string | null = null

  private constructor(private readonly socket: SocketLike) {
    socket.addEventListener('message', (event) => this.receive(event.data))
    socket.addEventListener('close', () => this.end('The program closed its debugger connection.'))
    socket.addEventListener('error', () => this.end('The debugger connection failed.'))
  }

  /** Opens a connection to `url` (`ws://127.0.0.1:port/id`); fails when it does not open in time. */
  static connect(url: string, options: { socket?: SocketFactory; timeoutMs?: number } = {}): Promise<CdpConnection> {
    const factory = options.socket ?? defaultSocket
    return new Promise((resolve, reject) => {
      let socket: SocketLike
      try {
        socket = factory(url)
      } catch (error) {
        reject(new CdpError(`The debugger could not connect: ${error instanceof Error ? error.message : String(error)}`, 'closed'))
        return
      }
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try {
          socket.close()
        } catch {
          /* already closed */
        }
        reject(new CdpError('The program did not answer the debugger in time.', 'timeout'))
      }, options.timeoutMs ?? CONNECT_TIMEOUT_MS)
      // Made before it opens, so no early message is missed.
      const connection = new CdpConnection(socket)
      socket.addEventListener('open', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(connection)
      })
      const fail = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(new CdpError('The debugger could not connect to the program.', 'closed'))
      }
      socket.addEventListener('error', fail)
      socket.addEventListener('close', fail)
    })
  }

  get closed(): boolean {
    return this.closedWith !== null
  }

  /** Sends a request and waits for its answer. */
  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, options: { timeoutMs?: number } = {}): Promise<T> {
    if (this.closedWith !== null) return Promise.reject(new CdpError(this.closedWith, 'closed'))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              if (!this.pending.delete(id)) return
              reject(new CdpError(`The program did not answer ${method} in time.`, 'timeout'))
            }, timeoutMs)
          : undefined
      timer?.unref?.()
      this.pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject, timer })
      try {
        this.socket.send(JSON.stringify({ id, method, params }))
      } catch (error) {
        this.pending.delete(id)
        if (timer) clearTimeout(timer)
        reject(new CdpError(`The debugger could not send ${method}: ${error instanceof Error ? error.message : String(error)}`, 'closed'))
      }
    })
  }

  /** Every event, by its method ("Debugger.paused"). Returns what stops listening. */
  onEvent(listener: CdpListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Called once, when the connection ends for any reason. */
  onClose(listener: (reason: string) => void): void {
    if (this.closedWith !== null) listener(this.closedWith)
    else this.closers.add(listener)
  }

  close(): void {
    try {
      this.socket.close()
    } catch {
      /* already closed */
    }
    this.end('The debugger disconnected.')
  }

  private receive(data: unknown): void {
    if (this.closedWith !== null) return
    const text = typeof data === 'string' ? data : data instanceof ArrayBuffer ? Buffer.from(data).toString('utf8') : ArrayBuffer.isView(data) ? Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8') : null
    if (text === null) return
    let message: { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown } }
    try {
      message = JSON.parse(text)
    } catch {
      return
    }
    if (!message || typeof message !== 'object') return
    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (pending.timer) clearTimeout(pending.timer)
      if (message.error) {
        const code = typeof message.error.code === 'number' ? message.error.code : -1
        pending.reject(new CdpError(typeof message.error.message === 'string' ? message.error.message : `${pending.method} failed.`, code))
      } else pending.resolve(message.result && typeof message.result === 'object' ? message.result : {})
      return
    }
    if (typeof message.method !== 'string') return
    const params = message.params && typeof message.params === 'object' ? (message.params as Record<string, unknown>) : {}
    for (const listener of [...this.listeners]) {
      try {
        listener(message.method, params)
      } catch {
        /* one listener's fault is not the connection's */
      }
    }
  }

  private end(reason: string): void {
    if (this.closedWith !== null) return
    this.closedWith = reason
    for (const [, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer)
      pending.reject(new CdpError(reason, 'closed'))
    }
    this.pending.clear()
    for (const closer of [...this.closers]) closer(reason)
    this.closers.clear()
    this.listeners.clear()
  }
}

function defaultSocket(url: string): SocketLike {
  const WebSocketClass = (globalThis as { WebSocket?: new (url: string) => SocketLike }).WebSocket
  if (!WebSocketClass) throw new Error('This Node.js has no WebSocket; Node.js 22 or later is needed.')
  return new WebSocketClass(url)
}

/** The inspector of a program that listens on a port: its WebSocket address, from its `/json/list`. */
export async function inspectorTargets(host: string, port: number, options: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<{ id: string; title: string; url: string; webSocketDebuggerUrl: string }[]> {
  const fetcher = options.fetch ?? fetch
  const signal = AbortSignal.timeout(options.timeoutMs ?? 5_000)
  const where = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  const response = await fetcher(`http://${where}:${port}/json/list`, { signal })
  if (!response.ok) throw new Error(`The inspector at ${host}:${port} answered ${response.status}.`)
  const text = await response.text()
  if (text.length > 1024 * 1024) throw new Error(`The inspector at ${host}:${port} answered with too much.`)
  const list = JSON.parse(text) as unknown
  if (!Array.isArray(list)) throw new Error(`The inspector at ${host}:${port} did not list its targets.`)
  return list
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && typeof (item as { webSocketDebuggerUrl?: unknown }).webSocketDebuggerUrl === 'string')
    .map((item) => ({ id: String(item.id ?? ''), title: String(item.title ?? ''), url: String(item.url ?? ''), webSocketDebuggerUrl: String(item.webSocketDebuggerUrl) }))
}
