import { Connection, McpError, type JsonRpcMessage, type SendOptions, type Transport } from './jsonrpc'

/**
 * Test support: two transports wired to each other in memory, and a server
 * that runs on one of them, built from the same Connection the client uses.
 * Messages are copied on the way, as serialisation would copy them. Only the
 * tests import this.
 */

class MemoryTransport implements Transport {
  onmessage?: (message: JsonRpcMessage) => void
  onclose?: (reason?: Error) => void
  onerror?: (error: Error) => void
  peer!: MemoryTransport
  closed = false
  /** What the client-side hooks were told, for tests. */
  version: string | undefined
  readyCalls = 0

  async send(message: JsonRpcMessage, _options?: SendOptions): Promise<void> {
    if (this.closed) throw new Error('closed')
    const copy = structuredClone(message)
    queueMicrotask(() => {
      if (!this.peer.closed) this.peer.onmessage?.(copy)
    })
  }

  setProtocolVersion(version: string): void {
    this.version = version
  }

  ready(): void {
    this.readyCalls++
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.onclose?.()
    if (!this.peer.closed) {
      this.peer.closed = true
      queueMicrotask(() => this.peer.onclose?.())
    }
  }
}

export function linkedTransports(): [client: MemoryTransport, server: MemoryTransport] {
  const a = new MemoryTransport()
  const b = new MemoryTransport()
  a.peer = b
  b.peer = a
  return [a, b]
}

export interface FakeServerOptions {
  protocolVersion?: string
  serverInfo?: unknown
  capabilities?: unknown
  instructions?: unknown
  /** Replaces the answer to `initialize`: return anything, throw `McpError`, or never settle. */
  initialize?: (params: unknown) => Promise<unknown> | unknown
  /** Answers every request but `initialize`. Throw `McpError` to answer with an error. */
  handle?: (method: string, params: unknown, signal: AbortSignal) => Promise<unknown> | unknown
  /** Receives every notification the client sends. */
  onNotification?: (method: string, params: unknown) => void
}

export interface FakeServer {
  /** The transport to give the client. */
  transport: MemoryTransport
  connection: Connection
  /** Every request received, in order. */
  requests: Array<{ method: string; params: unknown }>
  notifications: Array<{ method: string; params: unknown }>
}

export function fakeServer(options: FakeServerOptions = {}): FakeServer {
  const [clientSide, serverSide] = linkedTransports()
  const requests: FakeServer['requests'] = []
  const notifications: FakeServer['notifications'] = []
  const connection = new Connection(serverSide, {
    async request(method, params, signal) {
      requests.push({ method, params })
      if (method === 'initialize') {
        if (options.initialize) return options.initialize(params)
        return {
          protocolVersion: options.protocolVersion ?? '2025-06-18',
          capabilities: options.capabilities ?? { tools: {} },
          serverInfo: options.serverInfo ?? { name: 'fake', version: '1.0.0' },
          ...(options.instructions === undefined ? {} : { instructions: options.instructions }),
        }
      }
      if (!options.handle) throw new McpError(-32601, `Method not found: ${method}`)
      return options.handle(method, params, signal)
    },
    notification(method, params) {
      notifications.push({ method, params })
      options.onNotification?.(method, params)
    },
  })
  return { transport: clientSide, connection, requests, notifications }
}
