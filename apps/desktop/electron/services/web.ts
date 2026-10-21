import dns, { type LookupAddress } from 'node:dns'
import http, { type IncomingMessage } from 'node:http'
import https from 'node:https'
import type { LookupFunction } from 'node:net'
import { pipeline, type Readable, type Transform } from 'node:stream'
import zlib from 'node:zlib'
import { checkFetchUrl, isPublicAddress } from '@encode/permissions'

/**
 * The agent's HTTP client. It connects only to addresses `allowAddress`
 * accepts (public unicast by default), checked on every connection after DNS
 * so a rebinding name cannot point a later request at the local network. It
 * follows redirects only on the same host (a hop to another host is handed
 * back, so it goes through approval as a new fetch), and caps size and time.
 */

export interface FetchOptions {
  signal?: AbortSignal
  /** Cap on the decoded body. Default 2 MB. */
  maxBytes?: number
  /** Cap on the whole fetch, redirects included. Default 30 s. */
  timeoutMs?: number
  /** Same-host redirects to follow. Default 5. */
  maxRedirects?: number
  /** Addresses that may be contacted. Default: public unicast only. Tests widen it. */
  allowAddress?: (address: string) => boolean
  /** DNS resolution; tests inject it. */
  lookup?: typeof dns.lookup
}

export type FetchOutcome =
  | {
      kind: 'response'
      url: string
      status: number
      contentType: string
      text: string
      truncated: boolean
    }
  /** The response is not text (an image, an archive); its body was not read. */
  | { kind: 'binary'; url: string; status: number; contentType: string }
  /** A redirect to another host, or to http from https: not followed. */
  | { kind: 'redirect'; url: string; status: number; location: string }
  /** Refused before or while connecting: bad URL, private address, too many redirects. */
  | { kind: 'refused'; reason: string }

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_REDIRECTS = 5
const USER_AGENT = 'eNCode/0.1 (+agent web_fetch)'

class BlockedAddressError extends Error {
  constructor(readonly hostname: string, readonly address: string) {
    super(`${hostname} resolves to ${address}, a private or special-purpose network address`)
  }
}

/** A DNS lookup that fails unless every address the name resolves to is allowed. */
export function guardedLookup(allowAddress: (address: string) => boolean, base: typeof dns.lookup = dns.lookup): LookupFunction {
  return (hostname, options, callback) => {
    base(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) {
        callback(error, '', 0)
        return
      }
      const list = addresses as unknown as LookupAddress[]
      const blocked = list.find((entry) => !allowAddress(entry.address))
      if (blocked || !list.length) {
        callback(new BlockedAddressError(hostname, blocked?.address ?? 'nothing'), '', 0)
        return
      }
      if (options.all) callback(null, list)
      else callback(null, list[0].address, list[0].family)
    })
  }
}

function isTextual(contentType: string): boolean {
  const type = contentType.split(';', 1)[0].trim().toLowerCase()
  if (!type) return true
  return (
    type.startsWith('text/') ||
    /^application\/([\w.+-]*\+)?(json|xml)$/.test(type) ||
    /^application\/(javascript|ecmascript|x-javascript|x-sh|x-httpd-php|graphql|toml|yaml|x-yaml|x-ndjson|ld\+json)$/.test(type) ||
    type === 'image/svg+xml'
  )
}

function charsetOf(contentType: string): string {
  const match = /charset\s*=\s*"?([\w.:-]+)"?/i.exec(contentType)
  return match ? match[1].toLowerCase() : 'utf-8'
}

