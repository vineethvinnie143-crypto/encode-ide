/**
 * eNCode's RPC: requests, responses, events and cancellation over any message
 * port: Electron's MessagePortMain, a DOM MessagePort, a utility process's
 * parentPort, or the in-memory pair the CLI and the tests use.
 *
 * The receiving side treats every message as untrusted. Envelopes are shape
 * checked, a method must be registered to be called, and a handler can declare
 * a JSON Schema its params must pass before it runs. Errors cross the wire as
 * a code and a message, never a stack.
 */
import { validationMessage, type JsonSchema } from './schema'

export const PROTOCOL_VERSION = 1

export interface WireError {
  code: string
  message: string
  data?: unknown
}

export type Envelope =
  | { v: 1; t: 'req'; id: number; m: string; p?: unknown }
  | { v: 1; t: 'res'; id: number; r?: unknown; e?: WireError }
  | { v: 1; t: 'evt'; m: string; p?: unknown }
  | { v: 1; t: 'cancel'; id: number }

/** The transport a Peer runs over. Messages must survive structured cloning. */
export interface Port {
  post(message: Envelope): void
  /** Calls `handler` for every message that arrives; returns a function that stops listening. */
  listen(handler: (message: unknown) => void): () => void
  /** Calls `handler` once when the other side goes away. */
  onClose?(handler: () => void): () => void
  close?(): void
}

/** Error codes the protocol itself produces. Handlers may use their own. */
export type RpcErrorCode = 'unknown-method' | 'invalid-params' | 'cancelled' | 'timeout' | 'closed' | 'internal' | (string & {})

export class RpcError extends Error {
  readonly code: RpcErrorCode
  readonly data?: unknown

  constructor(code: RpcErrorCode, message: string, data?: unknown) {
    super(message)
    this.name = 'RpcError'
    this.code = code
    if (data !== undefined) this.data = data
  }
}

export function isRpcError(error: unknown): error is RpcError {
  return error instanceof RpcError
}

/**
 * What one side serves: the requests it answers and the events it emits.
 * Declare APIs as type aliases; interfaces do not satisfy the index signature.
 */
export interface Api {
  requests: Record<string, { params: unknown; result: unknown }>
  events: Record<string, unknown>
}

export type NoApi = { requests: {}; events: {} }

export interface RequestOptions {
  signal?: AbortSignal
  /** Overrides the peer's default timeout; 0 waits forever. */
  timeoutMs?: number
}

export interface RequestContext {
  method: string
  /** Aborts when the caller cancels, times out or the connection closes. */
  signal: AbortSignal
}

export interface HandlerOptions {
  /** Params that fail this schema are refused with `invalid-params` before the handler runs. */
  schema?: JsonSchema
}

export interface PeerOptions {
  /** Default request timeout in ms; 0 (the default) waits forever. */
  timeoutMs?: number
  /** Reports malformed envelopes and listener failures. Default: ignore. */
  onProtocolError?: (error: Error) => void
}

type Requests<A extends Api> = A['requests']
type Method<A extends Api> = keyof Requests<A> & string
type Params<A extends Api, M extends Method<A>> = Requests<A>[M]['params']
type Result<A extends Api, M extends Method<A>> = Requests<A>[M]['result']
type RequestArgs<P> = undefined extends P ? [params?: P, options?: RequestOptions] : [params: P, options?: RequestOptions]
type EventArgs<P> = undefined extends P ? [params?: P] : [params: P]

interface Pending {
  resolve(value: unknown): void
  reject(error: unknown): void
  cleanup(): void
}

interface Registered {
  handler: (params: unknown, context: RequestContext) => unknown
  schema?: JsonSchema
}

const MAX_METHOD_LENGTH = 128
const ENVELOPE_TYPES = new Set(['req', 'res', 'evt', 'cancel'])

function isId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isMethod(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_METHOD_LENGTH
}

/** The envelope, or a description of what is wrong with it. */
function parseEnvelope(message: unknown): Envelope | string {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return 'a message must be an object'
  const value = message as Record<string, unknown>
  if (value.v !== PROTOCOL_VERSION) return `unsupported protocol version ${String(value.v)}`
  if (typeof value.t !== 'string' || !ENVELOPE_TYPES.has(value.t)) return `unknown message type ${String(value.t)}`
  switch (value.t) {
    case 'req':
      if (!isId(value.id)) return 'a request needs a positive integer id'
      if (!isMethod(value.m)) return 'a request needs a method name'
      return value as Envelope
    case 'res': {
      if (!isId(value.id)) return 'a response needs a positive integer id'
      const error = value.e as Record<string, unknown> | undefined
      if (error !== undefined && (!error || typeof error !== 'object' || typeof error.code !== 'string' || typeof error.message !== 'string')) {
        return 'a response error needs a code and a message'
      }
      return value as Envelope
    }
    case 'evt':
      return isMethod(value.m) ? (value as Envelope) : 'an event needs a method name'
    default:
      return isId(value.id) ? (value as Envelope) : 'a cancel needs a positive integer id'
  }
}

