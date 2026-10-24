/**
 * Model calls of an agent on another machine go out from this PC (ADR 0111). The agent there is given a `fetch` that
 * sends each request here, over its SSH connection, and this side makes it: with the person's network, and with the
 * key put in here, so a key never reaches the other machine.
 *
 * The agent asks for a key as it always does; on a remote it gets a stand-in, a random token bound to the profile (or
 * the search provider) and to the server the key was entered for. This side puts the key in place of the token, in a
 * request header only, and only for a request to that server. A token anywhere else (another server, the URL, the
 * body) is refused. Nothing but the servers the settings name can be reached this way, so the other machine cannot use
 * this PC to reach its own local network. An error the server sends back is read whole, and the key is taken out of
 * it before it goes back, in case the server quotes it.
 */
import { randomBytes } from 'node:crypto'
import { Peer, RpcError, type JsonSchema } from '@encode/protocol'

export interface NetRequest {
  id: number
  url: string
  method: string
  headers: [string, string][]
  body?: string | Uint8Array
}

export interface NetHead {
  status: number
  statusText: string
  headers: [string, string][]
}

/** What this PC serves the agent on the other machine. */
export type NetMainApi = {
  requests: { open: { params: NetRequest; result: NetHead } }
  events: { chunk: { id: number; data: Uint8Array }; end: { id: number; error?: string } }
}

/** What the agent's side sends: a request it no longer wants. */
export type NetHostApi = {
  requests: {}
  events: { abort: { id: number } }
}

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']
const MAX_BODY_BYTES = 64 * 1024 * 1024
const MAX_ERROR_BODY_BYTES = 1024 * 1024
const MAX_OPEN = 32
const NULL_BODY = new Set([101, 103, 204, 205, 304])

const OPEN_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['id', 'url', 'method', 'headers'],
  additionalProperties: false,
  properties: {
    id: { type: 'integer', minimum: 1 },
    url: { type: 'string', minLength: 1, maxLength: 16_384 },
    method: { type: 'string', enum: METHODS },
    headers: { type: 'array', maxItems: 100, items: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'string', maxLength: 65_536 } } },
    body: {},
  },
}

// ---------------------------------------------------------------------------------------------------------------
// The agent's side

/** The `fetch` the agent on the other machine uses for model and search calls: each goes to this PC and back. */
export function tunnelFetch(peer: Peer<NetHostApi, NetMainApi>): (input: string, init?: RequestInit) => Promise<Response> {
  let nextId = 1
  const streams = new Map<number, ReadableStreamDefaultController<Uint8Array>>()
  peer.on('chunk', ({ id, data }) => {
    try {
      streams.get(id)?.enqueue(data instanceof Uint8Array ? data : new Uint8Array(0))
    } catch {
      /* the reader went away */
    }
  })
  peer.on('end', ({ id, error }) => {
    const controller = streams.get(id)
    streams.delete(id)
    try {
      if (error) controller?.error(new TypeError(error))
      else controller?.close()
    } catch {
      /* already closed */
    }
  })

  return async (input, init = {}) => {
    const id = nextId++
    const signal = init.signal ?? undefined
    if (signal?.aborted) throw signal.reason
    const body = init.body
    let sent: string | Uint8Array | undefined
    if (body === undefined || body === null) sent = undefined
    else if (typeof body === 'string') sent = body
    else if (body instanceof Uint8Array) sent = body
    else if (body instanceof ArrayBuffer) sent = new Uint8Array(body)
    else throw new TypeError('A request through the SSH connection takes its body as text or bytes.')

    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        streams.set(id, controller)
      },
      cancel: () => {
        streams.delete(id)
        peer.notify('abort', { id })
      },
    })
    const onAbort = () => {
      const controller = streams.get(id)
      streams.delete(id)
      peer.notify('abort', { id })
      try {
        controller?.error(signal?.reason ?? new DOMException('The request was aborted.', 'AbortError'))
      } catch {
        /* already closed */
      }
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const head = await peer.request(
        'open',
        { id, url: String(input), method: (init.method ?? 'GET').toUpperCase(), headers: [...new Headers(init.headers).entries()], ...(sent !== undefined ? { body: sent } : {}) },
        signal ? { signal } : {},
      )
      if (NULL_BODY.has(head.status)) {
        streams.delete(id)
        return new Response(null, { status: head.status, statusText: head.statusText, headers: head.headers })
      }
      return new Response(stream, { status: head.status, statusText: head.statusText, headers: head.headers })
    } catch (error) {
      signal?.removeEventListener('abort', onAbort)
      streams.delete(id)
      if (signal?.aborted) throw signal.reason
      throw new TypeError(error instanceof Error ? error.message : 'The request through the SSH connection failed.')
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// This PC's side

/** What a stand-in token stands for. */
export type KeyBinding = { kind: 'model'; profileId: string } | { kind: 'search'; provider: string }

export interface TunnelOptions {
  /** The network. Default: the global fetch. */
  fetch?: (input: string, init: RequestInit) => Promise<Response>
  /** Servers the agent may reach this way: the origins of the model profiles and the search providers. */
  allowed(origin: string): boolean
  /** The key a token stands for, when the request goes to the server it was entered for; otherwise empty. */
  keyFor(binding: KeyBinding, url: string): string | Promise<string>
}

/** Mints the stand-in tokens of one connection and remembers what each stands for. */
export class KeyTokens {
  private readonly tokens = new Map<string, KeyBinding>()
  private readonly byBinding = new Map<string, string>()

  /** The token for a profile's or a provider's key; the same one for the life of the connection. */
  token(binding: KeyBinding): string {
    const name = binding.kind === 'model' ? `model:${binding.profileId}` : `search:${binding.provider}`
    let token = this.byBinding.get(name)
    if (!token) {
      token = `encode-remote-key-${randomBytes(24).toString('hex')}`
      this.byBinding.set(name, token)
      this.tokens.set(token, binding)
    }
    return token
  }

  /** The tokens found in a text, with what each stands for. */
  find(text: string): Array<[string, KeyBinding]> {
    if (!text.includes('encode-remote-key-')) return []
    return [...this.tokens].filter(([token]) => text.includes(token))
  }

  /** Whether a text holds any token at all, known or not. */
  static mentions(text: string): boolean {
    return text.includes('encode-remote-key-')
  }
}

function originOf(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.origin : null
  } catch {
    return null
  }
}