function decode(bytes: Buffer, contentType: string): string {
  try {
    return new TextDecoder(charsetOf(contentType)).decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}

function decompressor(encoding: string): Transform | null {
  switch (encoding.trim().toLowerCase()) {
    case 'gzip':
    case 'x-gzip':
      return zlib.createGunzip()
    case 'deflate':
      return zlib.createInflate()
    case 'br':
      return zlib.createBrotliDecompress()
    default:
      return null
  }
}

/** Reads at most `maxBytes` of the decoded body, then stops the transfer. */
async function readBody(response: IncomingMessage, maxBytes: number): Promise<{ bytes: Buffer; truncated: boolean }> {
  const encoding = String(response.headers['content-encoding'] ?? '')
  const decoder = encoding && encoding.toLowerCase() !== 'identity' ? decompressor(encoding) : null
  if (encoding && encoding.toLowerCase() !== 'identity' && !decoder) {
    response.destroy()
    throw new Error(`unsupported content encoding ${encoding}`)
  }
  // pipeline (unlike pipe) passes a failed or aborted transfer on to the decoder, so reading cannot hang.
  const stream: Readable = decoder ? pipeline(response, decoder, () => {}) : response
  const chunks: Buffer[] = []
  let size = 0
  let truncated = false
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      const room = maxBytes - size
      if (chunk.length >= room) {
        chunks.push(chunk.subarray(0, room))
        size += room
        truncated = chunk.length > room
        if (truncated) break
        continue
      }
      chunks.push(chunk)
      size += chunk.length
    }
  } finally {
    response.destroy()
    decoder?.destroy()
  }
  return { bytes: Buffer.concat(chunks, size), truncated }
}

function request(url: URL, lookup: LookupFunction, signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http
    const outgoing = client.request(url, {
      method: 'GET',
      agent: false,
      lookup,
      signal,
      headers: {
        'user-agent': USER_AGENT,
        accept: 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5',
        'accept-encoding': 'gzip, deflate, br',
      },
    })
    outgoing.on('response', resolve)
    outgoing.on('error', reject)
    outgoing.end()
  })
}

export async function safeFetch(rawUrl: string, options: FetchOptions = {}): Promise<FetchOutcome> {
  const allowAddress = options.allowAddress ?? isPublicAddress
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const lookup = guardedLookup(allowAddress, options.lookup)
  const timeout = AbortSignal.timeout(timeoutMs)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  /** Whatever the socket reported, a cancelled fetch fails as an abort and a slow one as a timeout. */
  const failure = (error: unknown): unknown => {
    if (options.signal?.aborted) return options.signal.reason ?? new DOMException('The fetch was cancelled', 'AbortError')
    if (timeout.aborted) return new Error(`timed out after ${timeoutMs} ms`)
    return error
  }

  const first = checkFetchUrl(rawUrl, allowAddress)
  if (!first.ok) return { kind: 'refused', reason: first.reason }
  let url = first.url

  for (let hop = 0; ; hop++) {
    let response: IncomingMessage
    try {
      response = await request(url, lookup, signal)
    } catch (error) {
      if (error instanceof BlockedAddressError) return { kind: 'refused', reason: error.message }
      throw failure(error)
    }

    const status = response.statusCode ?? 0
    const location = response.headers.location
    if (status >= 300 && status < 400 && location) {
      response.destroy()
      let next: URL
      try {
        next = new URL(location, url)
      } catch {
        return { kind: 'refused', reason: `the server redirected to an invalid address (${location})` }
      }
      const sameHost = next.hostname === url.hostname
      const allowedScheme = next.protocol === url.protocol || (url.protocol === 'http:' && next.protocol === 'https:')
      if (!sameHost || !allowedScheme) return { kind: 'redirect', url: url.href, status, location: next.href }
      if (hop >= maxRedirects) return { kind: 'refused', reason: `more than ${maxRedirects} redirects` }
      const checked = checkFetchUrl(next.href, allowAddress)
      if (!checked.ok) return { kind: 'refused', reason: checked.reason }
      url = checked.url
      continue
    }

    const contentType = String(response.headers['content-type'] ?? '')
    if (!isTextual(contentType)) {
      response.destroy()
      return { kind: 'binary', url: url.href, status, contentType }
    }
    try {
      const { bytes, truncated } = await readBody(response, maxBytes)
      return { kind: 'response', url: url.href, status, contentType, text: decode(bytes, contentType), truncated }
    } catch (error) {
      throw failure(error)
    }
  }
}
