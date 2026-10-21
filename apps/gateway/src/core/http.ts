import { GatewayError } from './errors'

/** Headers every gateway response carries. Nothing it returns may be cached or sniffed. */
export const BASE_HEADERS: Readonly<Record<string, string>> = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...BASE_HEADERS, 'content-type': 'application/json; charset=utf-8', ...headers },
  })
}

/**
 * Reads a JSON request body of at most `maxBytes`. The limit is enforced on
 * the bytes actually received, not on Content-Length, which a client can
 * misstate. Only application/json is accepted, so a browser cannot post here
 * without a preflight, which the gateway never answers.
 */
export async function readJson(request: Request, maxBytes: number): Promise<{ value: unknown; bytes: number }> {
  const type = request.headers.get('content-type') ?? ''
  if (!/^application\/json\s*(;|$)/i.test(type)) {
    throw new GatewayError('unsupported_media_type', 'Send the request body as application/json.')
  }
  const declared = Number(request.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge(maxBytes)
  if (!request.body) throw new GatewayError('invalid_request', 'The request has no body.')

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.byteLength
    if (bytes > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw tooLarge(maxBytes)
    }
    chunks.push(value)
  }
  const joined = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(joined)
  } catch {
    throw new GatewayError('invalid_request', 'The request body is not valid UTF-8.')
  }
  try {
    return { value: JSON.parse(text), bytes }
  } catch {
    throw new GatewayError('invalid_request', 'The request body is not valid JSON.')
  }
}

function tooLarge(maxBytes: number): GatewayError {
  return new GatewayError('request_too_large', `The request body is larger than ${Math.floor(maxBytes / 1024)} KiB.`)
}

export function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization')
  const match = header ? /^Bearer ([\x21-\x7e]{1,2048})$/.exec(header.trim()) : null
  return match ? match[1] : null
}

/**
 * The client's address as Cloudflare reports it. An IPv6 client usually owns
 * a whole /64, so it is limited by its /64 prefix rather than per address.
 */
export function clientAddress(request: Request): string {
  const raw = request.headers.get('cf-connecting-ip')?.trim() ?? ''
  if (!raw) return 'unknown'
  if (!raw.includes(':')) return raw
  const halves = raw.toLowerCase().split('::')
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length > 1 && halves[1] ? halves[1].split(':') : []
  const groups = halves.length > 1 ? [...head, ...new Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail] : head
  return `${groups.slice(0, 4).map((group) => group.replace(/^0+(?=.)/, '')).join(':')}::/64`
}