/** The error as it crosses the wire: a code and a message, never a stack. */
export function toWireError(error: unknown): WireError {
  if (error instanceof RpcError) return { code: error.code, message: error.message, ...(error.data !== undefined ? { data: error.data } : {}) }
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code
    return { code: typeof code === 'string' && code ? code : 'internal', message: error.message || error.name }
  }
  return { code: 'internal', message: typeof error === 'string' ? error : 'The request failed.' }
}

function fromWireError(error: WireError): RpcError {
  return new RpcError(error.code, error.message, error.data)
}

/**
 * One end of a connection. `Local` is the API this side serves (requests it
 * answers, events it emits); `Remote` is the API the other side serves.
 */
export class Peer<Local extends Api = NoApi, Remote extends Api = NoApi> {
  private readonly pending = new Map<number, Pending>()
  private readonly handlers = new Map<string, Registered>()
  private readonly listeners = new Map<string, Set<(params: unknown) => void>>()
  private readonly running = new Map<number, AbortController>()
  private readonly unsubscribe: (() => void)[] = []
  private nextId = 1
  private closedWith: RpcError | undefined

  constructor(
    private readonly port: Port,
    private readonly options: PeerOptions = {},
  ) {
    this.unsubscribe.push(port.listen((message) => this.receive(message)))
    const stopClose = port.onClose?.(() => this.close('The other side closed the connection.'))
    if (stopClose) this.unsubscribe.push(stopClose)
  }

  get closed(): boolean {
    return this.closedWith !== undefined
  }