function bodyText(body: string | Uint8Array | undefined): string {
  if (body === undefined) return ''
  return typeof body === 'string' ? body : Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('latin1')
}

/** Serves `open` on the connection's net channel: one request at a time per id, at most 32 at once. */
export function serveTunnel(peer: Peer<NetMainApi, NetHostApi>, tokens: KeyTokens, options: TunnelOptions): () => void {
  const fetchImpl = options.fetch ?? ((input: string, init: RequestInit) => fetch(input, init))
  const open = new Map<number, AbortController>()
  const stopAbort = peer.on('abort', ({ id }) => {
    open.get(id)?.abort(new RpcError('cancelled', 'The agent no longer wants this request.'))
    open.delete(id)
  })

  const stopOpen = peer.handle(
    'open',
    async (request, context) => {
      if (open.has(request.id)) throw new RpcError('invalid-params', `Request ${request.id} is already open.`)
      if (open.size >= MAX_OPEN) throw new RpcError('busy', 'Too many requests are open through the SSH connection.')
      const origin = originOf(request.url)
      if (!origin || !options.allowed(origin)) throw new RpcError('refused', `eNCode does not reach ${origin ?? 'that address'} for the other machine: only the model and search servers in the settings.`)
      if (KeyTokens.mentions(request.url) || KeyTokens.mentions(bodyText(request.body))) throw new RpcError('refused', 'A key may only go in a request header.')
      const body = request.body
      if (body !== undefined && typeof body !== 'string' && !(body instanceof Uint8Array)) throw new RpcError('invalid-params', 'A body is text or bytes.')
      if (body !== undefined && (typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength) > MAX_BODY_BYTES) throw new RpcError('invalid-params', 'That request is too large.')

      // The key goes in place of its token, in a header, for the server it was entered for; nowhere else.
      const keys: string[] = []
      const headers: [string, string][] = []
      for (const [name, value] of request.headers) {
        let out = value
        for (const [token, binding] of tokens.find(value)) {
          const key = await options.keyFor(binding, request.url)
          if (!key) throw new RpcError('refused', 'That key is not for this server.')
          keys.push(key)
          out = out.split(token).join(key)
        }
        if (KeyTokens.mentions(out)) throw new RpcError('refused', 'That key is not known on this PC.')
        headers.push([name, out])
      }

      const controller = new AbortController()
      open.set(request.id, controller)
      const stopCaller = () => controller.abort(context.signal.reason)
      context.signal.addEventListener('abort', stopCaller, { once: true })
      const scrub = (text: string) => keys.reduce((out, key) => out.split(key).join('[the key]'), text)
      let response: Response
      try {
        response = await fetchImpl(request.url, {
          method: request.method,
          headers,
          ...(body !== undefined ? { body: typeof body === 'string' ? body : Buffer.from(body.buffer, body.byteOffset, body.byteLength) } : {}),
          signal: controller.signal,
          redirect: 'manual',
        })
      } catch (error) {
        open.delete(request.id)
        throw new RpcError('network', scrub(error instanceof Error ? error.message : String(error)))
      } finally {
        context.signal.removeEventListener('abort', stopCaller)
      }
      const head: NetHead = { status: response.status, statusText: scrub(response.statusText), headers: [...response.headers.entries()].map(([name, value]) => [name, scrub(value)]) }

      const finish = (error?: string) => {
        if (!open.has(request.id)) return
        open.delete(request.id)
        peer.notify('end', { id: request.id, ...(error ? { error } : {}) })
      }
      void (async () => {
        try {
          if (!response.body || NULL_BODY.has(response.status)) return finish()
          if (response.status >= 400 && keys.length) {
            // Read whole and scrubbed: a server may quote the key it refused.
            const text = scrub(new TextDecoder().decode((await response.arrayBuffer()).slice(0, MAX_ERROR_BODY_BYTES)))
            if (!controller.signal.aborted) peer.notify('chunk', { id: request.id, data: new TextEncoder().encode(text) })
            return finish()
          }
          const reader = response.body.getReader()
          for (;;) {
            const { done, value } = await reader.read()
            if (done || controller.signal.aborted) break
            peer.notify('chunk', { id: request.id, data: value })
          }
          finish()
        } catch (error) {
          finish(controller.signal.aborted ? 'The request was stopped.' : scrub(error instanceof Error ? error.message : 'The answer was cut off.'))
        }
      })()
      return head
    },
    { schema: OPEN_SCHEMA },
  )

  return () => {
    stopOpen()
    stopAbort()
    for (const controller of open.values()) controller.abort()
    open.clear()
  }
}