  /** Calls a method the other side serves. Rejects with an RpcError, or the signal's reason. */
  request<M extends Method<Remote>>(method: M, ...args: RequestArgs<Params<Remote, M>>): Promise<Result<Remote, M>> {
    const [params, options = {}] = args as [unknown, RequestOptions | undefined]
    if (this.closedWith) return Promise.reject(this.closedWith)
    const { signal } = options
    if (signal?.aborted) return Promise.reject(signal.reason)
    const id = this.nextId++
    const timeoutMs = options.timeoutMs ?? this.options.timeoutMs ?? 0

    return new Promise<Result<Remote, M>>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const cancel = (error: unknown) => {
        entry.cleanup()
        this.send({ v: 1, t: 'cancel', id })
        reject(error)
      }
      const onAbort = () => cancel(signal!.reason)
      const entry: Pending = {
        resolve: (value) => resolve(value as Result<Remote, M>),
        reject,
        cleanup: () => {
          this.pending.delete(id)
          if (timer) clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
        },
      }
      this.pending.set(id, entry)
      signal?.addEventListener('abort', onAbort, { once: true })
      if (timeoutMs > 0) timer = setTimeout(() => cancel(new RpcError('timeout', `${method} did not answer within ${timeoutMs} ms.`)), timeoutMs)
      try {
        this.port.post({ v: 1, t: 'req', id, m: method, ...(params !== undefined ? { p: params } : {}) })
      } catch (error) {
        entry.cleanup()
        reject(new RpcError('internal', `Could not send ${method}: ${error instanceof Error ? error.message : String(error)}`))
      }
    })
  }

  /** Emits an event this side serves. Dropped silently once closed. */
  notify<M extends keyof Local['events'] & string>(method: M, ...args: EventArgs<Local['events'][M]>): void {
    const [params] = args as [unknown]
    this.send({ v: 1, t: 'evt', m: method, ...(params !== undefined ? { p: params } : {}) })
  }

  /** Answers a method. A second registration for the same method replaces the first. */
  handle<M extends Method<Local>>(
    method: M,
    handler: (params: Params<Local, M>, context: RequestContext) => Result<Local, M> | Promise<Result<Local, M>>,
    options: HandlerOptions = {},
  ): () => void {
    const registered: Registered = { handler: handler as Registered['handler'], ...(options.schema ? { schema: options.schema } : {}) }
    this.handlers.set(method, registered)
    return () => {
      if (this.handlers.get(method) === registered) this.handlers.delete(method)
    }
  }

  /** Listens to an event the other side emits. */
  on<M extends keyof Remote['events'] & string>(method: M, listener: (params: Remote['events'][M]) => void): () => void {
    let set = this.listeners.get(method)
    if (!set) this.listeners.set(method, (set = new Set()))
    const entry = listener as (params: unknown) => void
    set.add(entry)
    return () => {
      set.delete(entry)
    }
  }

  /** Rejects pending requests, aborts running handlers and stops listening. */
  close(reason = 'The connection closed.'): void {
    if (this.closedWith) return
    this.closedWith = new RpcError('closed', reason)
    for (const entry of [...this.pending.values()]) {
      entry.cleanup()
      entry.reject(this.closedWith)
    }
    for (const controller of this.running.values()) controller.abort(this.closedWith)
    this.running.clear()
    for (const stop of this.unsubscribe.splice(0)) stop()
    this.port.close?.()
  }

  private send(message: Envelope): boolean {
    if (this.closedWith) return false
    try {
      this.port.post(message)
      return true
    } catch (error) {
      this.options.onProtocolError?.(error instanceof Error ? error : new Error(String(error)))
      return false
    }
  }

  private receive(message: unknown): void {
    if (this.closedWith) return
    const envelope = parseEnvelope(message)
    if (typeof envelope === 'string') {
      this.options.onProtocolError?.(new RpcError('invalid-message', `Ignored a message: ${envelope}.`))
      // A request with a usable id still gets an answer, so the caller does not hang.
      const value = message as { t?: unknown; id?: unknown } | null
      if (value && value.t === 'req' && isId(value.id)) this.respondError(value.id, new RpcError('invalid-message', envelope))
      return
    }
    switch (envelope.t) {
      case 'req':
        void this.serve(envelope)
        return
      case 'res': {
        const entry = this.pending.get(envelope.id)
        if (!entry) return
        entry.cleanup()
        if (envelope.e) entry.reject(fromWireError(envelope.e))
        else entry.resolve(envelope.r)
        return
      }
      case 'evt': {
        const set = this.listeners.get(envelope.m)
        if (!set) return
        for (const listener of [...set]) {
          try {
            listener(envelope.p)
          } catch (error) {
            this.options.onProtocolError?.(error instanceof Error ? error : new Error(String(error)))
          }
        }
        return
      }
      case 'cancel':
        this.running.get(envelope.id)?.abort(new RpcError('cancelled', 'The caller cancelled the request.'))
        return
    }
  }

  private respondError(id: number, error: unknown): void {
    this.send({ v: 1, t: 'res', id, e: toWireError(error) })
  }

  private async serve(request: Extract<Envelope, { t: 'req' }>): Promise<void> {
    const registered = this.handlers.get(request.m)
    if (!registered) {
      this.respondError(request.id, new RpcError('unknown-method', `No method called ${request.m}.`))
      return
    }
    if (this.running.has(request.id)) {
      this.respondError(request.id, new RpcError('invalid-message', `Request ${request.id} is already running.`))
      return
    }
    if (registered.schema) {
      const problem = validationMessage(request.p ?? null, registered.schema)
      if (problem) {
        this.respondError(request.id, new RpcError('invalid-params', `${request.m}: ${problem}`))
        return
      }
    }
    const controller = new AbortController()
    this.running.set(request.id, controller)
    try {
      const result = await registered.handler(request.p, { method: request.m, signal: controller.signal })
      if (controller.signal.aborted) {
        if (!this.closedWith) this.respondError(request.id, controller.signal.reason)
        return
      }
      if (!this.send({ v: 1, t: 'res', id: request.id, ...(result !== undefined ? { r: result } : {}) })) {
        this.respondError(request.id, new RpcError('internal', `${request.m} returned a value that cannot be sent.`))
      }
    } catch (error) {
      this.respondError(request.id, controller.signal.aborted ? controller.signal.reason : error)
    } finally {
      this.running.delete(request.id)
    }
  }
}

/**
 * Two connected in-memory ports. Delivery is asynchronous and every message
 * is structured-cloned, so code that works over a pair works over a real port.
 */
export function createPortPair(): [Port, Port] {
  type Side = { handlers: Set<(message: unknown) => void>; closeHandlers: Set<() => void>; other?: Side; closed: boolean }
  const a: Side = { handlers: new Set(), closeHandlers: new Set(), closed: false }
  const b: Side = { handlers: new Set(), closeHandlers: new Set(), closed: false }
  a.other = b
  b.other = a

  const port = (side: Side): Port => ({
    post(message) {
      if (side.closed) throw new RpcError('closed', 'The port is closed.')
      const copy = structuredClone(message)
      const target = side.other!
      queueMicrotask(() => {
        if (target.closed) return
        for (const handler of [...target.handlers]) handler(copy)
      })
    },
    listen(handler) {
      side.handlers.add(handler)
      return () => side.handlers.delete(handler)
    },
    onClose(handler) {
      side.closeHandlers.add(handler)
      return () => side.closeHandlers.delete(handler)
    },
    close() {
      if (side.closed) return
      side.closed = true
      const target = side.other!
      queueMicrotask(() => {
        if (target.closed) return
        target.closed = true
        for (const handler of [...target.closeHandlers]) handler()
      })
    },
  })

  return [port(a), port(b)]
}
